import { schedule } from "@netlify/functions";
import { runWebhookQueueCron } from "../../app/webhook-queue.server";

/**
 * Recovery-only scheduled function (~4×/day). Webhooks already return 200 and
 * process via waitUntil in the main SSR handler; this drains failed/pending backlog.
 *
 * Set WEBHOOK_CRON_ENABLED=false to disable (~120 invocations/month saved).
 */
export const handler = schedule("0 */6 * * *", async () => {
  if (process.env.WEBHOOK_CRON_ENABLED === "false") {
    console.log("[cron] WEBHOOK_CRON_ENABLED=false, skipping");
    return;
  }

  const result = await runWebhookQueueCron();
  console.log("[cron]", JSON.stringify(result));
});
