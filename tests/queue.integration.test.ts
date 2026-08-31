import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebhookFailureHandler,
  WebhookFailureStatus,
} from "../generated/prisma/client";

vi.mock("../app/shopify.server", () => ({
  unauthenticated: { admin: vi.fn() },
  authenticate: { admin: vi.fn(), webhook: vi.fn() },
}));

import { prisma } from "../app/db.server";
import {
  claimWebhookWork,
  enqueueWebhookWork,
  recordAckDrop,
  type WebhookWorkInput,
} from "../webhooks/queue.server";
import { INTEGRATION_SHOP, resetIntegrationDb } from "./integration-db";

const work: WebhookWorkInput = {
  shop: INTEGRATION_SHOP,
  handler: WebhookFailureHandler.product_description_sync,
  topic: "PRODUCTS_UPDATE",
  resourceId: 42,
  payload: { id: 42 },
};

describe("webhook queue against Postgres", () => {
  beforeEach(async () => {
    await resetIntegrationDb();
  });

  it("coalesces the same shop/handler/resource into one row", async () => {
    await enqueueWebhookWork(work);
    await enqueueWebhookWork({ ...work, payload: { id: 42, title: "updated" } });

    const rows = await prisma.webhookFailure.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      shop: INTEGRATION_SHOP,
      handler: WebhookFailureHandler.product_description_sync,
      resourceId: 42n,
      payload: { id: 42, title: "updated" },
      status: WebhookFailureStatus.pending,
    });
  });

  it("resurrects a failed DLQ row on a new Shopify event", async () => {
    const created = await enqueueWebhookWork(work);
    await prisma.webhookFailure.update({
      where: { id: created.id },
      data: {
        status: WebhookFailureStatus.failed,
        attempts: 5,
        completedAt: new Date(),
      },
    });

    await enqueueWebhookWork(work);
    const row = await prisma.webhookFailure.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.status).toBe(WebhookFailureStatus.pending);
    expect(row.attempts).toBe(0);
    expect(row.completedAt).toBeNull();
  });

  it("does not steal a live processing lease on enqueue", async () => {
    const created = await enqueueWebhookWork(work);
    await prisma.webhookFailure.update({
      where: { id: created.id },
      data: {
        status: WebhookFailureStatus.processing,
        attempts: 2,
        lastAttemptAt: new Date(),
      },
    });

    await enqueueWebhookWork({ ...work, payload: { id: 42, title: "echo" } });
    const row = await prisma.webhookFailure.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.status).toBe(WebhookFailureStatus.processing);
    expect(row.attempts).toBe(2);
    expect(row.payload).toEqual({ id: 42, title: "echo" });
    await expect(claimWebhookWork(work)).resolves.toBe(false);
  });

  it("lets a second instance steal a processing row after the 90s lease", async () => {
    const created = await enqueueWebhookWork(work);
    await prisma.webhookFailure.update({
      where: { id: created.id },
      data: {
        status: WebhookFailureStatus.processing,
        lastAttemptAt: new Date(Date.now() - 91_000),
      },
    });

    await expect(claimWebhookWork(work)).resolves.toBe(true);
    const row = await prisma.webhookFailure.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(row.status).toBe(WebhookFailureStatus.processing);
  });

  it("stores distinct ack_drop rows instead of overwriting poison messages", async () => {
    await recordAckDrop({
      shop: INTEGRATION_SHOP,
      topic: "products/update",
      reason: "payload missing id",
      webhookId: "wh-a",
    });
    await recordAckDrop({
      shop: INTEGRATION_SHOP,
      topic: "products/update",
      reason: "payload missing id",
      webhookId: "wh-b",
    });

    const rows = await prisma.webhookFailure.findMany({
      where: { handler: WebhookFailureHandler.ack_drop },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.resourceId.toString())).size).toBe(2);
  });
});
