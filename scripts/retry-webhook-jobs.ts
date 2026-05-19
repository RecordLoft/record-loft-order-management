/**
 * Inspect webhook failures in the database.
 *
 *   SHOP=your-store.myshopify.com yarn retry:webhooks -- --list --status failed
 *
 * Cron (every 6h) retries failed rows; webhooks process inline on delivery.
 */
import "dotenv/config";
import { listWebhookFailures } from "../app/webhook-queue.server";
import {
  WebhookFailureHandler,
  WebhookFailureStatus,
} from "../generated/prisma/client";

function parseHandler(
  raw: string | undefined,
): WebhookFailureHandler | undefined {
  if (!raw) return undefined;
  const normalized = raw as WebhookFailureHandler;
  if (Object.values(WebhookFailureHandler).includes(normalized)) return normalized;
  console.error(
    `Unknown handler "${raw}". Use: ${Object.values(WebhookFailureHandler).join(", ")}`,
  );
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const statusIndex = argv.indexOf("--status");
  const statusRaw = statusIndex === -1 ? undefined : argv[statusIndex + 1];
  const status =
    statusRaw &&
    Object.values(WebhookFailureStatus).includes(statusRaw as WebhookFailureStatus)
      ? (statusRaw as WebhookFailureStatus)
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
  const failures = await listWebhookFailures(shop, { status, handler, limit });

  if (failures.length === 0) {
    console.log(
      `No webhook failures for ${shop}${status ? ` (${status})` : ""}${handler ? ` handler=${handler}` : ""}.`,
    );
    return;
  }

  console.log(`Webhook failures for ${shop}:\n`);
  for (const row of failures) {
    console.log(
      [
        row.id,
        `handler=${row.handler}`,
        `resource=${row.resourceId}`,
        `topic=${row.topic}`,
        `status=${row.status}`,
        `attempts=${row.attempts}/${row.maxAttempts}`,
        row.outcome ? `outcome=${row.outcome}` : null,
        row.errorCode ? `code=${row.errorCode}` : null,
        row.errorMessage ? `error=${row.errorMessage}` : null,
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
