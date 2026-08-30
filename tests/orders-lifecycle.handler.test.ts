import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, upsertOrderImportPending } = vi.hoisted(() => ({
  prismaMock: {
    order: { updateMany: vi.fn() },
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
} from "../webhooks/orders-lifecycle.handler.server";

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

describe("handleRefundsCreate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.order.updateMany.mockResolvedValue({ count: 1 });
  });

  it("sets refundedAt from order_id", async () => {
    await expect(
      handleRefundsCreate({ id: 55, order_id: 9001 }),
    ).resolves.toEqual({ outcome: "completed", detail: "refunded" });
    expect(prismaMock.order.updateMany).toHaveBeenCalledWith({
      where: { id: 9001n },
      data: { refundedAt: expect.any(Date) },
    });
  });

  it("stores pending refund when the order is not imported yet", async () => {
    prismaMock.order.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      handleRefundsCreate({ id: 55, order_id: 9001 }),
    ).resolves.toEqual({
      outcome: "completed",
      detail: "refunded pending import",
    });
    expect(upsertOrderImportPending).toHaveBeenCalledWith(
      9001n,
      expect.objectContaining({ refundedAt: expect.any(Date) }),
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
