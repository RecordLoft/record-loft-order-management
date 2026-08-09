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

  try {
    const result = JSON.parse(body) as {
      staleRecovered?: number;
      failedRequeued?: number;
      processed?: number;
      completed?: number;
      skipped?: number;
      failed?: number;
      jobs?: Array<{
        id: string;
        shop: string;
        handler: string;
        resourceId: string;
        attempt: number;
        maxAttempts: number;
        outcome: "completed" | "skipped" | "failure";
        detail?: string;
        code?: string;
        message?: string;
      }>;
    };

    const processed = result.processed ?? 0;
    const idle =
      (result.staleRecovered ?? 0) === 0 &&
      (result.failedRequeued ?? 0) === 0 &&
      processed === 0;

    if (idle) {
      console.log(
        `[cron/process-webhook-jobs] ok status=${response.status} idle (no pending failures)`,
      );
    } else {
      console.log(
        `[cron/process-webhook-jobs] ok status=${response.status} ` +
          `staleRecovered=${result.staleRecovered ?? 0} ` +
          `failedRequeued=${result.failedRequeued ?? 0} ` +
          `processed=${processed} completed=${result.completed ?? 0} ` +
          `skipped=${result.skipped ?? 0} failed=${result.failed ?? 0}`,
      );
      for (const job of result.jobs ?? []) {
        const base =
          `id=${job.id} shop=${job.shop} handler=${job.handler} ` +
          `resourceId=${job.resourceId} attempt=${job.attempt}/${job.maxAttempts}`;
        if (job.outcome === "failure") {
          console.error(
            `[cron/process-webhook-jobs] job ${base} outcome=failure ` +
              `code=${job.code ?? "unknown"} message=${job.message ?? ""}`,
          );
        } else {
          console.log(
            `[cron/process-webhook-jobs] job ${base} outcome=${job.outcome} ` +
              `detail=${job.detail ?? ""}`,
          );
        }
      }
    }
  } catch {
    console.log(
      `[cron/process-webhook-jobs] ok status=${response.status} body=${body.slice(0, 500)}`,
    );
  }

  return new Response(body, { status: 200 });
};

export const config: Config = {
  schedule: "0 */6 * * *",
};
