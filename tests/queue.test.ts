import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebhookFailureHandler,
  WebhookFailureStatus,
} from "../generated/prisma/client";

const {
  prismaMock,
  handleOrdersCreate,
  handleProductDescriptionSync,
} = vi.hoisted(() => {
  const prismaMock = {
    webhookFailure: {
      updateMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  return {
    prismaMock,
    handleOrdersCreate: vi.fn(),
    handleProductDescriptionSync: vi.fn(),
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

import {
  PROCESSING_LEASE_MS,
  WEBHOOK_ERROR_CODES,
  claimWebhookWork,
  isProcessingLeaseExpired,
  processWebhookWork,
  processingLeaseCutoff,
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
});
