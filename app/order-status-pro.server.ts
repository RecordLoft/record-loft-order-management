import { timingSafeEqual } from "node:crypto";
import prisma from "./db.server";
import { upsertOrderImportPending } from "./order-import-pending.server";

const OSP_BASE = "https://app.orderstatuspro.com/api/v1";

/**
 * Per https://orderstatuspro.com/api/openapi.json
 * - Most endpoints (incl. viable-statuses, single status update): 60/min
 * - POST /orders/bulk-status: 5/min (max 50 order_ids per request)
 */

/** Below this count: POST /orders/{id}/status per order; at or above: /orders/bulk-status. */
export const BULK_STATUS_ORDER_THRESHOLD = 5;

type RateLimitBucket = "standard" | "bulk";

const RATE_LIMITS: Record<
  RateLimitBucket,
  { label: string; max: number; windowMs: number }
> = {
  standard: { label: "60/min", max: 55, windowMs: 60_000 },
  bulk: { label: "5/min", max: 4, windowMs: 60_000 },
};

const requestTimestampsByBucket: Record<RateLimitBucket, number[]> = {
  standard: [],
  bulk: [],
};

export function resetRateLimitStateForTests() {
  requestTimestampsByBucket.standard.length = 0;
  requestTimestampsByBucket.bulk.length = 0;
}

const LOG_PREFIX = "[statuspro-api]";

function rateLimitBucket(path: string, method: string): RateLimitBucket {
  if (method === "POST" && path === "/orders/bulk-status") {
    return "bulk";
  }
  return "standard";
}

function pruneRequestWindow(bucket: RateLimitBucket, now = Date.now()): void {
  const { windowMs } = RATE_LIMITS[bucket];
  const timestamps = requestTimestampsByBucket[bucket];
  while (timestamps.length > 0 && now - timestamps[0]! >= windowMs) {
    timestamps.shift();
  }
}

function getWindowRequestCount(bucket: RateLimitBucket): number {
  pruneRequestWindow(bucket);
  return requestTimestampsByBucket[bucket].length;
}

function getApiKey(): string {
  const apiKey = process.env.ORDER_STATUS_PRO_API_KEY;
  if (!apiKey) {
    throw new Error("ORDER_STATUS_PRO_API_KEY is not configured");
  }
  return apiKey;
}

/** Claim a client-side slot or throw immediately — do not sleep in Netlify. */
function claimRateLimitSlot(bucket: RateLimitBucket): void {
  const { max, label } = RATE_LIMITS[bucket];
  pruneRequestWindow(bucket);

  if (requestTimestampsByBucket[bucket].length >= max) {
    console.warn(
      `${LOG_PREFIX} client throttle (${label}): ${requestTimestampsByBucket[bucket].length}/${max}`,
    );
    throw new RateLimitError(
      `Order Status Pro ${label} rate limit reached. Wait a moment and try again.`,
    );
  }

  requestTimestampsByBucket[bucket].push(Date.now());
}

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

function parseWebhookStatusName(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const block = value as Record<string, unknown>;
  const newLabel = block.new_status ?? block.newStatus;
  if (typeof newLabel !== "string" || !newLabel.trim()) return null;
  return newLabel.trim();
}

/**
 * GET /orders/{id}/viable-statuses — statuses allowed for this order's tags
 * (Record Planet Shipping on Record Planet orders).
 */
export async function fetchViableStatusChoices(
  orderId: bigint,
): Promise<StatusChoice[]> {
  console.log(`${LOG_PREFIX} fetchViableStatusChoices orderId=${orderId}`);
  const response = await fetchOrderStatusPro(
    `/orders/${orderId}/viable-statuses`,
  );
  if (!response.ok) {
    const errorText = await response.text();
    console.error(
      `OrderStatusPro viable-statuses error: ${response.status} - ${errorText}`,
    );
    throw new Error("Failed to fetch viable statuses from Order Status Pro");
  }
  const data = await response.json();
  const statuses: StatusOption[] = Array.isArray(data) ? data : [];
  return toStatusChoices(statuses);
}

export function parseOrderIdParam(value: string | null): bigint | null {
  if (!value?.trim()) return null;
  const segment = value.trim().split("/").pop() || value.trim();
  return parseOrderId(segment);
}

export function orderStatusFromRow(order: {
  ospStatusName: string | null;
}): { name?: string } | string {
  if (order.ospStatusName) {
    return { name: order.ospStatusName };
  }
  return "Unknown";
}

export function parseOrderIdsParam(value: string | null): bigint[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((part) => parseOrderIdParam(part.trim()))
    .filter((id): id is bigint => id !== null);
}

export async function ordersSyncedSince(
  orderIds: bigint[],
  since: Date,
): Promise<boolean> {
  if (orderIds.length === 0 || Number.isNaN(since.getTime())) return false;
  const rows = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { ospStatusSyncedAt: true },
  });
  if (rows.length !== orderIds.length) return false;
  // Small slack for clock skew between app and database.
  const sinceMs = since.getTime() - 1_000;
  return rows.every(
    (row) =>
      row.ospStatusSyncedAt != null &&
      row.ospStatusSyncedAt.getTime() >= sinceMs,
  );
}

export async function ordersMatchCachedStatus(
  orderIds: bigint[],
  expectedStatusName: string,
): Promise<boolean> {
  if (orderIds.length === 0) return false;
  const expected = expectedStatusName.trim().toLowerCase();
  const rows = await prisma.order.findMany({
    where: { id: { in: orderIds } },
    select: { ospStatusName: true },
  });
  return (
    rows.length === orderIds.length &&
    rows.every(
      (row) => row.ospStatusName?.trim().toLowerCase() === expected,
    )
  );
}

/** Cache display name from StatusPro webhook. */
export async function applyOrderStatusCache(
  orderId: bigint,
  statusName: string,
): Promise<boolean> {
  const syncedAt = new Date();
  const result = await prisma.order.updateMany({
    where: { id: orderId },
    data: {
      ospStatusName: statusName,
      ospStatusSyncedAt: syncedAt,
    },
  });
  if (result.count > 0) return true;

  await upsertOrderImportPending(orderId, {
    ospStatusName: statusName,
    ospStatusSyncedAt: syncedAt,
  });
  return false;
}

export function parseOspWebhookPayload(
  body: unknown,
): { orderId: bigint; statusName: string } | null {
  if (!body || typeof body !== "object") return null;
  const record = body as Record<string, unknown>;

  const nestedOrder =
    record.order && typeof record.order === "object"
      ? (record.order as Record<string, unknown>)
      : null;

  const orderId =
    parseOrderId(record.order_id) ??
    parseOrderId(record.orderId) ??
    parseOrderId(nestedOrder?.id);

  if (orderId == null) return null;

  const statusName = parseWebhookStatusName(record.status);
  if (!statusName) return null;

  return { orderId, statusName };
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

async function throwIfOrderStatusProError(
  response: Response,
  fallbackMessage: string,
): Promise<void> {
  if (response.ok) return;

  let message = fallbackMessage;
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

function logOrderStatusProResponse(
  method: string,
  path: string,
  response: Response,
  elapsedMs: number,
  extra?: string,
): void {
  const line = `${LOG_PREFIX} response ${method} ${path} -> ${response.status} ${elapsedMs}ms${extra ?? ""}`;
  if (response.status === 429) {
    console.warn(`${line} (rate limited by Order Status Pro)`);
  } else if (!response.ok) {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export async function fetchOrderStatusPro(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const bucket = rateLimitBucket(path, method);
  const { max, label } = RATE_LIMITS[bucket];
  claimRateLimitSlot(bucket);
  const windowCount = getWindowRequestCount(bucket);

  console.log(
    `${LOG_PREFIX} request ${method} ${path} ${label} window=${windowCount}/${max}`,
  );

  const requestInit: RequestInit = {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  };

  const startedAt = Date.now();
  const response = await fetch(`${OSP_BASE}${path}`, requestInit);
  const elapsedMs = Date.now() - startedAt;
  logOrderStatusProResponse(method, path, response, elapsedMs);

  if (response.status === 429) {
    throw new RateLimitError("Order Status Pro rate limit reached. Wait a moment and try again.");
  }

  return response;
}

async function updateOrderStatusPerOrder(
  orderIds: bigint[],
  statusCode: string,
): Promise<void> {
  for (let i = 0; i < orderIds.length; i++) {
    const orderId = orderIds[i]!;
    const response = await fetchOrderStatusPro(`/orders/${orderId}/status`, {
      method: "POST",
      body: JSON.stringify({ status_code: statusCode }),
    });
    await throwIfOrderStatusProError(
      response,
      `Status update failed for order ${orderId}`,
    );
  }
}

async function updateOrderStatusBulk(
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
  await throwIfOrderStatusProError(response, "Bulk update failed");
}

/**
 * Update status for one or more orders.
 * Fewer than 5: per-order API (60/min). 5+: bulk queue (5/min).
 * Fail-fast on client or OSP rate limits (no sleeping in Netlify).
 */
export async function bulkUpdateOrderStatus(
  orderIds: bigint[],
  statusCode: string,
): Promise<void> {
  if (orderIds.length === 0) return;

  const useBulk = orderIds.length >= BULK_STATUS_ORDER_THRESHOLD;
  console.log(
    `${LOG_PREFIX} updateOrderStatus orders=${orderIds.length} statusCode=${statusCode} strategy=${useBulk ? "bulk" : "per-order"}`,
  );

  if (useBulk) {
    await updateOrderStatusBulk(orderIds, statusCode);
  } else {
    await updateOrderStatusPerOrder(orderIds, statusCode);
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}
