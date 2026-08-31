import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, upsertOrderImportPending } = vi.hoisted(() => ({
  prismaMock: {
    order: { updateMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    orderImportPending: { findUnique: vi.fn(), delete: vi.fn() },
  },
  upsertOrderImportPending: vi.fn(),
}));

vi.mock("../app/db.server", () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock("../app/order-import-pending.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../app/order-import-pending.server")>();
  return {
    ...actual,
    upsertOrderImportPending,
  };
});

import { applyOrderImportPending } from "../app/order-import-pending.server";
import {
  handleOrdersCancelled,
  handleOrdersFulfilled,
  handleRefundsCreate,
  isFullOrderRefund,
} from "../webhooks/orders-lifecycle.handler.server";
import ordersCancelledFixture from "./fixtures/shopify-orders-cancelled.json";
import ordersFulfilledFixture from "./fixtures/shopify-orders-fulfilled.json";
import refundsCreateFixture from "./fixtures/shopify-refunds-create.json";

const fullRefundPayload = {
  id: 55,
  order_id: 9001,
  created_at: "2026-08-03T12:00:00.000Z",
  refund_line_items: [
    {
      line_item_id: 11,
      quantity: 1,
      line_item: { id: 11, quantity: 1 },
    },
  ],
};

describe("handleOrdersCancelled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 });
  });

  it("sets cancelledAt on an existing order", async () => {
    await expect(handleOrdersCancelled(ordersCancelledFixture)).resolves.toEqual(
      { outcome: "completed", detail: "cancelled" },
    );
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: 9001n },
      data: { cancelledAt: new Date("2026-08-01T12:00:00.000Z") },
    });
    expect(upsertOrderImportPending).not.toHaveBeenCalled();
  });

  it("stores pending cancel when the order is not imported yet", async () => {
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(handleOrdersCancelled({ id: "9001" })).resolves.toEqual({
      outcome: "completed",
      detail: "cancelled pending import",
    });
    expect(upsertOrderImportPending).toHaveBeenCalledWith(
      9001n,
      expect.objectContaining({ cancelledAt: expect.any(Date) }),
    );
  });

  it("rejects a payload without an order id", async () => {
    await expect(handleOrdersCancelled({})).resolves.toMatchObject({
      outcome: "error",
      code: "invalid_payload",
      retry: false,
    });
  });
});

describe("handleOrdersFulfilled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 });
  });

  it("sets fulfilledAt on an existing order", async () => {
    await expect(handleOrdersFulfilled(ordersFulfilledFixture)).resolves.toEqual(
      { outcome: "completed", detail: "fulfilled" },
    );
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: 9001n },
      data: { fulfilledAt: new Date("2026-08-02T12:00:00.000Z") },
    });
    expect(upsertOrderImportPending).not.toHaveBeenCalled();
  });

  it("stores pending fulfill when the order is not imported yet", async () => {
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(handleOrdersFulfilled({ id: "9001" })).resolves.toEqual({
      outcome: "completed",
      detail: "fulfilled pending import",
    });
    expect(upsertOrderImportPending).toHaveBeenCalledWith(
      9001n,
      expect.objectContaining({ fulfilledAt: expect.any(Date) }),
    );
  });

  it("rejects a payload without an order id", async () => {
    await expect(handleOrdersFulfilled({})).resolves.toMatchObject({
      outcome: "error",
      code: "invalid_payload",
      retry: false,
    });
  });
});

describe("isFullOrderRefund", () => {
  it("treats shipping-only and partial line refunds as not full", () => {
    expect(isFullOrderRefund({ order_id: 9001 })).toBe(false);
    expect(
      isFullOrderRefund(
        {
          refund_line_items: [
            { line_item_id: 11, quantity: 1, line_item: { id: 11, quantity: 1 } },
          ],
        },
        [{ id: 11n, quantity: 1 }, { id: 12n, quantity: 1 }],
      ),
    ).toBe(false);
  });

  it("treats financial_status refunded as full and partially_refunded as not", () => {
    expect(isFullOrderRefund({ financial_status: "refunded" })).toBe(true);
    expect(isFullOrderRefund({ financial_status: "partially_refunded" })).toBe(
      false,
    );
  });

  it("treats a complete line refund as full when the order is imported", () => {
    expect(
      isFullOrderRefund(fullRefundPayload, [{ id: 11n, quantity: 1 }]),
    ).toBe(true);
  });

  it("uses payload line originals when the order is not imported yet", () => {
    expect(
      isFullOrderRefund({
        refund_line_items: [
          {
            line_item_id: 11,
            quantity: 1,
            line_item: { id: 11, quantity: 1 },
          },
          {
            line_item_id: 12,
            quantity: 2,
            line_item: { id: 12, quantity: 2 },
          },
        ],
      }),
    ).toBe(true);
    expect(
      isFullOrderRefund({
        refund_line_items: [
          {
            line_item_id: 11,
            quantity: 1,
            line_item: { id: 11, quantity: 2 },
          },
        ],
      }),
    ).toBe(false);
  });

  it("reads financial_status from a nested order object", () => {
    expect(
      isFullOrderRefund({ order: { financial_status: "refunded" } }),
    ).toBe(true);
    expect(
      isFullOrderRefund({ order: { financial_status: "partially_refunded" } }),
    ).toBe(false);
  });
});

describe("handleRefundsCreate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 });
    prismaMock.order.findUnique.mockResolvedValue({
      lineItems: [{ id: 11n, quantity: 1 }],
    });
  });

  it("sets refundedAt only for a full refund", async () => {
    await expect(handleRefundsCreate(refundsCreateFixture)).resolves.toEqual({
      outcome: "completed",
      detail: "refunded",
    });
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: 9001n },
      data: { refundedAt: new Date("2026-08-03T12:00:00.000Z") },
    });
  });

  it("leaves partial refunds off refundedAt so Active stays open", async () => {
    await expect(
      handleRefundsCreate({ id: 55, order_id: 9001 }),
    ).resolves.toEqual({ outcome: "completed", detail: "partial refund" });
    expect(prismaMock.order.updateMany).not.toHaveBeenCalled();
    expect(upsertOrderImportPending).not.toHaveBeenCalled();
  });

  it("stores pending refund when a full refund arrives before import", async () => {
    prismaMock.order.findUnique.mockResolvedValue(null);
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(handleRefundsCreate(fullRefundPayload)).resolves.toEqual({
      outcome: "completed",
      detail: "refunded pending import",
    });
    expect(upsertOrderImportPending).toHaveBeenCalledWith(
      9001n,
      expect.objectContaining({
        refundedAt: new Date("2026-08-03T12:00:00.000Z"),
      }),
    );
  });

  it("rejects a payload without order_id", async () => {
    await expect(handleRefundsCreate({ id: 55 })).resolves.toMatchObject({
      outcome: "error",
      code: "invalid_payload",
      retry: false,
    });
  });
});

describe("applyOrderImportPending", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.order.update.mockResolvedValue({});
    prismaMock.orderImportPending.delete.mockResolvedValue({});
  });

  it("copies cancel, refund, fulfill, and OSP fields then deletes the pending row", async () => {
    const cancelledAt = new Date("2026-08-01T12:00:00.000Z");
    const refundedAt = new Date("2026-08-01T13:00:00.000Z");
    const fulfilledAt = new Date("2026-08-01T14:00:00.000Z");
    const ospStatusSyncedAt = new Date("2026-08-01T15:00:00.000Z");
    prismaMock.orderImportPending.findUnique.mockResolvedValue({
      orderId: 9001n,
      cancelledAt,
      refundedAt,
      fulfilledAt,
      ospStatusName: "Ready",
      ospStatusSyncedAt,
    });

    await expect(applyOrderImportPending(9001n)).resolves.toBe(true);
    expect(prismaMock.order.update).toHaveBeenCalledWith({
      where: { id: 9001n },
      data: {
        cancelledAt,
        refundedAt,
        fulfilledAt,
        ospStatusName: "Ready",
        ospStatusSyncedAt,
      },
    });
    expect(prismaMock.orderImportPending.delete).toHaveBeenCalledWith({
      where: { orderId: 9001n },
    });
  });

  it("deletes an empty pending row without updating the order", async () => {
    prismaMock.orderImportPending.findUnique.mockResolvedValue({
      orderId: 9001n,
      cancelledAt: null,
      refundedAt: null,
      fulfilledAt: null,
      ospStatusName: null,
      ospStatusSyncedAt: null,
    });

    await expect(applyOrderImportPending(9001n)).resolves.toBe(true);
    expect(prismaMock.order.update).not.toHaveBeenCalled();
    expect(prismaMock.orderImportPending.delete).toHaveBeenCalledWith({
      where: { orderId: 9001n },
    });
  });

  it("returns false when there is no pending row", async () => {
    prismaMock.orderImportPending.findUnique.mockResolvedValue(null);

    await expect(applyOrderImportPending(9001n)).resolves.toBe(false);
    expect(prismaMock.order.update).not.toHaveBeenCalled();
    expect(prismaMock.orderImportPending.delete).not.toHaveBeenCalled();
  });
});
