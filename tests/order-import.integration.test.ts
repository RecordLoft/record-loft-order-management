import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../webhooks/shopify-fulfillment.server", () => ({
  listFulfillmentOrdersForOrder: vi.fn(),
  markFulfillmentOrdersInProgress: vi.fn(),
}));

import { prisma } from "../app/db.server";
import { applyOrderStatusCache } from "../app/order-status-pro.server";
import { handleOrdersCreate } from "../webhooks/orders-create.handler.server";
import { handleOrdersCancelled } from "../webhooks/orders-lifecycle.handler.server";
import {
  listFulfillmentOrdersForOrder,
  markFulfillmentOrdersInProgress,
} from "../webhooks/shopify-fulfillment.server";
import ordersCreateFixture from "./fixtures/shopify-orders-create.json";
import ordersCancelledFixture from "./fixtures/shopify-orders-cancelled.json";
import { INTEGRATION_SHOP, resetIntegrationDb } from "./integration-db";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

describe("pending import against Postgres", () => {
  beforeEach(async () => {
    await resetIntegrationDb();
    vi.mocked(listFulfillmentOrdersForOrder).mockResolvedValue({
      ok: true,
      fulfillmentOrders: [
        {
          id: "gid://shopify/FulfillmentOrder/1",
          status: "OPEN",
          deliveryMethod: { methodType: "SHIPPING" },
        },
      ],
    });
    vi.mocked(markFulfillmentOrdersInProgress).mockResolvedValue({
      ok: true,
      marked: 0,
    });
  });

  it("applies cancel and OSP status when orders/create arrives", async () => {
    await expect(
      handleOrdersCancelled(ordersCancelledFixture),
    ).resolves.toEqual({
      outcome: "completed",
      detail: "cancelled pending import",
    });
    await expect(applyOrderStatusCache(9001n, "Ready")).resolves.toBe(false);

    const pending = await prisma.orderImportPending.findUnique({
      where: { orderId: 9001n },
    });
    expect(pending).toMatchObject({
      cancelledAt: new Date("2026-08-01T12:00:00.000Z"),
      ospStatusName: "Ready",
    });

    const graphql = vi.fn(async () =>
      jsonResponse({
        data: {
          nodes: [
            {
              id: "gid://shopify/Product/55",
              productType: "Vinyl",
            },
          ],
        },
      }),
    );

    await expect(
      handleOrdersCreate(INTEGRATION_SHOP, ordersCreateFixture, graphql),
    ).resolves.toEqual({ outcome: "completed", detail: "imported" });

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: 9001n },
    });
    expect(order.cancelledAt).toEqual(new Date("2026-08-01T12:00:00.000Z"));
    expect(order.ospStatusName).toBe("Ready");
    expect(order.ospStatusSyncedAt).toBeInstanceOf(Date);
    await expect(
      prisma.orderImportPending.findUnique({ where: { orderId: 9001n } }),
    ).resolves.toBeNull();
  });
});
