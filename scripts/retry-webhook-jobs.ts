/**
 * Inspect webhook queue jobs in the database.
 *
 *   SHOP=your-store.myshopify.com yarn retry:webhooks -- --list --status failed
 *
 * Cron (every 6h) retries failed jobs; webhooks process immediately via waitUntil.
 * Run a cron tick locally: yarn process:webhooks
 */
import "dotenv/config";
import { listWebhookJobs } from "../app/webhook-queue.server";
import {
  WebhookJobHandler,
  WebhookJobStatus,
} from "../generated/prisma/client";

function parseHandler(raw: string | undefined): WebhookJobHandler | undefined {
  if (!raw) return undefined;
  const normalized = raw as WebhookJobHandler;
  if (Object.values(WebhookJobHandler).includes(normalized)) return normalized;
  console.error(
    `Unknown handler "${raw}". Use: ${Object.values(WebhookJobHandler).join(", ")}`,
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const statusIndex = argv.indexOf("--status");
  const statusRaw = statusIndex === -1 ? undefined : argv[statusIndex + 1];
  const status =
    statusRaw &&
    Object.values(WebhookJobStatus).includes(statusRaw as WebhookJobStatus)
      ? (statusRaw as WebhookJobStatus)
      : undefined;

  const handlerIndex = argv.indexOf("--handler");
  const handler = parseHandler(
    handlerIndex === -1 ? undefined : argv[handlerIndex + 1],
  );

  return {
    status,
    handler,
    limit: (() => {
      const index = argv.indexOf("--limit");
      if (index === -1) return 100;
      const value = Number(argv[index + 1]);
      return Number.isFinite(value) && value > 0 ? value : 100;
    })(),
  };
}

async function main() {
  const shop = process.env.SHOP?.trim();
  if (!shop) {
    console.error("SHOP is required (e.g. SHOP=your-store.myshopify.com)");
    process.exit(1);
  }

  const { status, handler, limit } = parseArgs(process.argv.slice(2));
  const jobs = await listWebhookJobs(shop, { status, handler, limit });

  if (jobs.length === 0) {
    console.log(
      `No jobs for ${shop}${status ? ` (${status})` : ""}${handler ? ` handler=${handler}` : ""}.`,
    );
    return;
  }

  console.log(`Webhook jobs for ${shop}:\n`);
  for (const job of jobs) {
    console.log(
      [
        job.id,
        `handler=${job.handler}`,
        `resource=${job.resourceId}`,
        `topic=${job.topic}`,
        `status=${job.status}`,
        `attempts=${job.attempts}/${job.maxAttempts}`,
        job.outcome ? `outcome=${job.outcome}` : null,
        job.errorCode ? `code=${job.errorCode}` : null,
        job.errorMessage ? `error=${job.errorMessage}` : null,
      ]
        .filter(Boolean)
        .join(" | "),
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
