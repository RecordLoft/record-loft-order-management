import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebhookFailureHandler,
  WebhookFailureStatus,
} from "../generated/prisma/client";

const {
  prismaMock,
  handleOrdersCreate,
  handleProductDescriptionSync,
  handleOrdersCancelled,
  handleOrdersFulfilled,
  handleRefundsCreate,
} = vi.hoisted(() => {
  const prismaMock = {
    webhookFailure: {
      updateMany: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  return {
    prismaMock,
    handleOrdersCreate: vi.fn(),
    handleProductDescriptionSync: vi.fn(),
    handleOrdersCancelled: vi.fn(),
    handleOrdersFulfilled: vi.fn(),
    handleRefundsCreate: vi.fn(),
  };
});

vi.mock("../app/db.server", () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: vi.fn() },
}));

vi.mock("../webhooks/orders-create.handler.server", () => ({
  handleOrdersCreate,
}));

vi.mock("../webhooks/product-description.handler.server", () => ({
  handleProductDescriptionSync,
}));

vi.mock("../webhooks/orders-lifecycle.handler.server", () => ({
  handleOrdersCancelled,
  handleOrdersFulfilled,
  handleRefundsCreate,
}));

import {
  PROCESSING_LEASE_MS,
  WEBHOOK_ERROR_CODES,
  claimWebhookWork,
  enqueueWebhookWork,
  releaseWebhookWork,
  isProcessingLeaseExpired,
  listWebhookFailures,
  processWebhookWork,
  processingLeaseCutoff,
  recordAckDrop,
  tryEnqueueWebhookWork,
  type WebhookWorkInput,
} from "../webhooks/queue.server";

const work: WebhookWorkInput = {
  shop: "record-loft.myshopify.com",
  handler: WebhookFailureHandler.orders_create,
  topic: "ORDERS_CREATE",
  resourceId: 42,
  payload: { id: 42 },
};

const graphql = vi.fn(async () => new Response("{}"));

describe("processing lease", () => {
  it("treats a missing lastAttemptAt as expired", () => {
    expect(isProcessingLeaseExpired(null)).toBe(true);
    expect(isProcessingLeaseExpired(undefined)).toBe(true);
  });

  it("is 90 seconds to sit just above the 60s Cloud Run timeout", () => {
    expect(PROCESSING_LEASE_MS).toBe(90_000);
  });

  it("expires after PROCESSING_LEASE_MS", () => {
    const now = 1_700_000_000_000;
    expect(
      isProcessingLeaseExpired(new Date(now - PROCESSING_LEASE_MS), now),
    ).toBe(true);
    expect(
      isProcessingLeaseExpired(new Date(now - PROCESSING_LEASE_MS + 1), now),
    ).toBe(false);
    expect(processingLeaseCutoff(now).getTime()).toBe(now - PROCESSING_LEASE_MS);
  });
});

describe("claimWebhookWork", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims pending or stale processing rows", async () => {
    prismaMock.webhookFailure.updateMany.mockResolvedValue({ count: 1 });
    await expect(claimWebhookWork(work)).resolves.toBe(true);

    const [{ where, data }] = prismaMock.webhookFailure.updateMany.mock.calls[0];
    expect(where.shop).toBe(work.shop);
    expect(where.handler).toBe(work.handler);
    expect(where.resourceId).toBe(BigInt(42));
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { status: { not: WebhookFailureStatus.processing } },
        { status: WebhookFailureStatus.processing, lastAttemptAt: null },
        expect.objectContaining({
          status: WebhookFailureStatus.processing,
          lastAttemptAt: { lte: expect.any(Date) },
        }),
      ]),
    );
    expect(data.status).toBe(WebhookFailureStatus.processing);
    expect(data.lastAttemptAt).toBeInstanceOf(Date);
  });

  it("returns false when another instance holds a live lease", async () => {
    prismaMock.webhookFailure.updateMany.mockResolvedValue({ count: 0 });
    await expect(claimWebhookWork(work)).resolves.toBe(false);
  });
});

describe("releaseWebhookWork", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns a processing row to pending", async () => {
    prismaMock.webhookFailure.updateMany.mockResolvedValue({ count: 1 });
    await expect(releaseWebhookWork(work)).resolves.toBe(true);
    expect(prismaMock.webhookFailure.updateMany).toHaveBeenCalledWith({
      where: {
        shop: work.shop,
        handler: work.handler,
        resourceId: BigInt(42),
        status: WebhookFailureStatus.processing,
      },
      data: { status: WebhookFailureStatus.pending },
    });
  });
});

describe("processWebhookWork", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.webhookFailure.upsert.mockResolvedValue({});
    prismaMock.webhookFailure.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("deletes the row after a successful handler", async () => {
    handleOrdersCreate.mockResolvedValue({
      outcome: "completed",
      detail: "imported",
    });

    await expect(processWebhookWork(work, graphql)).resolves.toEqual({
      status: "success",
      outcome: "completed",
      detail: "imported",
    });
    expect(prismaMock.webhookFailure.deleteMany).toHaveBeenCalled();
    expect(prismaMock.webhookFailure.upsert).not.toHaveBeenCalled();
  });

  it("runs cancel/refund handlers without an admin session", async () => {
    handleOrdersCancelled.mockResolvedValue({
      outcome: "completed",
      detail: "cancelled",
    });
    const cancelWork: WebhookWorkInput = {
      ...work,
      handler: WebhookFailureHandler.orders_cancelled,
      topic: "ORDERS_CANCELLED",
    };
    await expect(processWebhookWork(cancelWork)).resolves.toEqual({
      status: "success",
      outcome: "completed",
      detail: "cancelled",
    });
    expect(handleOrdersCancelled).toHaveBeenCalled();
  });

  it("runs fulfilled handlers without an admin session", async () => {
    handleOrdersFulfilled.mockResolvedValue({
      outcome: "completed",
      detail: "fulfilled",
    });
    const fulfilledWork: WebhookWorkInput = {
      ...work,
      handler: WebhookFailureHandler.orders_fulfilled,
      topic: "ORDERS_FULFILLED",
    };
    await expect(processWebhookWork(fulfilledWork)).resolves.toEqual({
      status: "success",
      outcome: "completed",
      detail: "fulfilled",
    });
    expect(handleOrdersFulfilled).toHaveBeenCalled();
  });

  it("retries a retryable handler error before max attempts", async () => {
    handleOrdersCreate.mockResolvedValue({
      outcome: "error",
      code: "graphql_errors",
      message: "blip",
      retry: true,
    });
    prismaMock.webhookFailure.findUnique.mockResolvedValue({
      attempts: 0,
      maxAttempts: 5,
    });

    await expect(processWebhookWork(work, graphql)).resolves.toEqual({
      status: "failure",
      code: "graphql_errors",
      message: "blip",
      retry: true,
    });
    expect(prismaMock.webhookFailure.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: WebhookFailureStatus.pending,
          attempts: 1,
        }),
      }),
    );
  });

  it("acks to the DLQ when the handler is not retryable", async () => {
    handleProductDescriptionSync.mockResolvedValue({
      outcome: "error",
      code: "product_not_found",
      message: "gone",
      retry: false,
    });

    const productWork: WebhookWorkInput = {
      ...work,
      handler: WebhookFailureHandler.product_description_sync,
      topic: "PRODUCTS_UPDATE",
    };

    await expect(processWebhookWork(productWork, graphql)).resolves.toEqual({
      status: "failure",
      code: "product_not_found",
      message: "gone",
      retry: false,
    });
    expect(prismaMock.webhookFailure.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: WebhookFailureStatus.failed,
        }),
      }),
    );
  });

  it("stops retrying after max attempts", async () => {
    handleOrdersCreate.mockResolvedValue({
      outcome: "error",
      code: "graphql_errors",
      message: "still failing",
      retry: true,
    });
    prismaMock.webhookFailure.findUnique.mockResolvedValue({
      attempts: 4,
      maxAttempts: 5,
    });

    await expect(processWebhookWork(work, graphql)).resolves.toMatchObject({
      status: "failure",
      retry: false,
    });
    expect(prismaMock.webhookFailure.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: WebhookFailureStatus.failed,
          attempts: 5,
        }),
      }),
    );
  });

  it("does not retry when there is no offline session", async () => {
    const { unauthenticated } = await import("../app/shopify.server");
    vi.mocked(unauthenticated.admin).mockRejectedValue(new Error("no session"));

    await expect(processWebhookWork(work)).resolves.toEqual({
      status: "failure",
      code: WEBHOOK_ERROR_CODES.NO_ADMIN_SESSION,
      message: "No offline session for shop",
      retry: false,
    });
  });

  it("deletes the row when the handler skips", async () => {
    handleProductDescriptionSync.mockResolvedValue({
      outcome: "skipped",
      detail: "skipped",
    });
    const productWork: WebhookWorkInput = {
      ...work,
      handler: WebhookFailureHandler.product_description_sync,
      topic: "PRODUCTS_UPDATE",
    };

    await expect(processWebhookWork(productWork, graphql)).resolves.toEqual({
      status: "success",
      outcome: "skipped",
      detail: "skipped",
    });
    expect(prismaMock.webhookFailure.deleteMany).toHaveBeenCalled();
  });

  it("acks ack_drop as a non-retryable unknown handler", async () => {
    const dropWork: WebhookWorkInput = {
      ...work,
      handler: WebhookFailureHandler.ack_drop,
      topic: "unknown",
    };

    await expect(processWebhookWork(dropWork, graphql)).resolves.toEqual({
      status: "failure",
      code: WEBHOOK_ERROR_CODES.UNKNOWN_HANDLER,
      message: "ack_drop is not a runnable handler",
      retry: false,
    });
    expect(prismaMock.webhookFailure.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: WebhookFailureStatus.failed,
        }),
      }),
    );
  });

  it("retries unexpected throws before max attempts", async () => {
    handleOrdersCreate.mockRejectedValue(new Error("boom"));
    prismaMock.webhookFailure.findUnique.mockResolvedValue({
      attempts: 1,
      maxAttempts: 5,
    });

    await expect(processWebhookWork(work, graphql)).resolves.toEqual({
      status: "failure",
      code: WEBHOOK_ERROR_CODES.UNEXPECTED,
      message: "boom",
      retry: true,
    });
  });

  it("formats thrown Response bodies as HTTP errors", async () => {
    handleOrdersCreate.mockRejectedValue(
      new Response("gateway timeout", { status: 504, statusText: "Gateway Timeout" }),
    );
    prismaMock.webhookFailure.findUnique.mockResolvedValue({
      attempts: 0,
      maxAttempts: 5,
    });

    await expect(processWebhookWork(work, graphql)).resolves.toMatchObject({
      status: "failure",
      code: WEBHOOK_ERROR_CODES.UNEXPECTED,
      message: "HTTP 504 Gateway Timeout: gateway timeout",
    });
  });
});

describe("enqueueWebhookWork", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.webhookFailure.upsert.mockResolvedValue({});
    prismaMock.webhookFailure.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.webhookFailure.findUniqueOrThrow.mockResolvedValue({
      id: "row-1",
      status: WebhookFailureStatus.pending,
    });
  });

  it("upserts work and resurrects a failed DLQ row", async () => {
    await enqueueWebhookWork(work);
    expect(prismaMock.webhookFailure.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          shop: work.shop,
          handler: work.handler,
          resourceId: BigInt(42),
          status: WebhookFailureStatus.pending,
          attempts: 0,
        }),
      }),
    );
    expect(prismaMock.webhookFailure.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        status: WebhookFailureStatus.failed,
      }),
      data: {
        status: WebhookFailureStatus.pending,
        attempts: 0,
        completedAt: null,
      },
    });
  });

  it("falls back to update on a unique-key race", async () => {
    const race = Object.assign(new Error("unique"), { code: "P2002" });
    prismaMock.webhookFailure.upsert.mockRejectedValueOnce(race);
    prismaMock.webhookFailure.update.mockResolvedValue({});

    await enqueueWebhookWork(work);
    expect(prismaMock.webhookFailure.update).toHaveBeenCalled();
  });

  it("rethrows unexpected upsert errors", async () => {
    prismaMock.webhookFailure.upsert.mockRejectedValue(new Error("db down"));
    await expect(enqueueWebhookWork(work)).rejects.toThrow("db down");
  });

  it("tryEnqueueWebhookWork swallows enqueue errors", async () => {
    prismaMock.webhookFailure.upsert.mockRejectedValue(new Error("db down"));
    await expect(tryEnqueueWebhookWork(work)).resolves.toEqual({
      row: null,
      error: "db down",
    });
  });
});

describe("recordAckDrop and listWebhookFailures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prismaMock.webhookFailure.upsert.mockResolvedValue({ id: "drop-1" });
    prismaMock.webhookFailure.findMany.mockResolvedValue([]);
  });

  it("stores invalid messages as failed ack_drop rows", async () => {
    await recordAckDrop({
      shop: "record-loft.myshopify.com",
      topic: "products/update",
      resourceId: 9,
      reason: "payload missing id",
      payload: { title: "x" },
      webhookId: "wh-a",
    });
    expect(prismaMock.webhookFailure.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          handler: WebhookFailureHandler.ack_drop,
          status: WebhookFailureStatus.failed,
          errorCode: "ack_drop",
          errorMessage: "payload missing id",
        }),
      }),
    );
    const firstId = prismaMock.webhookFailure.upsert.mock.calls[0]?.[0]?.create
      ?.resourceId as bigint;

    await recordAckDrop({
      shop: "record-loft.myshopify.com",
      topic: "products/update",
      reason: "payload missing id",
      webhookId: "wh-b",
    });
    const secondId = prismaMock.webhookFailure.upsert.mock.calls[1]?.[0]?.create
      ?.resourceId as bigint;
    expect(firstId).not.toEqual(secondId);
    expect(firstId).not.toBe(0n);
  });

  it("lists failures for a shop with optional filters", async () => {
    await listWebhookFailures("record-loft.myshopify.com", {
      status: WebhookFailureStatus.failed,
      handler: WebhookFailureHandler.orders_create,
      limit: 10,
    });
    expect(prismaMock.webhookFailure.findMany).toHaveBeenCalledWith({
      where: {
        shop: "record-loft.myshopify.com",
        status: { in: [WebhookFailureStatus.failed] },
        handler: WebhookFailureHandler.orders_create,
      },
      orderBy: { updatedAt: "desc" },
      take: 10,
    });
  });
});
