import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, tx, listFulfillmentOrdersForOrder, markFulfillmentOrdersInProgress } =
  vi.hoisted(() => {
    const tx = {
      customer: { upsert: vi.fn() },
      order: { upsert: vi.fn() },
      lineItem: { deleteMany: vi.fn(), createMany: vi.fn() },
    };
    const prismaMock = {
      $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<void>) =>
        fn(tx),
      ),
    };
    return {
      prismaMock,
      tx,
      listFulfillmentOrdersForOrder: vi.fn(),
      markFulfillmentOrdersInProgress: vi.fn(),
    };
  });

vi.mock("../app/db.server", () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock("../webhooks/shopify-fulfillment.server", () => ({
  listFulfillmentOrdersForOrder,
  markFulfillmentOrdersInProgress,
}));

import { handleOrdersCreate } from "../webhooks/orders-create.handler.server";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

const shop = "record-loft.myshopify.com";

const payload = {
  id: 9001,
  order_number: 101,
  total_price: "32.00",
  currency: "USD",
  line_items: [
    {
      id: 11,
      product_id: 55,
      title: "Kind of Blue",
      quantity: 1,
      price: "32.00",
      variant_id: 77,
      sku: "KOB",
      properties: [{ name: "Artist", value: "Miles" }],
    },
  ],
  customer: {
    id: 3,
    email: "buyer@example.com",
    first_name: "Ada",
    last_name: "Lovelace",
    phone: "555-0100",
  },
};

describe("handleOrdersCreate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tx.customer.upsert.mockResolvedValue({});
    tx.order.upsert.mockResolvedValue({});
    tx.lineItem.deleteMany.mockResolvedValue({ count: 1 });
    tx.lineItem.createMany.mockResolvedValue({ count: 1 });
    listFulfillmentOrdersForOrder.mockResolvedValue({
      ok: true,
      fulfillmentOrders: [
        { id: "gid://shopify/FulfillmentOrder/1", deliveryMethod: { methodType: "SHIPPING" } },
      ],
    });
    markFulfillmentOrdersInProgress.mockResolvedValue({
      ok: true,
      marked: 1,
    });
  });

  it("retries transient GraphQL enrichment errors", async () => {
    const graphql = vi.fn(async () =>
      jsonResponse({ errors: [{ message: "Throttled" }] }),
    );

    await expect(handleOrdersCreate(shop, payload, graphql)).resolves.toEqual({
      outcome: "error",
      code: "graphql_errors",
      message: JSON.stringify([{ message: "Throttled" }]),
      retry: true,
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("replaces line items and customer on a create retry", async () => {
    const graphql = vi.fn(async () =>
      jsonResponse({
        data: {
          nodes: [
            {
              id: "gid://shopify/Product/55",
              productType: "Vinyl",
              category: { name: "Jazz" },
              storeSection: { value: "A1" },
            },
          ],
        },
      }),
    );

    await expect(handleOrdersCreate(shop, payload, graphql)).resolves.toEqual({
      outcome: "completed",
      detail: "imported",
    });

    expect(tx.customer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(3) },
        update: expect.objectContaining({
          email: "buyer@example.com",
          phone: "555-0100",
        }),
      }),
    );
    expect(tx.order.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BigInt(9001) },
        update: expect.objectContaining({
          shop,
          orderNumber: 101,
          totalPrice: "32.00",
          deliveryMethod: "shipping",
          customerId: BigInt(3),
        }),
      }),
    );
    expect(tx.lineItem.deleteMany).toHaveBeenCalledWith({
      where: { orderId: BigInt(9001) },
    });
    expect(tx.lineItem.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: BigInt(11),
          orderId: BigInt(9001),
          title: "Kind of Blue",
          productType: "Vinyl",
          storeSection: "A1",
          category: "Jazz",
          properties: { Artist: "Miles" },
        }),
      ],
    });
    expect(markFulfillmentOrdersInProgress).not.toHaveBeenCalled();
  });

  it("marks Record Planet fulfillment orders in progress after import", async () => {
    const graphql = vi.fn(async () =>
      jsonResponse({
        data: {
          nodes: [
            {
              id: "gid://shopify/Product/55",
              productType: "Record Planet Shipping",
              category: { name: "Shipping" },
              storeSection: { value: null },
            },
          ],
        },
      }),
    );

    await expect(handleOrdersCreate(shop, payload, graphql)).resolves.toEqual({
      outcome: "completed",
      detail: "imported, 1 fulfillment(s) in progress",
    });
    expect(tx.order.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ deliveryMethod: "recordPlanet" }),
      }),
    );
    expect(markFulfillmentOrdersInProgress).toHaveBeenCalled();
  });
});
