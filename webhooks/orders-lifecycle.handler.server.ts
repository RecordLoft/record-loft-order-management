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

type LineQuantity = { id: bigint; quantity: number };

function payloadFinancialStatus(
  payload: Record<string, unknown>,
): string | null {
  const nested =
    payload.order && typeof payload.order === "object"
      ? (payload.order as Record<string, unknown>)
      : null;
  const raw = payload.financial_status ?? nested?.financial_status;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim().toLowerCase();
}

function refundLineQuantities(payload: Record<string, unknown>): {
  refunded: Map<string, number>;
  originals: Map<string, number>;
} {
  const refunded = new Map<string, number>();
  const originals = new Map<string, number>();
  const items = payload.refund_line_items;
  if (!Array.isArray(items)) return { refunded, originals };

  for (const raw of items) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const nested =
      item.line_item && typeof item.line_item === "object"
        ? (item.line_item as Record<string, unknown>)
        : null;
    const id = parseOrderId(item.line_item_id) ?? parseOrderId(nested?.id);
    if (id == null) continue;
    const key = id.toString();
    const qty = Number(item.quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    refunded.set(key, (refunded.get(key) ?? 0) + qty);
    const original = Number(nested?.quantity);
    if (Number.isFinite(original) && original > 0) {
      originals.set(key, Math.max(originals.get(key) ?? 0, original));
    }
  }
  return { refunded, originals };
}

/** True only for a complete order refund. Shipping-only or line-item subsets stay Active. */
export function isFullOrderRefund(
  payload: Record<string, unknown>,
  orderLineItems?: LineQuantity[] | null,
): boolean {
  const status = payloadFinancialStatus(payload);
  if (status === "refunded") return true;
  if (status === "partially_refunded") return false;

  const { refunded, originals } = refundLineQuantities(payload);
  if (refunded.size === 0) return false;

  if (orderLineItems && orderLineItems.length > 0) {
    return orderLineItems.every((line) => {
      const got = refunded.get(line.id.toString()) ?? 0;
      return got >= line.quantity;
    });
  }

  if (originals.size === 0) return false;
  for (const [id, qty] of refunded) {
    const original = originals.get(id);
    if (original == null || qty < original) return false;
  }
  return true;
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

  const imported = await prisma.order.findUnique({
    where: { id: orderId },
    select: { lineItems: { select: { id: true, quantity: true } } },
  });
  if (!isFullOrderRefund(payload, imported?.lineItems)) {
    return { outcome: "completed", detail: "partial refund" };
  }

  const at = parseTimestamp(payload, ["processed_at", "created_at", "createdAt"]);
  const stored = await markOrderField(orderId, "refundedAt", at);
  return {
    outcome: "completed",
    detail: stored === "updated" ? "refunded" : "refunded pending import",
  };
}
