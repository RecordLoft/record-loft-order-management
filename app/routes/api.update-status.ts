import {
  bulkUpdateOrderStatus,
  RateLimitError,
} from "app/order-status-pro.server";
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
  const statusName = formData.get("status_name");

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
    await bulkUpdateOrderStatus(
      orderIds,
      statusCode,
      typeof statusName === "string" && statusName ? statusName : undefined,
    );
    return { success: true };
  } catch (error: unknown) {
    if (error instanceof RateLimitError) {
      return Response.json(
        {
          success: false,
          error:
            "Order Status Pro rate limit reached. Wait about 10 seconds and try again.",
        },
        { status: 429 },
      );
    }

    const message =
      error instanceof Error ? error.message : "Bulk update failed";
    return Response.json({ success: false, error: message }, { status: 500 });
  }
};
