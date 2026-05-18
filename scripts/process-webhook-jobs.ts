/**
 * Run one webhook queue cron tick locally (same logic as /api/cron/webhook-jobs).
 *
 *   yarn process:webhooks
 */
import "dotenv/config";
import { runWebhookQueueCron } from "../app/webhook-queue.server";

async function main() {
  const result = await runWebhookQueueCron();
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
