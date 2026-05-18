import {
  WebhookJobHandler,
  WebhookJobStatus,
  type WebhookJob,
} from "../generated/prisma/client";
import { prisma } from "./db.server";
import type { GraphqlRequest } from "./product-description.server";
import { unauthenticated } from "./shopify.server";
import { handleOrdersCreate } from "./webhooks/orders-create.handler.server";
import { handleProductDescriptionSync } from "./webhooks/product-description.handler.server";

const STALE_PROCESSING_MS = 10 * 60 * 1000;
/** Max jobs per cron tick (avoids function timeout / API rate limits — not invocation count). */
export const CRON_BATCH_LIMIT = 20;

export const WEBHOOK_HANDLERS = {
  PRODUCT_DESCRIPTION_SYNC: WebhookJobHandler.product_description_sync,
  ORDERS_CREATE: WebhookJobHandler.orders_create,
} as const;

export const WEBHOOK_ERROR_CODES = {
  NO_ADMIN_SESSION: "no_admin_session",
  STALE_PROCESSING: "stale_processing",
  UNEXPECTED: "unexpected_error",
  UNKNOWN_HANDLER: "unknown_handler",
} as const;

export type EnqueueWebhookJobInput = {
  shop: string;
  handler: WebhookJobHandler;
  topic: string;
  resourceId: number | bigint;
  resourceGid?: string;
  webhookId?: string | null;
  payload: unknown;
};

export type ProcessWebhookJobsOptions = {
  limit?: number;
  shop?: string;
  handler?: WebhookJobHandler;
  graphql?: GraphqlRequest;
};

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function graphqlForShop(shop: string): Promise<GraphqlRequest | null> {
  try {
    const { admin } = await unauthenticated.admin(shop);
    return admin.graphql.bind(admin);
  } catch (error) {
    console.error(
      `[webhook-queue] No admin session for ${shop}:`,
      formatError(error),
    );
    return null;
  }
}

async function runHandler(
  job: WebhookJob,
  graphql: GraphqlRequest,
): Promise<
  | { type: "success"; outcome: "completed" | "skipped"; detail: string }
  | { type: "error"; code: string; message: string; detail?: string }
> {
  switch (job.handler) {
    case WebhookJobHandler.product_description_sync:
      return mapHandlerResult(
        await handleProductDescriptionSync(
          job.shop,
          job.payload as { id: number },
          graphql,
        ),
      );
    case WebhookJobHandler.orders_create:
      return mapHandlerResult(
        await handleOrdersCreate(job.shop, job.payload as never, graphql),
      );
    default:
      return {
        type: "error",
        code: WEBHOOK_ERROR_CODES.UNKNOWN_HANDLER,
        message: `Unknown handler: ${job.handler}`,
      };
  }
}

function mapHandlerResult(
  result: Awaited<ReturnType<typeof handleProductDescriptionSync>>,
):
  | { type: "success"; outcome: "completed" | "skipped"; detail: string }
  | { type: "error"; code: string; message: string; detail?: string } {
  if (result.outcome === "completed") {
    return { type: "success", outcome: "completed", detail: result.detail };
  }
  if (result.outcome === "skipped") {
    return { type: "success", outcome: "skipped", detail: result.detail };
  }
  return {
    type: "error",
    code: result.code,
    message: result.message,
    detail: "error",
  };
}

export async function recoverStaleWebhookJobs(): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const result = await prisma.webhookJob.updateMany({
    where: {
      status: WebhookJobStatus.processing,
      lastAttemptAt: { lt: staleBefore },
    },
    data: {
      status: WebhookJobStatus.pending,
      errorCode: WEBHOOK_ERROR_CODES.STALE_PROCESSING,
      errorMessage: "Job was processing too long; re-queued automatically",
    },
  });
  return result.count;
}

export async function enqueueWebhookJobNoSession(input: EnqueueWebhookJobInput) {
  const resourceId = BigInt(input.resourceId);

  return prisma.webhookJob.upsert({
    where: {
      shop_handler_resourceId: {
        shop: input.shop,
        handler: input.handler,
        resourceId,
      },
    },
    create: {
      shop: input.shop,
      handler: input.handler,
      topic: input.topic,
      resourceId,
      resourceGid: input.resourceGid ?? null,
      webhookId: input.webhookId ?? null,
      payload: input.payload as object,
      status: WebhookJobStatus.failed,
      errorCode: WEBHOOK_ERROR_CODES.NO_ADMIN_SESSION,
      errorMessage:
        "No offline session for shop. Open the app once so a session is saved.",
      completedAt: new Date(),
    },
    update: {
      topic: input.topic,
      resourceGid: input.resourceGid ?? undefined,
      webhookId: input.webhookId ?? undefined,
      payload: input.payload as object,
      status: WebhookJobStatus.failed,
      outcome: null,
      errorCode: WEBHOOK_ERROR_CODES.NO_ADMIN_SESSION,
      errorMessage:
        "No offline session for shop. Open the app once so a session is saved.",
      completedAt: new Date(),
    },
  });
}

export async function enqueueWebhookJob(input: EnqueueWebhookJobInput) {
  const resourceId = BigInt(input.resourceId);

  return prisma.webhookJob.upsert({
    where: {
      shop_handler_resourceId: {
        shop: input.shop,
        handler: input.handler,
        resourceId,
      },
    },
    create: {
      shop: input.shop,
      handler: input.handler,
      topic: input.topic,
      resourceId,
      resourceGid: input.resourceGid ?? null,
      webhookId: input.webhookId ?? null,
      payload: input.payload as object,
      status: WebhookJobStatus.pending,
    },
    update: {
      topic: input.topic,
      resourceGid: input.resourceGid ?? undefined,
      webhookId: input.webhookId ?? undefined,
      payload: input.payload as object,
      status: WebhookJobStatus.pending,
      outcome: null,
      errorCode: null,
      errorMessage: null,
      completedAt: null,
      attempts: 0,
    },
  });
}

async function markJobFailed(
  jobId: string,
  errorCode: string,
  errorMessage: string,
  outcome?: string | null,
) {
  const job = await prisma.webhookJob.findUnique({ where: { id: jobId } });
  if (!job) return;

  const exhausted = job.attempts >= job.maxAttempts;

  await prisma.webhookJob.update({
    where: { id: jobId },
    data: {
      status: exhausted ? WebhookJobStatus.failed : WebhookJobStatus.pending,
      outcome: outcome ?? null,
      errorCode,
      errorMessage,
      completedAt: exhausted ? new Date() : null,
    },
  });
}

async function markJobSuccess(
  jobId: string,
  status: "completed" | "skipped",
  outcome: string,
) {
  await prisma.webhookJob.update({
    where: { id: jobId },
    data: {
      status:
        status === "skipped"
          ? WebhookJobStatus.skipped
          : WebhookJobStatus.completed,
      outcome,
      errorCode: null,
      errorMessage: null,
      completedAt: new Date(),
    },
  });
}

export async function processWebhookJob(
  jobId: string,
  graphql?: GraphqlRequest,
): Promise<boolean> {
  const claimed = await prisma.webhookJob.updateMany({
    where: {
      id: jobId,
      status: WebhookJobStatus.pending,
    },
    data: {
      status: WebhookJobStatus.processing,
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
    },
  });

  if (claimed.count === 0) return false;

  const job = await prisma.webhookJob.findUniqueOrThrow({ where: { id: jobId } });
  const runGraphql = graphql ?? (await graphqlForShop(job.shop));

  if (!runGraphql) {
    await markJobFailed(
      jobId,
      WEBHOOK_ERROR_CODES.NO_ADMIN_SESSION,
      `No offline session for shop ${job.shop}. Open the app on this store once.`,
    );
    return true;
  }

  try {
    const result = await runHandler(job, runGraphql);
    if (result.type === "success") {
      await markJobSuccess(jobId, result.outcome, result.detail);
    } else {
      await markJobFailed(jobId, result.code, result.message, result.detail);
    }
  } catch (error) {
    await markJobFailed(
      jobId,
      WEBHOOK_ERROR_CODES.UNEXPECTED,
      formatError(error),
    );
  }

  return true;
}

export async function processPendingWebhookJobs(
  options: ProcessWebhookJobsOptions = {},
): Promise<{ processed: number; jobIds: string[] }> {
  await recoverStaleWebhookJobs();

  const limit = options.limit ?? 25;
  const pending = await prisma.webhookJob.findMany({
    where: {
      status: WebhookJobStatus.pending,
      ...(options.shop ? { shop: options.shop } : {}),
      ...(options.handler ? { handler: options.handler } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });

  const jobIds: string[] = [];
  for (const { id } of pending) {
    const ran = await processWebhookJob(id, options.graphql);
    if (ran) jobIds.push(id);
  }

  return { processed: jobIds.length, jobIds };
}

/** Cron: reset failed jobs to pending (including no-session retries). */
export async function requeueFailedWebhookJobsForCron(
  options: { limit?: number } = {},
): Promise<number> {
  const limit = options.limit ?? CRON_BATCH_LIMIT;

  const failed = await prisma.webhookJob.findMany({
    where: { status: WebhookJobStatus.failed },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true },
  });

  if (failed.length === 0) return 0;

  await prisma.webhookJob.updateMany({
    where: { id: { in: failed.map((j) => j.id) } },
    data: {
      status: WebhookJobStatus.pending,
      outcome: null,
      errorCode: null,
      errorMessage: null,
      completedAt: null,
      attempts: 0,
    },
  });

  return failed.length;
}

export type WebhookQueueCronResult = {
  staleRecovered: number;
  failedRequeued: number;
  processed: number;
  jobIds: string[];
};

/**
 * Scheduled recovery only — for jobs the webhook invocation did not finish
 * (failed, stale processing, or waitUntil timed out). Not used on the happy path.
 */
export async function runWebhookQueueCron(
  options: { batchSize?: number } = {},
): Promise<WebhookQueueCronResult> {
  const batchSize = options.batchSize ?? CRON_BATCH_LIMIT;
  const staleRecovered = await recoverStaleWebhookJobs();
  const failedRequeued = await requeueFailedWebhookJobsForCron({
    limit: batchSize,
  });
  const { processed, jobIds } = await processPendingWebhookJobs({
    limit: batchSize,
  });

  return { staleRecovered, failedRequeued, processed, jobIds };
}

type WaitUntilContext = { waitUntil?: (promise: Promise<unknown>) => void };

/**
 * Try to process this job in the same serverless invocation as the webhook (via
 * waitUntil after the 200 response). Does not start a second Netlify function.
 */
export function scheduleImmediateWebhookJobProcessing(
  context: WaitUntilContext,
  jobId: string,
  graphql?: GraphqlRequest,
) {
  const work = processWebhookJob(jobId, graphql).then((ran) => {
    console.log(
      `[webhook-queue] Immediate job ${jobId}: ${ran ? "processed" : "skipped (not pending)"}`,
    );
  });

  if (typeof context.waitUntil === "function") {
    context.waitUntil(work);
  } else {
    void work;
  }
}

export async function listWebhookJobs(
  shop: string,
  options?: {
    status?: WebhookJobStatus;
    handler?: WebhookJobHandler;
    limit?: number;
  },
) {
  return prisma.webhookJob.findMany({
    where: {
      shop,
      ...(options?.status ? { status: options.status } : {}),
      ...(options?.handler ? { handler: options.handler } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: options?.limit ?? 100,
  });
}
