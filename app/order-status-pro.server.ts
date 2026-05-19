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

type OspOrdersListItem = {
  id?: number | string;
  status?: { code?: string; name?: string };
};

type OspOrdersListResponse = {
  data?: OspOrdersListItem[];
  meta?: { last_page?: number };
};

function toStatusChoices(statuses: StatusOption[]): StatusChoice[] {
  return statuses
    .filter((status) => status.name && status.code)
    .map((status) => ({
      label: status.name!,
      value: status.code!,
    }));
}

function parseStatusObject(status: unknown): OspOrderStatus | null {
  if (!status || typeof status !== "object") return null;
  const record = status as { code?: unknown; name?: unknown };
  const code = typeof record.code === "string" ? record.code : undefined;
  const name = typeof record.name === "string" ? record.name : undefined;
  if (!code && !name) return null;
  return { code, name };
}

function parseListOrderStatus(item: OspOrdersListItem): OspOrderStatus | null {
  return parseStatusObject(item.status);
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

/** All configured statuses — same options for every Record Planet order. */
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

export function formatOrderStatus(
  status: OspOrderStatus | null | undefined,
): { name?: string } | string {
  if (!status?.name && !status?.code) return "Unknown";
  if (status.name) return { name: status.name };
  return status.code!;
}

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

  const orderId =
    parseOrderId(record.order_id) ??
    parseOrderId(record.orderId) ??
    parseOrderId(nestedOrder?.id) ??
    parseOrderId(record.id);

  if (orderId == null) return null;

  const status =
    parseStatusObject(record.status) ??
    parseStatusObject(nestedOrder?.status) ??
    parseStatusObject(record.new_status) ??
    parseStatusObject(record.newStatus);

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

/** Backfill cache for orders missing ospStatusSyncedAt (e.g. before webhooks existed). */
export async function backfillMissingOrderStatuses(
  orderIds: bigint[],
): Promise<void> {
  const missing = orderIds.filter(Boolean);
  if (missing.length === 0) return;

  const statuses = await fetchOrderStatusesByIds(missing);
  for (const [id, status] of statuses) {
    await applyOrderStatusCache(BigInt(id), status);
  }
}

/**
 * Paginated GET /orders — used only to backfill missing cache entries.
 */
export async function fetchOrderStatusesByIds(
  orderIds: bigint[],
): Promise<Map<string, OspOrderStatus>> {
  if (orderIds.length === 0) return new Map();

  const needed = new Set(orderIds.map((id) => id.toString()));
  const found = new Map<string, OspOrderStatus>();

  let page = 1;
  let lastPage = 1;

  while (page <= lastPage && found.size < needed.size) {
    const response = await fetchOrderStatusPro(
      `/orders?page_size=100&page=${page}`,
    );
    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `OrderStatusPro orders list error: ${response.status} - ${errorText}`,
      );
      break;
    }

    const body = (await response.json()) as OspOrdersListResponse;
    const rows = Array.isArray(body.data) ? body.data : [];

    for (const row of rows) {
      if (row.id == null) continue;
      const id = String(row.id);
      if (!needed.has(id)) continue;
      const status = parseListOrderStatus(row);
      if (status) found.set(id, status);
    }

    lastPage =
      typeof body.meta?.last_page === "number" && body.meta.last_page > 0
        ? body.meta.last_page
        : 1;
    page += 1;
  }

  return found;
}

export async function bulkUpdateOrderStatus(
  orderIds: bigint[],
  statusCode: string,
  statusName?: string,
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

  const cached: OspOrderStatus = {
    code: statusCode,
    name: statusName ?? statusCode,
  };
  await Promise.all(
    orderIds.map((orderId) => applyOrderStatusCache(orderId, cached)),
  );
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}
