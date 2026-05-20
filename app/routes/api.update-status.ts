import {
  BULK_STATUS_ORDER_THRESHOLD,
  bulkUpdateOrderStatus,
  RateLimitError,
} from "../order-status-pro.server";
import type { ActionFunctionArgs } from "react-router";

function parseOrderIds(idsRaw: string): bigint[] {
  return idsRaw
    .split(",")
    .map((raw) => raw.trim())
    .map((id) => {
      const segment = id.split("/").pop() || id;
      try {
        return BigInt(segment);
      } catch {
        return null;
      }
    })
    .filter((id): id is bigint => id !== null);
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const idsRaw = formData.get("ids");
  const statusCode = formData.get("status_code");

  if (typeof idsRaw !== "string" || !idsRaw.trim()) {
    return Response.json(
      { success: false, error: "No orders selected" },
      { status: 400 },
    );
  }

  if (typeof statusCode !== "string" || !statusCode) {
    return Response.json(
      { success: false, error: "Status is required" },
      { status: 400 },
    );
  }

  const orderIds = parseOrderIds(idsRaw);
  if (orderIds.length === 0) {
    return Response.json(
      { success: false, error: "No valid order IDs" },
      { status: 400 },
    );
  }

  try {
    const syncedAfter = new Date();
    await bulkUpdateOrderStatus(orderIds, statusCode);
    return Response.json({
      success: true,
      syncedAfter: syncedAfter.toISOString(),
    });
  } catch (error: unknown) {
    if (error instanceof RateLimitError) {
      const rateLimitMessage =
        orderIds.length >= BULK_STATUS_ORDER_THRESHOLD
          ? "Order Status Pro bulk updates are limited to 5 per minute. Wait about a minute and try again."
          : "Order Status Pro rate limit reached. Wait a moment and try again.";
      return Response.json(
        { success: false, error: rateLimitMessage },
        { status: 429 },
      );
    }

    const message =
      error instanceof Error ? error.message : "Bulk update failed";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
};
