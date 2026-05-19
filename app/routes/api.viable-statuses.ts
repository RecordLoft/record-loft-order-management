import {
  fetchViableStatusChoices,
  parseOrderIdParam,
} from "../order-status-pro.server";
import type { LoaderFunctionArgs } from "react-router";

/** Record Planet: OSP viable statuses for the order's Record Planet Shipping tag. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const orderId = parseOrderIdParam(
    new URL(request.url).searchParams.get("id"),
  );
  if (orderId == null) {
    return Response.json({ error: "Order ID is required" }, { status: 400 });
  }

  try {
    return Response.json(await fetchViableStatusChoices(orderId));
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Could not load statuses";
    return Response.json({ error: message }, { status: 500 });
  }
};
