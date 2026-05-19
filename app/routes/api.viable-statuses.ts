import { fetchStatusChoices } from "../order-status-pro.server";
import type { LoaderFunctionArgs } from "react-router";

/** Record Planet uses the same status list for every order (GET /statuses). */
export const loader = async (_args: LoaderFunctionArgs) => {
  try {
    return Response.json(await fetchStatusChoices());
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Could not load statuses";
    return Response.json({ error: message }, { status: 500 });
  }
};
