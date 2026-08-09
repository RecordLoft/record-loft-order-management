import { authorizeCronRequest } from "../cron.server";
import { prisma } from "../db.server";
import { consumeColdStartFlag, msSince } from "../request-timing.server";
import type { Route } from "./+types/api.health";

export const loader = async ({ request }: Route.LoaderArgs) => {
  authorizeCronRequest(request);

  const totalStart = performance.now();
  const cold = consumeColdStartFlag();

  // Load inside loader so React Router strips it from the client bundle,
  // while still warming the same modules webhooks use.
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
