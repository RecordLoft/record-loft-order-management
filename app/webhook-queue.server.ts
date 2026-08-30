import {
  WebhookFailureHandler,
  WebhookFailureStatus,
} from "../generated/prisma/client";
import { prisma } from "./db.server";
import type { GraphqlRequest } from "./product-description.server";
import { unauthenticated } from "./shopify.server";
import { handleOrdersCreate } from "./webhooks/orders-create.handler.server";
import { handleProductDescriptionSync } from "./webhooks/product-description.handler.server";

const STALE_PROCESSING_MS = 10 * 60 * 1000;
/** Max jobs per admin / CLI retry sweep. */
export const CRON_BATCH_LIMIT = 20;

export const WEBHOOK_HANDLERS = {
  PRODUCT_DESCRIPTION_SYNC: WebhookFailureHandler.product_description_sync,
  ORDERS_CREATE: WebhookFailureHandler.orders_create,
} as const;

export const WEBHOOK_ERROR_CODES = {
  NO_ADMIN_SESSION: "no_admin_session",
  STALE_PROCESSING: "stale_processing",
  UNEXPECTED: "unexpected_error",
  UNKNOWN_HANDLER: "unknown_handler",
} as const;

export type WebhookWorkInput = {
  shop: string;
  handler: WebhookFailureHandler;
  topic: string;
  resourceId: number | bigint;
  resourceGid?: string;
  webhookId?: string | null;
  payload: unknown;
};

export type ProcessWebhookFailuresOptions = {
  limit?: number;
  shop?: string;
  handler?: WebhookFailureHandler;
  graphql?: GraphqlRequest;
};

const ERROR_MESSAGE_MAX_LENGTH = 2000;

/** Shopify admin graphql may throw Response (not Error) via handleClientError. */
async function formatError(error: unknown): Promise<string> {
  if (error instanceof Error) return error.message;
  if (error instanceof Response) {
    let body = "";
    try {
      body = await error.text();
    } catch {
      body = "(could not read response body)";
    }
    const trimmed = body.trim();
    const summary =
      trimmed.length > 0
        ? trimmed.slice(0, ERROR_MESSAGE_MAX_LENGTH)
        : "(empty body)";
    const statusText = error.statusText ? ` ${error.statusText}` : "";
    return `HTTP ${error.status}${statusText}: ${summary}`;
  }
  return String(error);
}

function resourceIdBigInt(input: WebhookWorkInput): bigint {
  return BigInt(input.resourceId);
}

async function graphqlForShop(shop: string): Promise<GraphqlRequest | null> {
  try {
    const { admin } = await unauthenticated.admin(shop);
    return admin.graphql.bind(admin);
  } catch (error) {
    console.error(
      `[webhook-queue] No admin session for ${shop}:`,
      await formatError(error),
    );
    return null;
  }
}

async function runHandler(
  work: { shop: string; handler: WebhookFailureHandler; payload: unknown },
  graphql: GraphqlRequest,
): Promise<
  | { type: "success"; outcome: "completed" | "skipped"; detail: string }
  | { type: "error"; code: string; message: string; detail?: string }
> {
  switch (work.handler) {
    case WebhookFailureHandler.product_description_sync:
      return mapHandlerResult(
        await handleProductDescriptionSync(
          work.shop,
          work.payload as { id: number },
          graphql,
        ),
      );
    case WebhookFailureHandler.orders_create:
      return mapHandlerResult(
        await handleOrdersCreate(work.shop, work.payload as never, graphql),
      );
    default:
      return {
        type: "error",
        code: WEBHOOK_ERROR_CODES.UNKNOWN_HANDLER,
        message: `Unknown handler: ${work.handler}`,
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

async function clearWebhookFailure(input: WebhookWorkInput): Promise<void> {
  await prisma.webhookFailure.deleteMany({
    where: {
      shop: input.shop,
      handler: input.handler,
      resourceId: resourceIdBigInt(input),
    },
  });
}

async function upsertWebhookFailure(
  input: WebhookWorkInput,
  errorCode: string,
  errorMessage: string,
  options: {
    outcome?: string | null;
    attempts: number;
    status: WebhookFailureStatus;
    completedAt?: Date | null;
  },
) {
  const resourceId = resourceIdBigInt(input);

  return prisma.webhookFailure.upsert({
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
      status: options.status,
      outcome: options.outcome ?? null,
      errorCode,
      errorMessage,
      attempts: options.attempts,
      lastAttemptAt: new Date(),
      completedAt: options.completedAt ?? null,
    },
    update: {
      topic: input.topic,
      resourceGid: input.resourceGid ?? undefined,
      webhookId: input.webhookId ?? undefined,
      payload: input.payload as object,
      status: options.status,
      outcome: options.outcome ?? null,
      errorCode,
      errorMessage,
      attempts: options.attempts,
      lastAttemptAt: new Date(),
      completedAt: options.completedAt ?? null,
    },
  });
}

/** Persist when there is no offline session (cron can retry after app install). */
export async function recordWebhookFailureNoSession(input: WebhookWorkInput) {
  return upsertWebhookFailure(
    input,
    WEBHOOK_ERROR_CODES.NO_ADMIN_SESSION,
    "No offline session for shop. Open the app once so a session is saved.",
    {
      status: WebhookFailureStatus.failed,
      attempts: 0,
      completedAt: new Date(),
    },
  );
}

function isPrismaErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

function webhookWorkWriteData(input: WebhookWorkInput) {
  return {
    topic: input.topic,
    resourceGid: input.resourceGid ?? null,
    webhookId: input.webhookId ?? null,
    payload: input.payload as object,
    status: WebhookFailureStatus.pending,
    outcome: null as string | null,
    errorCode: null as string | null,
    errorMessage: null as string | null,
    attempts: 0,
    lastAttemptAt: null as Date | null,
    completedAt: null as Date | null,
  };
}

/**
 * Persist work for Cloud Run coalesce / admin retry. Successes are deleted;
 * failures stay in this table.
 */
export async function enqueueWebhookWork(input: WebhookWorkInput) {
  const resourceId = resourceIdBigInt(input);
  const unique = {
    shop: input.shop,
    handler: input.handler,
    resourceId,
  };
  const fields = webhookWorkWriteData(input);

  try {
    return await prisma.webhookFailure.upsert({
      where: { shop_handler_resourceId: unique },
      create: {
        shop: input.shop,
        handler: input.handler,
        resourceId,
        ...fields,
      },
      update: {
        topic: fields.topic,
        resourceGid: fields.resourceGid ?? undefined,
        webhookId: fields.webhookId ?? undefined,
        payload: fields.payload,
        status: fields.status,
        outcome: fields.outcome,
        errorCode: fields.errorCode,
        errorMessage: fields.errorMessage,
        attempts: fields.attempts,
        lastAttemptAt: fields.lastAttemptAt,
        completedAt: fields.completedAt,
      },
    });
  } catch (error) {
    // Concurrent webhooks for the same product race the unique key.
    if (!isPrismaErrorCode(error, "P2002")) throw error;
    return prisma.webhookFailure.update({
      where: { shop_handler_resourceId: unique },
      data: {
        topic: fields.topic,
        resourceGid: fields.resourceGid ?? undefined,
        webhookId: fields.webhookId ?? undefined,
        payload: fields.payload,
        status: fields.status,
        outcome: fields.outcome,
        errorCode: fields.errorCode,
        errorMessage: fields.errorMessage,
        attempts: fields.attempts,
        lastAttemptAt: fields.lastAttemptAt,
        completedAt: fields.completedAt,
      },
    });
  }
}

/** Never throw to the webhook HTTP handler — Shopify 500s retry and amplify load. */
export async function tryEnqueueWebhookWork(input: WebhookWorkInput) {
  try {
    return { row: await enqueueWebhookWork(input), error: null as string | null };
  } catch (error) {
    const message = await formatError(error);
    console.error(
      `[webhook-queue] enqueue failed shop=${input.shop} ` +
        `handler=${input.handler} resourceId=${input.resourceId} ${message}`,
    );
    return { row: null, error: message };
  }
}

export async function recoverStaleWebhookFailures(): Promise<number> {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const result = await prisma.webhookFailure.updateMany({
    where: {
      status: WebhookFailureStatus.processing,
      lastAttemptAt: { lt: staleBefore },
    },
    data: {
      status: WebhookFailureStatus.pending,
      errorCode: WEBHOOK_ERROR_CODES.STALE_PROCESSING,
      errorMessage: "Job was processing too long; re-queued automatically",
    },
  });
  return result.count;
}

async function recordFailureFromWork(
  input: WebhookWorkInput,
  errorCode: string,
  errorMessage: string,
  outcome: string | null | undefined,
  attempts: number,
  maxAttempts: number,
) {
  const exhausted = attempts >= maxAttempts;
  await upsertWebhookFailure(input, errorCode, errorMessage, {
    outcome: outcome ?? null,
    attempts,
    status: exhausted
      ? WebhookFailureStatus.failed
      : WebhookFailureStatus.pending,
    completedAt: exhausted ? new Date() : null,
  });
}

export type ProcessWebhookWorkResult =
  | { status: "success"; outcome: "completed" | "skipped"; detail: string }
  | { status: "failure"; code: string; message: string };

/**
 * Run the handler immediately (Cloud Run Pub/Sub worker / admin retry).
 */
export async function processWebhookWork(
  input: WebhookWorkInput,
  graphql?: GraphqlRequest,
): Promise<ProcessWebhookWorkResult> {
  const runGraphql = graphql ?? (await graphqlForShop(input.shop));

  if (!runGraphql) {
    await recordWebhookFailureNoSession(input);
    return {
      status: "failure",
      code: WEBHOOK_ERROR_CODES.NO_ADMIN_SESSION,
      message: "No offline session for shop",
    };
  }

  try {
    const result = await runHandler(input, runGraphql);
    if (result.type === "success") {
      await clearWebhookFailure(input);
      return {
        status: "success",
        outcome: result.outcome,
        detail: result.detail,
      };
    }

    await recordFailureFromWork(
      input,
      result.code,
      result.message,
      result.detail,
      1,
      5,
    );
    return {
      status: "failure",
      code: result.code,
      message: result.message,
    };
  } catch (error) {
    const message = await formatError(error);
    await recordFailureFromWork(
      input,
      WEBHOOK_ERROR_CODES.UNEXPECTED,
      message,
      null,
      1,
      5,
    );
    return {
      status: "failure",
      code: WEBHOOK_ERROR_CODES.UNEXPECTED,
      message,
    };
  }
}

export type WebhookFailureJobOutcome = {
  id: string;
  shop: string;
  handler: WebhookFailureHandler;
  resourceId: string;
  attempt: number;
  maxAttempts: number;
} & (
  | { outcome: "completed" | "skipped"; detail: string }
  | { outcome: "failure"; code: string; message: string }
);

export async function processWebhookFailure(
  failureId: string,
  graphql?: GraphqlRequest,
): Promise<WebhookFailureJobOutcome | null> {
  const claimed = await prisma.webhookFailure.updateMany({
    where: {
      id: failureId,
      status: WebhookFailureStatus.pending,
    },
    data: {
      status: WebhookFailureStatus.processing,
      attempts: { increment: 1 },
      lastAttemptAt: new Date(),
    },
  });

  if (claimed.count === 0) return null;

  const row = await prisma.webhookFailure.findUniqueOrThrow({
    where: { id: failureId },
  });
  const work: WebhookWorkInput = {
    shop: row.shop,
    handler: row.handler,
    topic: row.topic,
    resourceId: row.resourceId,
    resourceGid: row.resourceGid ?? undefined,
    webhookId: row.webhookId,
    payload: row.payload,
  };

  const base = {
    id: failureId,
    shop: row.shop,
    handler: row.handler,
    resourceId: String(row.resourceId),
    attempt: row.attempts,
    maxAttempts: row.maxAttempts,
  };

  const logPrefix =
    `[webhook-queue] retry id=${failureId} shop=${row.shop} ` +
    `handler=${row.handler} resourceId=${row.resourceId} ` +
    `attempt=${row.attempts}/${row.maxAttempts}`;

  const runGraphql = graphql ?? (await graphqlForShop(row.shop));

  if (!runGraphql) {
    await recordFailureFromWork(
      work,
      WEBHOOK_ERROR_CODES.NO_ADMIN_SESSION,
      `No offline session for shop ${row.shop}. Open the app on this store once.`,
      null,
      row.attempts,
      row.maxAttempts,
    );
    console.error(`${logPrefix} outcome=failure code=no_admin_session`);
    return {
      ...base,
      outcome: "failure",
      code: WEBHOOK_ERROR_CODES.NO_ADMIN_SESSION,
      message: "No offline session for shop",
    };
  }

  try {
    const result = await runHandler(row, runGraphql);
    if (result.type === "success") {
      await prisma.webhookFailure.delete({ where: { id: failureId } });
      console.log(`${logPrefix} outcome=${result.outcome} detail=${result.detail}`);
      return {
        ...base,
        outcome: result.outcome,
        detail: result.detail,
      };
    }

    await recordFailureFromWork(
      work,
      result.code,
      result.message,
      result.detail,
      row.attempts,
      row.maxAttempts,
    );
    console.error(
      `${logPrefix} outcome=failure code=${result.code} message=${result.message}`,
    );
    return {
      ...base,
      outcome: "failure",
      code: result.code,
      message: result.message,
    };
  } catch (error) {
    const message = await formatError(error);
    await recordFailureFromWork(
      work,
      WEBHOOK_ERROR_CODES.UNEXPECTED,
      message,
      null,
      row.attempts,
      row.maxAttempts,
    );
    console.error(
      `${logPrefix} outcome=failure code=${WEBHOOK_ERROR_CODES.UNEXPECTED} message=${message}`,
    );
    return {
      ...base,
      outcome: "failure",
      code: WEBHOOK_ERROR_CODES.UNEXPECTED,
      message,
    };
  }
}

/**
 * Manual retry from admin: force the row back to pending, then process now.
 * Shop-scoped so one store cannot retry another store's jobs.
 */
export async function retryWebhookFailure(
  failureId: string,
  options: { shop: string; graphql?: GraphqlRequest },
): Promise<WebhookFailureJobOutcome | null> {
  const existing = await prisma.webhookFailure.findFirst({
    where: { id: failureId, shop: options.shop },
    select: { id: true },
  });
  if (!existing) return null;

  await prisma.webhookFailure.update({
    where: { id: failureId },
    data: {
      status: WebhookFailureStatus.pending,
      completedAt: null,
    },
  });

  return processWebhookFailure(failureId, options.graphql);
}

export async function retryWebhookFailuresForShop(
  shop: string,
  options: { limit?: number; ids?: string[] } = {},
): Promise<{
  processed: number;
  jobs: WebhookFailureJobOutcome[];
}> {
  const limit = options.limit ?? CRON_BATCH_LIMIT;
  const rows = await prisma.webhookFailure.findMany({
    where: {
      shop,
      status: {
        in: [WebhookFailureStatus.pending, WebhookFailureStatus.failed],
      },
      ...(options.ids ? { id: { in: options.ids } } : {}),
    },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true },
  });

  const jobs: WebhookFailureJobOutcome[] = [];
  for (const { id } of rows) {
    const job = await retryWebhookFailure(id, { shop });
    if (job) jobs.push(job);
  }

  return { processed: jobs.length, jobs };
}

export async function processPendingWebhookFailures(
  options: ProcessWebhookFailuresOptions = {},
): Promise<{
  processed: number;
  failureIds: string[];
  jobs: WebhookFailureJobOutcome[];
}> {
  await recoverStaleWebhookFailures();

  const limit = options.limit ?? 25;
  const pending = await prisma.webhookFailure.findMany({
    where: {
      status: WebhookFailureStatus.pending,
      ...(options.shop ? { shop: options.shop } : {}),
      ...(options.handler ? { handler: options.handler } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });

  const jobs: WebhookFailureJobOutcome[] = [];
  for (const { id } of pending) {
    const job = await processWebhookFailure(id, options.graphql);
    if (job) jobs.push(job);
  }

  return {
    processed: jobs.length,
    failureIds: jobs.map((job) => job.id),
    jobs,
  };
}

/** Cron: reset terminal failed rows to pending (including no-session retries). */
export async function requeueFailedWebhookFailuresForCron(
  options: { limit?: number } = {},
): Promise<number> {
  const limit = options.limit ?? CRON_BATCH_LIMIT;

  const failed = await prisma.webhookFailure.findMany({
    where: { status: WebhookFailureStatus.failed },
    orderBy: { updatedAt: "asc" },
    take: limit,
    select: { id: true },
  });

  if (failed.length === 0) return 0;

  await prisma.webhookFailure.updateMany({
    where: { id: { in: failed.map((j) => j.id) } },
    data: {
      status: WebhookFailureStatus.pending,
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
  completed: number;
  skipped: number;
  failed: number;
  failureIds: string[];
  jobs: WebhookFailureJobOutcome[];
};

function summarizeJobOutcomes(jobs: WebhookFailureJobOutcome[]) {
  let completed = 0;
  let skipped = 0;
  let failed = 0;
  for (const job of jobs) {
    if (job.outcome === "completed") completed += 1;
    else if (job.outcome === "skipped") skipped += 1;
    else failed += 1;
  }
  return { completed, skipped, failed };
}

function formatJobOutcomeLine(job: WebhookFailureJobOutcome): string {
  const base =
    `id=${job.id} shop=${job.shop} handler=${job.handler} ` +
    `resourceId=${job.resourceId} attempt=${job.attempt}/${job.maxAttempts}`;
  if (job.outcome === "failure") {
    return `${base} outcome=failure code=${job.code} message=${job.message}`;
  }
  return `${base} outcome=${job.outcome} detail=${job.detail}`;
}

/**
 * Drain pending webhook jobs. Terminal `failed` rows stay for admin retry
 * unless `requeueFailed` is set.
 */
export async function runWebhookQueueCron(
  options: { batchSize?: number; requeueFailed?: boolean } = {},
): Promise<WebhookQueueCronResult> {
  const batchSize = options.batchSize ?? CRON_BATCH_LIMIT;
  const staleRecovered = await recoverStaleWebhookFailures();
  const failedRequeued = options.requeueFailed
    ? await requeueFailedWebhookFailuresForCron({
        limit: batchSize,
      })
    : 0;
  const { processed, failureIds, jobs } = await processPendingWebhookFailures({
    limit: batchSize,
  });
  const { completed, skipped, failed } = summarizeJobOutcomes(jobs);

  const result: WebhookQueueCronResult = {
    staleRecovered,
    failedRequeued,
    processed,
    completed,
    skipped,
    failed,
    failureIds,
    jobs,
  };
  const idle =
    staleRecovered === 0 && failedRequeued === 0 && processed === 0;

  if (idle) {
    console.log("[cron/webhook-jobs] idle (no pending failures)");
  } else {
    console.log(
      `[cron/webhook-jobs] staleRecovered=${staleRecovered} ` +
        `failedRequeued=${failedRequeued} processed=${processed} ` +
        `completed=${completed} skipped=${skipped} failed=${failed}` +
        (failureIds.length > 0 ? ` ids=${failureIds.join(",")}` : ""),
    );
    for (const job of jobs) {
      const line = `[cron/webhook-jobs] job ${formatJobOutcomeLine(job)}`;
      if (job.outcome === "failure") console.error(line);
      else console.log(line);
    }
  }

  return result;
}

export async function listWebhookFailures(
  shop: string,
  options?: {
    status?: WebhookFailureStatus;
    handler?: WebhookFailureHandler;
    limit?: number;
  },
) {
  return prisma.webhookFailure.findMany({
    where: {
      shop,
      ...(options?.status ? { status: options.status } : {}),
      ...(options?.handler ? { handler: options.handler } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: options?.limit ?? 100,
  });
}
