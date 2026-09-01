import { authorizeCronRequest } from "../cron.server";
import { prisma } from "../db.server";
import { consumeColdStartFlag, msSince } from "../request-timing.server";
import type { Route } from "./+types/api.health";

/** Keep-warm target (`CRON_SECRET`). Loads `shopify.server` and `Session.count`. */
export const loader = async ({ request }: Route.LoaderArgs) => {
  authorizeCronRequest(request);

  const totalStart = performance.now();
  const cold = consumeColdStartFlag();

  // Inside the loader so React Router keeps it off the client bundle.
  await import("../shopify.server");

  const dbStart = performance.now();
  const sessionCount = await prisma.session.count();
  const dbMs = msSince(dbStart);
  const totalMs = msSince(totalStart);

  console.log(
    `[health] timing cold=${cold} dbMs=${dbMs} totalMs=${totalMs} sessions=${sessionCount}`,
  );

  return Response.json({
    ok: true,
    cold,
    dbMs,
    totalMs,
    sessions: sessionCount,
  });
};
