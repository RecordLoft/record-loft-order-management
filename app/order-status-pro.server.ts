import { timingSafeEqual } from "node:crypto";
import prisma from "./db.server";

const OSP_BASE = "https://app.orderstatuspro.com/api/v1";

/** Order Status Pro allows ~50 requests per 10s per API key. */
const REQUESTS_PER_WINDOW = 45;
const WINDOW_MS = 10_000;

const requestTimestamps: number[] = [];

function getApiKey(): string {
  const apiKey = process.env.ORDER_STATUS_PRO_API_KEY;
  if (!apiKey) {
    throw new Error("ORDER_STATUS_PRO_API_KEY is not configured");
  }
  return apiKey;
}

async function waitForRateLimitSlot(): Promise<void> {
  const now = Date.now();
  while (
    requestTimestamps.length > 0 &&
    now - requestTimestamps[0]! >= WINDOW_MS
  ) {
    requestTimestamps.shift();
  }

  if (requestTimestamps.length >= REQUESTS_PER_WINDOW) {
    const waitMs = WINDOW_MS - (now - requestTimestamps[0]!) + 50;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return waitForRateLimitSlot();
  }

  requestTimestamps.push(Date.now());
}

export type OspOrderStatus = {
  code?: string;
  name?: string;
};

export type StatusChoice = { label: string; value: string };

type StatusOption = { name?: string; code?: string };

function toStatusChoices(statuses: StatusOption[]): StatusChoice[] {
  return statuses
    .filter((status) => status.name && status.code)
    .map((status) => ({
      label: status.name!,
      value: status.code!,
    }));
}

/** StatusPro custom status objects include `code` (e.g. st0005RI) and often `is_set`. */
function isOspStatusObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.is_set === true) return true;
  if (typeof record.code === "string" && /^st[a-zA-Z0-9]+$/i.test(record.code)) {
    return true;
  }
  return false;
}

function parseStatusObject(status: unknown): OspOrderStatus | null {
  if (!isOspStatusObject(status)) return null;
  const record = status;
  const code =
    typeof record.code === "string" ? record.code : undefined;
  const name =
    (typeof record.name === "string" ? record.name : undefined) ??
    (typeof record.public_name === "string" ? record.public_name : undefined);
  if (!code && !name) return null;
  return { code, name };
}

function firstParsedStatus(...candidates: unknown[]): OspOrderStatus | null {
  for (const candidate of candidates) {
    const parsed = parseStatusObject(candidate);
    if (parsed) return parsed;
  }
  return null;
}

function parseStatusChangeBlock(value: unknown): OspOrderStatus | null {
  if (!value || typeof value !== "object") return null;
  const block = value as Record<string, unknown>;

  // StatusPro webhook: { status: { previous_status: "…", new_status: "…" } }
  const newLabel =
    block.new_status ??
    block.newStatus ??
    block.new ??
    block.to ??
    block.after ??
    block.current;
  if (typeof newLabel === "string" && newLabel.trim()) {
    return { name: newLabel.trim() };
  }

  return firstParsedStatus(
    block.to,
    block.new,
    block.current,
    block.new_status,
    block.newStatus,
    block.after,
  );
}

function parseStatusFromOrder(order: Record<string, unknown>): OspOrderStatus | null {
  return firstParsedStatus(
    order.status,
    order.new_status,
    order.newStatus,
    order.to_status,
    order.current_status,
    order.order_status,
  );
}

function parseOrderId(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && value.trim()) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  return null;
}

/** GET /statuses — same options for every Record Planet order. */
export async function fetchStatusChoices(): Promise<StatusChoice[]> {
  const response = await fetchOrderStatusPro("/statuses");
  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      `OrderStatusPro statuses error: ${response.status} - ${errorText}`,
    );
    throw new Error("Failed to fetch statuses from Order Status Pro");
  }
  const data = await response.json();
  const statuses: StatusOption[] = Array.isArray(data) ? data : [];
  return toStatusChoices(statuses);
}

export function orderStatusFromRow(order: {
  ospStatusCode: string | null;
  ospStatusName: string | null;
}): { name?: string } | string {
  if (order.ospStatusName) {
    return { name: order.ospStatusName };
  }
  if (order.ospStatusCode) {
    return order.ospStatusCode;
  }
  return "Unknown";
}

/** Webhook-only cache writes. */
export async function applyOrderStatusCache(
  orderId: bigint,
  status: OspOrderStatus,
): Promise<boolean> {
  const result = await prisma.order.updateMany({
    where: { id: orderId },
    data: {
      ospStatusCode: status.code ?? null,
      ospStatusName: status.name ?? status.code ?? null,
      ospStatusSyncedAt: new Date(),
    },
  });
  return result.count > 0;
}

export function parseOspWebhookPayload(
  body: unknown,
): { orderId: bigint; status: OspOrderStatus } | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;

  const nestedOrder =
    record.order && typeof record.order === "object"
      ? (record.order as Record<string, unknown>)
      : null;

  const nestedData =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : null;

  const orderId =
    parseOrderId(record.order_id) ??
    parseOrderId(record.orderId) ??
    parseOrderId(nestedOrder?.id) ??
    parseOrderId(nestedData?.order_id) ??
    parseOrderId(nestedData?.id);

  if (orderId == null) return null;

  const status =
    parseStatusChangeBlock(record.status) ??
    parseStatusChangeBlock(record.status_change) ??
    parseStatusFromOrder(nestedOrder ?? {}) ??
    firstParsedStatus(nestedData?.status, nestedData?.new_status);

  if (!status) return null;

  return { orderId, status };
}

const WEBHOOK_LOG_CHUNK_SIZE = 400;

/** Log full webhook body in parts (Netlify truncates single long lines). */
export function logOspWebhookPayloadInChunks(rawBody: string): void {
  const total = Math.max(1, Math.ceil(rawBody.length / WEBHOOK_LOG_CHUNK_SIZE));
  console.log(
    `[osp-webhook] payload length=${rawBody.length} parts=${total}`,
  );
  for (let i = 0; i < total; i++) {
    const start = i * WEBHOOK_LOG_CHUNK_SIZE;
    console.log(
      `[osp-webhook] ${i + 1}/${total}:`,
      rawBody.slice(start, start + WEBHOOK_LOG_CHUNK_SIZE),
    );
  }
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * StatusPro does not expose a signing secret — use a random token in the webhook URL path.
 * Set ORDER_STATUS_PRO_WEBHOOK_TOKEN in env and register:
 *   https://<host>/api/webhooks/order-status-pro/<token>
 */
export function verifyOspWebhookToken(urlToken: string | undefined): boolean {
  const expected = process.env.ORDER_STATUS_PRO_WEBHOOK_TOKEN?.trim();
  if (!expected) {
    console.error(
      "[osp-webhook] ORDER_STATUS_PRO_WEBHOOK_TOKEN is not configured",
    );
    return false;
  }
  if (!urlToken?.trim()) return false;
  return safeEqual(urlToken.trim(), expected);
}

export async function fetchOrderStatusPro(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  await waitForRateLimitSlot();

  return fetch(`${OSP_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

export async function bulkUpdateOrderStatus(
  orderIds: bigint[],
  statusCode: string,
): Promise<void> {
  const response = await fetchOrderStatusPro("/orders/bulk-status", {
    method: "POST",
    body: JSON.stringify({
      order_ids: orderIds.map((id) => Number(id)),
      status_code: statusCode,
    }),
  });

  if (!response.ok) {
    let message = "Bulk update failed";
    try {
      const errorData = await response.json();
      if (typeof errorData?.message === "string") {
        message = errorData.message;
      }
    } catch {
      // ignore parse errors
    }

    if (response.status === 429 || /too many attempts/i.test(message)) {
      throw new RateLimitError(message);
    }
    throw new Error(message);
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}
