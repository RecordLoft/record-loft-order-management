import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, authenticateAdmin } = vi.hoisted(() => ({
  prismaMock: {
    order: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    orderImportPending: {
      upsert: vi.fn(),
    },
  },
  authenticateAdmin: vi.fn(),
}));

vi.mock("../app/db.server", () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
}));

import {
  BULK_STATUS_ORDER_THRESHOLD,
  RateLimitError,
  applyOrderStatusCache,
  bulkUpdateOrderStatus,
  fetchViableStatusChoices,
  orderStatusFromRow,
  ordersMatchCachedStatus,
  ordersSyncedSince,
  parseOrderIdParam,
  parseOrderIdsParam,
  parseOspWebhookPayload,
  resetRateLimitStateForTests,
  verifyOspWebhookToken,
} from "../app/order-status-pro.server";
import { action as updateStatusAction } from "../app/routes/api.update-status";
import { loader as viableStatusesLoader } from "../app/routes/api.viable-statuses";
import { loader as orderStatusSyncLoader } from "../app/routes/api.order-status-sync";
import { action as ospWebhookAction } from "../app/routes/api.webhooks.order-status-pro.$token";
import { routeArgs } from "./route-args";

const shop = "record-loft.myshopify.com";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("StatusPro parsers and cache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimitStateForTests();
  });

  it("parses order ids from raw values and GIDs", () => {
    expect(parseOrderIdParam(null)).toBeNull();
    expect(parseOrderIdParam("gid://shopify/Order/99")).toBe(99n);
    expect(parseOrderIdParam(" 12 ")).toBe(12n);
    expect(parseOrderIdsParam("1, gid://shopify/Order/2, x")).toEqual([1n, 2n]);
    expect(parseOrderIdsParam("")).toEqual([]);
  });

  it("formats cached status for the Record Planet UI", () => {
    expect(orderStatusFromRow({ ospStatusName: "Ready" })).toEqual({
      name: "Ready",
    });
    expect(orderStatusFromRow({ ospStatusName: null })).toBe("Unknown");
  });

  it("parses StatusPro webhook payloads", () => {
    expect(parseOspWebhookPayload(null)).toBeNull();
    expect(
      parseOspWebhookPayload({
        order_id: "15",
        status: { new_status: "Ready for pickup" },
      }),
    ).toEqual({ orderId: 15n, statusName: "Ready for pickup" });
    expect(
      parseOspWebhookPayload({
        order: { id: 22 },
        status: { newStatus: "Shipped" },
      }),
    ).toEqual({ orderId: 22n, statusName: "Shipped" });
    expect(parseOspWebhookPayload({ order_id: 1, status: {} })).toBeNull();
  });

  it("verifies the webhook path token with a timing-safe compare", () => {
    const previous = process.env.ORDER_STATUS_PRO_WEBHOOK_TOKEN;
    delete process.env.ORDER_STATUS_PRO_WEBHOOK_TOKEN;
    expect(verifyOspWebhookToken("secret")).toBe(false);

    process.env.ORDER_STATUS_PRO_WEBHOOK_TOKEN = "expected-token";
    expect(verifyOspWebhookToken("expected-token")).toBe(true);
    expect(verifyOspWebhookToken("wrong-token-xx")).toBe(false);
    expect(verifyOspWebhookToken("")).toBe(false);
    process.env.ORDER_STATUS_PRO_WEBHOOK_TOKEN = previous;
  });

  it("requires every order to have synced after the given timestamp", async () => {
    prismaMock.order.findMany.mockResolvedValue([
      { ospStatusSyncedAt: new Date("2026-01-01T00:00:02Z") },
    ]);
    await expect(
      ordersSyncedSince([1n], new Date("2026-01-01T00:00:02Z")),
    ).resolves.toBe(true);

    prismaMock.order.findMany.mockResolvedValue([
      { ospStatusSyncedAt: new Date("2026-01-01T00:00:00Z") },
    ]);
    await expect(
      ordersSyncedSince([1n], new Date("2026-01-01T00:00:02Z")),
    ).resolves.toBe(false);

    prismaMock.order.findMany.mockResolvedValue([]);
    await expect(
      ordersSyncedSince([1n, 2n], new Date("2026-01-01T00:00:00Z")),
    ).resolves.toBe(false);
    await expect(ordersSyncedSince([], new Date())).resolves.toBe(false);
  });

  it("compares cached status names case-insensitively", async () => {
    prismaMock.order.findMany.mockResolvedValue([
      { ospStatusName: "Ready" },
      { ospStatusName: "ready" },
    ]);
    await expect(ordersMatchCachedStatus([1n, 2n], "READY")).resolves.toBe(true);
    await expect(ordersMatchCachedStatus([], "READY")).resolves.toBe(false);
  });

  it("writes the inbound status cache", async () => {
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 });
    await expect(applyOrderStatusCache(5n, "Ready")).resolves.toBe(true);
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: 5n },
      data: expect.objectContaining({ ospStatusName: "Ready" }),
    });
  });

  it("stores StatusPro status as pending when the order is not imported yet", async () => {
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.orderImportPending.upsert.mockResolvedValue({});
    await expect(applyOrderStatusCache(5n, "Ready")).resolves.toBe(false);
    expect(prismaMock.orderImportPending.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { orderId: 5n },
        create: expect.objectContaining({
          orderId: 5n,
          ospStatusName: "Ready",
        }),
      }),
    );
  });
});

describe("StatusPro HTTP client", () => {
  const previousKey = process.env.ORDER_STATUS_PRO_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimitStateForTests();
    process.env.ORDER_STATUS_PRO_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env.ORDER_STATUS_PRO_API_KEY = previousKey;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("maps viable statuses and rejects API errors", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse([
        { name: "Ready", code: "ready" },
        { name: "Nope" },
      ]),
    );
    await expect(fetchViableStatusChoices(1n)).resolves.toEqual([
      { label: "Ready", value: "ready" },
    ]);

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("nope", { status: 500 }),
    );
    await expect(fetchViableStatusChoices(1n)).rejects.toThrow(
      "Failed to fetch viable statuses from Order Status Pro",
    );
  });

  it("uses per-order updates below the bulk threshold and bulk at or above it", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));

    await bulkUpdateOrderStatus([1n, 2n], "ready");
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "https://app.orderstatuspro.com/api/v1/orders/1/status",
    );
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);

    vi.mocked(fetch).mockClear();
    const bulkIds = Array.from({ length: BULK_STATUS_ORDER_THRESHOLD }, (_, i) =>
      BigInt(i + 1),
    );
    await bulkUpdateOrderStatus(bulkIds, "ready");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "https://app.orderstatuspro.com/api/v1/orders/bulk-status",
    );
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({
      order_ids: bulkIds.map(Number),
      status_code: "ready",
    });
  });

  it("throws RateLimitError on OSP 429 without retrying", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ message: "slow down" }, 429, { "Retry-After": "12" }),
    );
    await expect(fetchViableStatusChoices(1n)).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("throws RateLimitError when the API reports too many attempts", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ message: "Too many attempts" }, 400),
    );
    await expect(bulkUpdateOrderStatus([1n], "ready")).rejects.toBeInstanceOf(
      RateLimitError,
    );
  });

  it("fails fast on the client bulk window without calling OSP", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));
    const bulkIds = Array.from({ length: BULK_STATUS_ORDER_THRESHOLD }, (_, i) =>
      BigInt(i + 1),
    );

    for (let i = 0; i < 4; i++) {
      await bulkUpdateOrderStatus(bulkIds, "ready");
    }

    vi.mocked(fetch).mockClear();
    await expect(bulkUpdateOrderStatus(bulkIds, "ready")).rejects.toBeInstanceOf(
      RateLimitError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("StatusPro admin routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRateLimitStateForTests();
    authenticateAdmin.mockResolvedValue({ session: { shop } });
    process.env.ORDER_STATUS_PRO_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects unowned orders on status update", async () => {
    prismaMock.order.count.mockResolvedValue(1);
    const form = new FormData();
    form.set("ids", "1,2");
    form.set("status_code", "ready");
    const response = await updateStatusAction(routeArgs(new Request("https://app.test/api/update-status", {
        method: "POST",
        body: form,
      })));
    expect(response.status).toBe(404);
  });

  it("updates owned orders and returns syncedAfter", async () => {
    prismaMock.order.count.mockResolvedValue(1);
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ ok: true }));
    const form = new FormData();
    form.set("ids", "gid://shopify/Order/9");
    form.set("status_code", "ready");
    const response = await updateStatusAction(routeArgs(new Request("https://app.test/api/update-status", {
        method: "POST",
        body: form,
      })));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true });
  });

  it("returns 429 with a bulk-specific message", async () => {
    const ids = Array.from({ length: BULK_STATUS_ORDER_THRESHOLD }, (_, i) =>
      String(i + 1),
    );
    prismaMock.order.count.mockResolvedValue(ids.length);
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({ message: "Too many attempts" }, 400),
    );
    const form = new FormData();
    form.set("ids", ids.join(","));
    form.set("status_code", "ready");
    const response = await updateStatusAction(routeArgs(new Request("https://app.test/api/update-status", {
        method: "POST",
        body: form,
      })));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("5 per minute"),
    });
  });

  it("requires ids and status on update", async () => {
    const empty = new FormData();
    const missingIds = await updateStatusAction(routeArgs(new Request("https://app.test/api/update-status", {
        method: "POST",
        body: empty,
      })));
    expect(missingIds.status).toBe(400);
    await expect(missingIds.json()).resolves.toMatchObject({
      error: "No orders selected",
    });

    const noStatus = new FormData();
    noStatus.set("ids", "1");
    const missingStatus = await updateStatusAction(routeArgs(new Request("https://app.test/api/update-status", {
        method: "POST",
        body: noStatus,
      })));
    expect(missingStatus.status).toBe(400);

    const junk = new FormData();
    junk.set("ids", "x,nope");
    junk.set("status_code", "ready");
    const invalidIds = await updateStatusAction(routeArgs(new Request("https://app.test/api/update-status", {
        method: "POST",
        body: junk,
      })));
    expect(invalidIds.status).toBe(400);
    await expect(invalidIds.json()).resolves.toMatchObject({
      error: "No valid order IDs",
    });
    expect(prismaMock.order.count).not.toHaveBeenCalled();
  });

  it("scopes viable statuses to the session shop", async () => {
    prismaMock.order.findFirst.mockResolvedValue(null);
    const missing = await viableStatusesLoader(routeArgs(new Request("https://app.test/api/viable-statuses?id=1")));
    expect(missing.status).toBe(404);

    prismaMock.order.findFirst.mockResolvedValue({ id: 1n });
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse([{ name: "Ready", code: "ready" }]),
    );
    const ok = await viableStatusesLoader(routeArgs(new Request("https://app.test/api/viable-statuses?id=1")));
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual([{ label: "Ready", value: "ready" }]);
  });

  it("polls cache sync by timestamp or expected name", async () => {
    const bad = await orderStatusSyncLoader(routeArgs(new Request("https://app.test/api/order-status-sync")));
    expect(bad.status).toBe(400);

    prismaMock.order.findMany.mockResolvedValue([
      { ospStatusSyncedAt: new Date("2026-01-01T00:00:00Z"), ospStatusName: "Ready" },
    ]);
    const byName = await orderStatusSyncLoader(routeArgs(new Request(
        "https://app.test/api/order-status-sync?ids=1&since=2026-01-02T00:00:00.000Z&status_name=Ready",
      )));
    await expect(byName.json()).resolves.toEqual({ synced: true });
  });
});

describe("StatusPro inbound webhook", () => {
  const previous = process.env.ORDER_STATUS_PRO_WEBHOOK_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ORDER_STATUS_PRO_WEBHOOK_TOKEN = "hook-token";
  });

  afterEach(() => {
    process.env.ORDER_STATUS_PRO_WEBHOOK_TOKEN = previous;
  });

  it("rejects bad method, token, and JSON, and caches a valid payload", async () => {
    const method = await ospWebhookAction(routeArgs(new Request("https://app.test/api/webhooks/order-status-pro/hook-token", {
        method: "GET",
      }), { token: "hook-token" }));
    expect(method.status).toBe(405);

    const unauthorized = await ospWebhookAction(routeArgs(new Request("https://app.test/api/webhooks/order-status-pro/nope", {
        method: "POST",
        body: "{}",
      }), { token: "nope" }));
    expect(unauthorized.status).toBe(401);

    const badJson = await ospWebhookAction(routeArgs(new Request("https://app.test/api/webhooks/order-status-pro/hook-token", {
        method: "POST",
        body: "{",
      }), { token: "hook-token" }));
    expect(badJson.status).toBe(400);

    prismaMock.order.updateMany.mockResolvedValue({ count: 1 });
    const ok = await ospWebhookAction(routeArgs(new Request("https://app.test/api/webhooks/order-status-pro/hook-token", {
        method: "POST",
        body: JSON.stringify({
          order_id: 9,
          status: { new_status: "Ready" },
        }),
      }), { token: "hook-token" }));
    expect(ok.status).toBe(200);
    expect(prismaMock.order.updateMany).toHaveBeenCalled();
  });

  it("200-acks a parseable body that is not a StatusPro payload so they do not retry", async () => {
    const empty = await ospWebhookAction(routeArgs(new Request("https://app.test/api/webhooks/order-status-pro/hook-token", {
        method: "POST",
        body: "{}",
      }), { token: "hook-token" }));
    expect(empty.status).toBe(200);
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.orderImportPending.upsert).not.toHaveBeenCalled();
  });
});
