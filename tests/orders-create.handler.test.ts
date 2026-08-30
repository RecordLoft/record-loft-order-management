import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, tx, listFulfillmentOrdersForOrder, markFulfillmentOrdersInProgress, applyOrderImportPending } =
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
      applyOrderImportPending: vi.fn(),
    };
  });

vi.mock("../app/db.server", () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock("../app/order-import-pending.server", () => ({
  applyOrderImportPending,
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
    applyOrderImportPending.mockResolvedValue(false);
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

  it("imports custom items without product enrichment but still lists fulfillment orders", async () => {
    const customPayload = {
      ...payload,
      line_items: [
        {
          id: 12,
          product_id: null,
          title: "Custom fee",
          quantity: 1,
          price: "2.00",
          variant_id: null,
          sku: null,
        },
      ],
      customer: null,
    };

    await expect(handleOrdersCreate(shop, customPayload, vi.fn())).resolves.toEqual({
      outcome: "completed",
      detail: "imported",
    });
    expect(tx.customer.upsert).not.toHaveBeenCalled();
    expect(listFulfillmentOrdersForOrder).toHaveBeenCalledWith(
      expect.any(Function),
      "gid://shopify/Order/9001",
    );
    expect(tx.order.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          customerId: undefined,
          deliveryMethod: "shipping",
        }),
      }),
    );
  });

  it("applies pending StatusPro / cancel fields after import", async () => {
    const graphql = vi.fn(async () =>
      jsonResponse({
        data: { nodes: [{ id: "gid://shopify/Product/55" }] },
      }),
    );
    applyOrderImportPending.mockResolvedValue(true);

    await expect(handleOrdersCreate(shop, payload, graphql)).resolves.toEqual({
      outcome: "completed",
      detail: "imported",
    });
    expect(applyOrderImportPending).toHaveBeenCalledWith(BigInt(9001));
  });

  it("stamps fulfilledAt when the create payload is already fulfilled", async () => {
    const graphql = vi.fn(async () =>
      jsonResponse({
        data: { nodes: [{ id: "gid://shopify/Product/55" }] },
      }),
    );
    const fulfilledPayload = {
      ...payload,
      fulfillment_status: "fulfilled",
      updated_at: "2026-08-02T12:00:00.000Z",
    };

    await expect(
      handleOrdersCreate(shop, fulfilledPayload, graphql),
    ).resolves.toEqual({
      outcome: "completed",
      detail: "imported",
    });
    expect(tx.order.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          fulfilledAt: new Date("2026-08-02T12:00:00.000Z"),
        }),
        create: expect.objectContaining({
          fulfilledAt: new Date("2026-08-02T12:00:00.000Z"),
        }),
      }),
    );
  });

  it("uses billing/shipping phone when the customer has none", async () => {
    const graphql = vi.fn(async () =>
      jsonResponse({
        data: { nodes: [{ id: "gid://shopify/Product/55" }] },
      }),
    );
    const withoutCustomerPhone = {
      ...payload,
      customer: { ...payload.customer!, phone: null },
      billing_address: { phone: "555-0199" },
    };

    await handleOrdersCreate(shop, withoutCustomerPhone, graphql);
    expect(tx.customer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ phone: "555-0199" }),
      }),
    );
  });

  it("retries when fulfillment orders cannot be listed", async () => {
    const graphql = vi.fn(async () =>
      jsonResponse({
        data: { nodes: [{ id: "gid://shopify/Product/55" }] },
      }),
    );
    listFulfillmentOrdersForOrder.mockResolvedValue({
      ok: false,
      retryable: true,
      code: "graphql_errors",
      message: "blip",
    });

    await expect(handleOrdersCreate(shop, payload, graphql)).resolves.toEqual({
      outcome: "error",
      code: "graphql_errors",
      message: "blip",
      retry: true,
    });
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });

  it("returns a fulfillment progress error after import", async () => {
    const graphql = vi.fn(async () =>
      jsonResponse({
        data: {
          nodes: [
            {
              id: "gid://shopify/Product/55",
              productType: "Record Planet Shipping",
            },
          ],
        },
      }),
    );
    markFulfillmentOrdersInProgress.mockResolvedValue({
      ok: false,
      retryable: true,
      code: "fulfillment_orders_not_ready",
      message: "No fulfillment orders on order yet",
    });

    await expect(handleOrdersCreate(shop, payload, graphql)).resolves.toEqual({
      outcome: "error",
      code: "fulfillment_orders_not_ready",
      message: "No fulfillment orders on order yet",
      retry: true,
    });
    expect(tx.order.upsert).toHaveBeenCalled();
  });

  it("reports fulfillment already in progress", async () => {
    const graphql = vi.fn(async () =>
      jsonResponse({
        data: {
          nodes: [
            {
              id: "gid://shopify/Product/55",
              productType: "Record Planet Shipping",
            },
          ],
        },
      }),
    );
    markFulfillmentOrdersInProgress.mockResolvedValue({
      ok: true,
      marked: 0,
    });

    await expect(handleOrdersCreate(shop, payload, graphql)).resolves.toEqual({
      outcome: "completed",
      detail: "imported, fulfillment already in progress",
    });
  });
});
