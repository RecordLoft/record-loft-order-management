import {
  WebhookFailureHandler,
  WebhookFailureStatus,
} from "../generated/prisma/client";
import { prisma } from "../app/db.server";
import type { GraphqlRequest } from "./product-description.server";
import { unauthenticated } from "../app/shopify.server";
import { handleOrdersCreate } from "./orders-create.handler.server";
import { handleProductDescriptionSync } from "./product-description.handler.server";

export const WEBHOOK_ERROR_CODES = {
  NO_ADMIN_SESSION: "no_admin_session",
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

/** Persist when there is no offline session (admin can republish after install). */
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
      },
    });
  } catch (error) {
    // Concurrent webhooks for the same product race the unique key.
    if (!isPrismaErrorCode(error, "P2002")) throw error;
    await prisma.webhookFailure.update({
      where: { shop_handler_resourceId: unique },
      data: {
        topic: fields.topic,
        resourceGid: fields.resourceGid ?? undefined,
        webhookId: fields.webhookId ?? undefined,
        payload: fields.payload,
      },
    });
  }

  // A new Shopify event on a DLQ row gets a full retry cycle, same as Redrive.
  await prisma.webhookFailure.updateMany({
    where: {
      shop: unique.shop,
      handler: unique.handler,
      resourceId: unique.resourceId,
      status: WebhookFailureStatus.failed,
    },
    data: {
      status: WebhookFailureStatus.pending,
      attempts: 0,
      completedAt: null,
    },
  });

  return prisma.webhookFailure.findUniqueOrThrow({
    where: { shop_handler_resourceId: unique },
  });
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

async function nextAttempt(input: WebhookWorkInput) {
  const row = await prisma.webhookFailure.findUnique({
    where: {
      shop_handler_resourceId: {
        shop: input.shop,
        handler: input.handler,
        resourceId: resourceIdBigInt(input),
      },
    },
    select: { attempts: true, maxAttempts: true },
  });
  const attempts = (row?.attempts ?? 0) + 1;
  const maxAttempts = row?.maxAttempts ?? 5;
  return { attempts, maxAttempts, retry: attempts < maxAttempts };
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
  | { status: "failure"; code: string; message: string; retry: boolean };

/** Run the handler immediately on Cloud Run. */
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
      retry: false,
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

    const { attempts, maxAttempts, retry } = await nextAttempt(input);
    await recordFailureFromWork(
      input,
      result.code,
      result.message,
      result.detail,
      attempts,
      maxAttempts,
    );
    return {
      status: "failure",
      code: result.code,
      message: result.message,
      retry,
    };
  } catch (error) {
    const message = await formatError(error);
    const { attempts, maxAttempts, retry } = await nextAttempt(input);
    await recordFailureFromWork(
      input,
      WEBHOOK_ERROR_CODES.UNEXPECTED,
      message,
      null,
      attempts,
      maxAttempts,
    );
    return {
      status: "failure",
      code: WEBHOOK_ERROR_CODES.UNEXPECTED,
      message,
      retry,
    };
  }
}

export async function listWebhookFailures(
  shop: string,
  options?: {
    status?: WebhookFailureStatus;
    statuses?: WebhookFailureStatus[];
    handler?: WebhookFailureHandler;
    limit?: number;
  },
) {
  const statuses = options?.statuses ?? (options?.status ? [options.status] : undefined);
  return prisma.webhookFailure.findMany({
    where: {
      shop,
      ...(statuses ? { status: { in: statuses } } : {}),
      ...(options?.handler ? { handler: options.handler } : {}),
    },
    orderBy: { updatedAt: "desc" },
    take: options?.limit ?? 100,
  });
}
