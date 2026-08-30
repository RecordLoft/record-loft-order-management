import { prisma } from "./db.server";

export type OrderImportPendingPatch = {
  cancelledAt?: Date | null;
  refundedAt?: Date | null;
  fulfilledAt?: Date | null;
  ospStatusName?: string | null;
  ospStatusSyncedAt?: Date | null;
};

export async function upsertOrderImportPending(
  orderId: bigint,
  patch: OrderImportPendingPatch,
) {
  return prisma.orderImportPending.upsert({
    where: { orderId },
    create: { orderId, ...patch },
    update: patch,
  });
}

/** Copy pending cancel/refund/fulfill/OSP fields onto the imported order, then drop the pending row. */
export async function applyOrderImportPending(orderId: bigint): Promise<boolean> {
  const pending = await prisma.orderImportPending.findUnique({
    where: { orderId },
  });
  if (!pending) return false;

  const data: OrderImportPendingPatch = {};
  if (pending.cancelledAt) data.cancelledAt = pending.cancelledAt;
  if (pending.refundedAt) data.refundedAt = pending.refundedAt;
  if (pending.fulfilledAt) data.fulfilledAt = pending.fulfilledAt;
  if (pending.ospStatusName) {
    data.ospStatusName = pending.ospStatusName;
    data.ospStatusSyncedAt = pending.ospStatusSyncedAt;
  }

  if (Object.keys(data).length > 0) {
    await prisma.order.update({
      where: { id: orderId },
      data,
    });
  }

  await prisma.orderImportPending.delete({ where: { orderId } });
  return true;
}
