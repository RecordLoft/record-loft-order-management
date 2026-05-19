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

function parseStatusObject(status: unknown): OspOrderStatus | null {
  if (typeof status === "string" && status.trim()) {
    return { code: status.trim() };
  }
  if (!status || typeof status !== "object") return null;
  const record = status as {
    code?: unknown;
    name?: unknown;
    public_name?: unknown;
    status_code?: unknown;
    status_name?: unknown;
  };
  const code =
    (typeof record.code === "string" ? record.code : undefined) ??
    (typeof record.status_code === "string" ? record.status_code : undefined);
  const name =
    (typeof record.name === "string" ? record.name : undefined) ??
    (typeof record.public_name === "string" ? record.public_name : undefined) ??
    (typeof record.status_name === "string" ? record.status_name : undefined);
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

function parseFlatStatusFields(
  record: Record<string, unknown>,
): OspOrderStatus | null {
  const code = record.status_code ?? record.statusCode;
  const name =
    record.status_name ?? record.statusName ?? record.public_name;
  const parsedCode = typeof code === "string" ? code : undefined;
  const parsedName = typeof name === "string" ? name : undefined;
  if (!parsedCode && !parsedName) return null;
  return { code: parsedCode, name: parsedName };
}

function parseStatusChangeBlock(value: unknown): OspOrderStatus | null {
  if (!value || typeof value !== "object") return null;
  const block = value as Record<string, unknown>;
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
  const direct = firstParsedStatus(
    order.status,
    order.new_status,
    order.newStatus,
    order.to_status,
    order.current_status,
    order.order_status,
  );
  if (direct) return direct;

  const flat = parseFlatStatusFields(order);
  if (flat) return flat;

  for (const [key, value] of Object.entries(order)) {
    if (!/status/i.test(key)) continue;
    const parsed = parseStatusObject(value) ?? parseFlatStatusFields(
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {},
    );
    if (parsed) return parsed;
  }

  return null;
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
    parseStatusFromOrder(nestedOrder ?? {}) ??
    firstParsedStatus(
      record.status,
      record.new_status,
      record.newStatus,
      record.to_status,
      record.toStatus,
      record.current_status,
      record.order_status,
      record.after,
      parseStatusChangeBlock(record.status_change),
      nestedData?.status,
      nestedData?.new_status,
    ) ??
    parseFlatStatusFields(record);

  if (!status) return null;

  return { orderId, status };
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
const WEBHOOK_DEBUG_CHUNK_SIZE = 400;

/** Netlify truncates long log lines; split payload when ORDER_STATUS_PRO_WEBHOOK_DEBUG=true. */
export function logOspWebhookPayloadDebug(rawBody: string): void {
  if (process.env.ORDER_STATUS_PRO_WEBHOOK_DEBUG !== "true") return;

  const total = Math.max(1, Math.ceil(rawBody.length / WEBHOOK_DEBUG_CHUNK_SIZE));
  console.log(
    `[osp-webhook:debug] payload length=${rawBody.length} parts=${total}`,
  );
  for (let i = 0; i < total; i++) {
    const start = i * WEBHOOK_DEBUG_CHUNK_SIZE;
    console.log(
      `[osp-webhook:debug] ${i + 1}/${total}:`,
      rawBody.slice(start, start + WEBHOOK_DEBUG_CHUNK_SIZE),
    );
  }
}

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
