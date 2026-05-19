import {
  ordersMatchCachedStatus,
  ordersSyncedSince,
  parseOrderIdsParam,
} from "../order-status-pro.server";
import { authenticate } from "../shopify.server";
import type { LoaderFunctionArgs } from "react-router";

/** Poll whether the webhook refreshed cache after a bulk status update. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const orderIds = parseOrderIdsParam(url.searchParams.get("ids"));
  const sinceRaw = url.searchParams.get("since");
  const since = sinceRaw ? new Date(sinceRaw) : null;
  const expectedStatusName = url.searchParams.get("status_name")?.trim() ?? "";

  if (orderIds.length === 0 || !since || Number.isNaN(since.getTime())) {
    return Response.json(
      { error: "Missing ids or since" },
      { status: 400 },
    );
  }

  const syncedByTimestamp = await ordersSyncedSince(orderIds, since);
  const syncedByName =
    !syncedByTimestamp && expectedStatusName
      ? await ordersMatchCachedStatus(orderIds, expectedStatusName)
      : false;

  return Response.json({ synced: syncedByTimestamp || syncedByName });
};
