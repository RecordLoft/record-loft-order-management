import { timingSafeEqual } from "node:crypto";
import prisma from "./db.server";

const OSP_BASE = "https://app.orderstatuspro.com/api/v1";

/**
 * Per https://orderstatuspro.com/api/openapi.json
 * - Most endpoints (incl. viable-statuses, single status update): 60/min
 * - POST /orders/bulk-status: 5/min (max 50 order_ids per request)
 */
const MAX_429_RETRIES = 3;

/** Below this count: POST /orders/{id}/status per order; at or above: /orders/bulk-status. */
export const BULK_STATUS_ORDER_THRESHOLD = 40;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns total ms spent waiting for a rate-limit slot. */
async function waitForRateLimitSlot(bucket: RateLimitBucket): Promise<number> {
  const { max, windowMs, label } = RATE_LIMITS[bucket];
  const timestamps = requestTimestampsByBucket[bucket];
  const now = Date.now();
  pruneRequestWindow(bucket, now);

  if (timestamps.length >= max) {
    const waitMs = windowMs - (now - timestamps[0]!) + 50;
    console.warn(
      `${LOG_PREFIX} client throttle (${label}): ${timestamps.length}/${max} in ${windowMs}ms, waiting ${waitMs}ms`,
    );
    await sleep(waitMs);
    return waitMs + (await waitForRateLimitSlot(bucket));
  }

  timestamps.push(Date.now());
  return 0;
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

const statusWatchers = new Map<string, Set<(statusName: string) => void>>();

export function subscribeOrderStatusWatch(
  orderId: bigint,
  onUpdate: (statusName: string) => void,
): () => void {
  const key = orderId.toString();
  let listeners = statusWatchers.get(key);
  if (!listeners) {
    listeners = new Set();
    statusWatchers.set(key, listeners);
  }
  listeners.add(onUpdate);
  return () => {
    listeners!.delete(onUpdate);
    if (listeners!.size === 0) statusWatchers.delete(key);
  };
}

function emitOrderStatusCacheUpdated(orderId: bigint, statusName: string) {
  statusWatchers.get(orderId.toString())?.forEach((listener) => {
    listener(statusName);
  });
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
  const result = await prisma.order.updateMany({
    where: { id: orderId },
    data: {
      ospStatusName: statusName,
      ospStatusSyncedAt: new Date(),
    },
  });
  if (result.count > 0) {
    emitOrderStatusCacheUpdated(orderId, statusName);
  }
  return result.count > 0;
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

function parseRetryAfterMs(response: Response): number | null {
  const header = response.headers.get("Retry-After");
  if (!header?.trim()) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000);
  }
  const retryAt = Date.parse(header);
  if (!Number.isNaN(retryAt)) {
    return Math.max(0, retryAt - Date.now());
  }
  return null;
}

function backoffMsFor429(bucket: RateLimitBucket, attempt: number): number {
  if (bucket === "bulk") {
    // 5/min → ~12s between bulk calls when the minute window is full.
    const delays = [12_000, 15_000, 15_000];
    return delays[attempt] ?? 15_000;
  }
  const delays = [2_000, 4_000, 4_000];
  return delays[attempt] ?? 4_000;
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
  const waitedMs = await waitForRateLimitSlot(bucket);
  const windowCount = getWindowRequestCount(bucket);

  console.log(
    `${LOG_PREFIX} request ${method} ${path} ${label} window=${windowCount}/${max}${waitedMs > 0 ? ` waited=${waitedMs}ms` : ""}`,
  );

  const requestInit: RequestInit = {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  };

  for (let attempt = 0; attempt <= MAX_429_RETRIES; attempt++) {
    const startedAt = Date.now();
    const response = await fetch(`${OSP_BASE}${path}`, requestInit);
    const elapsedMs = Date.now() - startedAt;
    const retrySuffix =
      attempt > 0 ? ` retry=${attempt}/${MAX_429_RETRIES}` : "";

    if (response.status !== 429 || attempt === MAX_429_RETRIES) {
      logOrderStatusProResponse(method, path, response, elapsedMs, retrySuffix);
      return response;
    }

    const retryAfterMs = parseRetryAfterMs(response);
    const waitMs = retryAfterMs ?? backoffMsFor429(bucket, attempt);
    logOrderStatusProResponse(
      method,
      path,
      response,
      elapsedMs,
      `${retrySuffix} retrying in ${waitMs}ms`,
    );
    await sleep(waitMs);
  }

  throw new Error("fetchOrderStatusPro: exhausted 429 retries");
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
 * Fewer than 40: per-order API (60/min). 40+: bulk queue (5/min).
 * All calls use fetchOrderStatusPro (client throttle + 429 retries).
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
