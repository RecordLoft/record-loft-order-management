import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebhookFailureHandler,
  WebhookFailureStatus,
} from "../generated/prisma/client";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    webhookFailure: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("../app/db.server", () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: vi.fn() },
  authenticate: { admin: vi.fn(), webhook: vi.fn() },
}));

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createSign: () => ({
      update() {
        return this;
      },
      sign: () => Buffer.from("signature"),
    }),
  };
});

import {
  redriveSkipReason,
  republishWebhookFailures,
} from "../app/webhook-retry-publish.server";

const shop = "record-loft.myshopify.com";

describe("redriveSkipReason", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("explains missing, dropped, live-processing, and pending rows", async () => {
    prismaMock.webhookFailure.findFirst.mockResolvedValue(null);
    await expect(redriveSkipReason(shop, "missing")).resolves.toBe(
      "Dead letter not found.",
    );

    prismaMock.webhookFailure.findFirst.mockResolvedValue({
      status: WebhookFailureStatus.failed,
      lastAttemptAt: null,
      handler: WebhookFailureHandler.ack_drop,
    });
    await expect(redriveSkipReason(shop, "drop")).resolves.toBe(
      "Dropped messages cannot be redriven.",
    );

    prismaMock.webhookFailure.findFirst.mockResolvedValue({
      status: WebhookFailureStatus.processing,
      lastAttemptAt: new Date(),
      handler: WebhookFailureHandler.orders_create,
    });
    await expect(redriveSkipReason(shop, "live")).resolves.toBe(
      "Still processing. Wait until the 90s lease expires.",
    );

    prismaMock.webhookFailure.findFirst.mockResolvedValue({
      status: WebhookFailureStatus.pending,
      lastAttemptAt: null,
      handler: WebhookFailureHandler.orders_create,
    });
    await expect(redriveSkipReason(shop, "pending")).resolves.toBe(
      "Already queued for retry.",
    );
  });
});

describe("republishWebhookFailures", () => {
  const previousJson = process.env.GCP_PUBSUB_SA_JSON;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GCP_PUBSUB_SA_JSON = JSON.stringify({
      client_email: "publisher@record-loft.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
    });
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env.GCP_PUBSUB_SA_JSON = previousJson;
    vi.unstubAllGlobals();
  });

  it("returns zero when nothing is redriveable", async () => {
    prismaMock.webhookFailure.findMany.mockResolvedValue([]);
    await expect(republishWebhookFailures(shop)).resolves.toEqual({
      queued: 0,
      ids: [],
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("publishes by topic and resets attempts", async () => {
    prismaMock.webhookFailure.findMany.mockResolvedValue([
      {
        id: "a",
        shop,
        handler: WebhookFailureHandler.product_description_sync,
        topic: "PRODUCTS_UPDATE",
        webhookId: "wh-1",
        payload: { id: 1 },
      },
      {
        id: "b",
        shop,
        handler: WebhookFailureHandler.orders_create,
        topic: "ORDERS_CREATE",
        webhookId: null,
        payload: { id: 2 },
      },
    ]);
    prismaMock.webhookFailure.updateMany.mockResolvedValue({ count: 2 });
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValue(
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    await expect(republishWebhookFailures(shop)).resolves.toEqual({
      queued: 2,
      ids: ["a", "b"],
    });

    const publishUrls = vi
      .mocked(fetch)
      .mock.calls.slice(1)
      .map(([url]) => String(url));
    expect(publishUrls).toEqual(
      expect.arrayContaining([
        expect.stringContaining("topics/shopify-products:publish"),
        expect.stringContaining("topics/shopify-orders:publish"),
      ]),
    );
    expect(prismaMock.webhookFailure.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["a", "b"] } },
      data: {
        status: WebhookFailureStatus.pending,
        attempts: 0,
        completedAt: null,
      },
    });
  });

  it("requires a publish service account and a Pub/Sub token", async () => {
    delete process.env.GCP_PUBSUB_SA_JSON;
    prismaMock.webhookFailure.findMany.mockResolvedValue([
      {
        id: "a",
        shop,
        handler: WebhookFailureHandler.orders_create,
        topic: "ORDERS_CREATE",
        webhookId: null,
        payload: { id: 2 },
      },
    ]);
    await expect(republishWebhookFailures(shop)).rejects.toThrow(
      "GCP_PUBSUB_SA_JSON is not configured",
    );

    process.env.GCP_PUBSUB_SA_JSON = JSON.stringify({
      client_email: "publisher@record-loft.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("denied", { status: 403 }),
    );
    await expect(republishWebhookFailures(shop)).rejects.toThrow(
      "Failed to get a Pub/Sub token",
    );
  });
});
