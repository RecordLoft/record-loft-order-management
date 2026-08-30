import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, upsertOrderImportPending } = vi.hoisted(() => ({
  prismaMock: {
    order: { updateMany: vi.fn(), findUnique: vi.fn() },
  },
  upsertOrderImportPending: vi.fn(),
}));

vi.mock("../app/db.server", () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock("../app/order-import-pending.server", () => ({
  upsertOrderImportPending,
}));

import {
  handleOrdersCancelled,
  handleOrdersFulfilled,
  handleRefundsCreate,
  isFullOrderRefund,
} from "../webhooks/orders-lifecycle.handler.server";

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
    await expect(
      handleOrdersCancelled({
        id: 9001,
        cancelled_at: "2026-08-01T12:00:00.000Z",
      }),
    ).resolves.toEqual({ outcome: "completed", detail: "cancelled" });
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
    await expect(
      handleOrdersFulfilled({
        id: 9001,
        updated_at: "2026-08-02T12:00:00.000Z",
      }),
    ).resolves.toEqual({ outcome: "completed", detail: "fulfilled" });
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
    await expect(handleRefundsCreate(fullRefundPayload)).resolves.toEqual({
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
