import { prisma } from "../app/db.server";
import { upsertOrderImportPending } from "../app/order-import-pending.server";
import type { WebhookHandlerResult } from "./types.server";

function parseOrderId(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim());
  }
  return null;
}

function parseTimestamp(
  payload: Record<string, unknown>,
  keys: string[],
): Date {
  for (const key of keys) {
    const raw = payload[key];
    if (typeof raw === "string" && raw.trim()) {
      const parsed = new Date(raw);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }
  }
  return new Date();
}

async function markOrderField(
  orderId: bigint,
  field: "cancelledAt" | "refundedAt" | "fulfilledAt",
  at: Date,
): Promise<"updated" | "pending"> {
  const result = await prisma.order.updateMany({
    where: { id: orderId },
    data: { [field]: at },
  });
  if (result.count > 0) return "updated";
  await upsertOrderImportPending(orderId, { [field]: at });
  return "pending";
}

export async function handleOrdersCancelled(
  payload: Record<string, unknown>,
): Promise<WebhookHandlerResult> {
  const orderId = parseOrderId(payload.id);
  if (orderId == null) {
    return {
      outcome: "error",
      code: "invalid_payload",
      message: "orders/cancelled payload missing order id",
      retry: false,
    };
  }

  const at = parseTimestamp(payload, ["cancelled_at", "cancelledAt"]);
  const stored = await markOrderField(orderId, "cancelledAt", at);
  return {
    outcome: "completed",
    detail: stored === "updated" ? "cancelled" : "cancelled pending import",
  };
}

export async function handleOrdersFulfilled(
  payload: Record<string, unknown>,
): Promise<WebhookHandlerResult> {
  const orderId = parseOrderId(payload.id);
  if (orderId == null) {
    return {
      outcome: "error",
      code: "invalid_payload",
      message: "orders/fulfilled payload missing order id",
      retry: false,
    };
  }

  const at = parseTimestamp(payload, ["updated_at", "updatedAt"]);
  const stored = await markOrderField(orderId, "fulfilledAt", at);
  return {
    outcome: "completed",
    detail: stored === "updated" ? "fulfilled" : "fulfilled pending import",
  };
}

export async function handleRefundsCreate(
  payload: Record<string, unknown>,
): Promise<WebhookHandlerResult> {
  const orderId =
    parseOrderId(payload.order_id) ?? parseOrderId(payload.orderId);
  if (orderId == null) {
    return {
      outcome: "error",
      code: "invalid_payload",
      message: "refunds/create payload missing order_id",
      retry: false,
    };
  }

  const stored = await markOrderField(orderId, "refundedAt", new Date());
  return {
    outcome: "completed",
    detail: stored === "updated" ? "refunded" : "refunded pending import",
  };
}
