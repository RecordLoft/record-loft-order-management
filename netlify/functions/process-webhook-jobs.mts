import { schedule } from "@netlify/functions";
import { runWebhookQueueCron } from "../../app/webhook-queue.server";

/**
 * Retries rows in WebhookFailure (~4×/day). Webhooks process inline; only
 * failures are persisted and drained here (not via local scripts or waitUntil).
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
