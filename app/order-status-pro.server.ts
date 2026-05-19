import { timingSafeEqual } from "node:crypto";
import prisma from "./db.server";

const OSP_BASE = "https://app.orderstatuspro.com/api/v1";

/** Order Status Pro allows ~50 requests per 10s per API key. */
const REQUESTS_PER_WINDOW = 45;
const WINDOW_MS = 10_000;

const requestTimestamps: number[] = [];

const LOG_PREFIX = "[statuspro-api]";

function pruneRequestWindow(now = Date.now()): void {
  while (
    requestTimestamps.length > 0 &&
    now - requestTimestamps[0]! >= WINDOW_MS
  ) {
    requestTimestamps.shift();
  }
}

function getWindowRequestCount(): number {
  pruneRequestWindow();
  return requestTimestamps.length;
}

function getApiKey(): string {
  const apiKey = process.env.ORDER_STATUS_PRO_API_KEY;
  if (!apiKey) {
    throw new Error("ORDER_STATUS_PRO_API_KEY is not configured");
  }
  return apiKey;
}

/** Returns total ms spent waiting for a rate-limit slot. */
async function waitForRateLimitSlot(): Promise<number> {
  const now = Date.now();
  pruneRequestWindow(now);

  if (requestTimestamps.length >= REQUESTS_PER_WINDOW) {
    const waitMs = WINDOW_MS - (now - requestTimestamps[0]!) + 50;
    console.warn(
      `${LOG_PREFIX} client throttle: ${requestTimestamps.length}/${REQUESTS_PER_WINDOW} requests in ${WINDOW_MS}ms window, waiting ${waitMs}ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return waitMs + (await waitForRateLimitSlot());
  }

  requestTimestamps.push(Date.now());
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

export async function fetchOrderStatusPro(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const waitedMs = await waitForRateLimitSlot();
  const windowCount = getWindowRequestCount();

  console.log(
    `${LOG_PREFIX} request ${method} ${path} window=${windowCount}/${REQUESTS_PER_WINDOW}${waitedMs > 0 ? ` waited=${waitedMs}ms` : ""}`,
  );

  const startedAt = Date.now();
  const response = await fetch(`${OSP_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const elapsedMs = Date.now() - startedAt;

  const line = `${LOG_PREFIX} response ${method} ${path} -> ${response.status} ${elapsedMs}ms`;
  if (response.status === 429) {
    console.warn(`${line} (rate limited by Order Status Pro)`);
  } else if (!response.ok) {
    console.warn(line);
  } else {
    console.log(line);
  }

  return response;
}

export async function bulkUpdateOrderStatus(
  orderIds: bigint[],
  statusCode: string,
): Promise<void> {
  console.log(
    `${LOG_PREFIX} bulkUpdateOrderStatus orders=${orderIds.length} statusCode=${statusCode}`,
  );
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
