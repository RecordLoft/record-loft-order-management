import {
  WebhookFailureHandler,
  WebhookFailureStatus,
  type WebhookFailure,
} from "../generated/prisma/client";
import { prisma } from "./db.server";
import type { GraphqlRequest } from "./product-description.server";
import { unauthenticated } from "./shopify.server";
import { handleOrdersCreate } from "./webhooks/orders-create.handler.server";
import { handleProductDescriptionSync } from "./webhooks/product-description.handler.server";

const STALE_PROCESSING_MS = 10 * 60 * 1000;
/** Max failures per cron tick (avoids function timeout / API rate limits). */
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
  work: Pick<
    WebhookFailure,
    "shop" | "handler" | "payload"
  >,
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

/**
 * Run handler during the webhook request. Success clears any stored failure;
 * errors are upserted for scheduled cron retry (not processed locally).
 */
export async function processWebhookWork(
  input: WebhookWorkInput,
  graphql?: GraphqlRequest,
): Promise<"success" | "failure"> {
  const runGraphql = graphql ?? (await graphqlForShop(input.shop));

  if (!runGraphql) {
    await recordWebhookFailureNoSession(input);
    return "failure";
  }

  try {
    const result = await runHandler(input, runGraphql);
    if (result.type === "success") {
      await clearWebhookFailure(input);
      return "success";
    }

    await recordFailureFromWork(
      input,
      result.code,
      result.message,
      result.detail,
      1,
      5,
    );
    return "failure";
  } catch (error) {
    await recordFailureFromWork(
      input,
      WEBHOOK_ERROR_CODES.UNEXPECTED,
      await formatError(error),
      null,
      1,
      5,
    );
    return "failure";
  }
}

export async function processWebhookFailure(
  failureId: string,
  graphql?: GraphqlRequest,
): Promise<boolean> {
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

  if (claimed.count === 0) return false;

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
    return true;
  }

  try {
    const result = await runHandler(row, runGraphql);
    if (result.type === "success") {
      await prisma.webhookFailure.delete({ where: { id: failureId } });
      return true;
    }

    await recordFailureFromWork(
      work,
      result.code,
      result.message,
      result.detail,
      row.attempts,
      row.maxAttempts,
    );
  } catch (error) {
    await recordFailureFromWork(
      work,
      WEBHOOK_ERROR_CODES.UNEXPECTED,
      await formatError(error),
      null,
      row.attempts,
      row.maxAttempts,
    );
  }

  return true;
}

export async function processPendingWebhookFailures(
  options: ProcessWebhookFailuresOptions = {},
): Promise<{ processed: number; failureIds: string[] }> {
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

  const failureIds: string[] = [];
  for (const { id } of pending) {
    const ran = await processWebhookFailure(id, options.graphql);
    if (ran) failureIds.push(id);
  }

  return { processed: failureIds.length, failureIds };
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
  failureIds: string[];
};

/**
 * Scheduled recovery only — retries rows in WebhookFailure (not used on happy path).
 */
export async function runWebhookQueueCron(
  options: { batchSize?: number } = {},
): Promise<WebhookQueueCronResult> {
  const batchSize = options.batchSize ?? CRON_BATCH_LIMIT;
  const staleRecovered = await recoverStaleWebhookFailures();
  const failedRequeued = await requeueFailedWebhookFailuresForCron({
    limit: batchSize,
  });
  const { processed, failureIds } = await processPendingWebhookFailures({
    limit: batchSize,
  });

  return { staleRecovered, failedRequeued, processed, failureIds };
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
