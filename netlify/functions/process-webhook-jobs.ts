import type { Config } from "@netlify/functions";
import { fetchAppPath } from "../lib/site-url";

/**
 * Retries rows in WebhookFailure (~4×/day). Invokes the RR app over HTTP so
 * Shopify/Prisma run in the System function (avoids Netlify bundle init crash
 * from importing app code here).
 *
 * Set WEBHOOK_CRON_ENABLED=false to disable (~120 invocations/month saved).
 */
export default async () => {
  if (process.env.WEBHOOK_CRON_ENABLED === "false") {
    console.log("[cron/process-webhook-jobs] disabled (WEBHOOK_CRON_ENABLED=false)");
    return new Response("skipped", { status: 200 });
  }

  const response = await fetchAppPath("/api/cron/webhook-jobs", {
    method: "POST",
  });
  const body = await response.text();

  if (!response.ok) {
    console.error(
      `[cron/process-webhook-jobs] request failed status=${response.status} body=${body.slice(0, 500)}`,
    );
    return new Response(body, { status: response.status });
  }

  // App route logs idle/work detail; keep Netlify side to status only.
  console.log(`[cron/process-webhook-jobs] ok status=${response.status}`);
  return new Response(body, { status: 200 });
};

export const config: Config = {
  schedule: "0 */6 * * *",
};
