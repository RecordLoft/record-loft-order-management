import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookFailureHandler } from "../generated/prisma/client";

const {
  prismaMock,
  tryEnqueueWebhookWork,
  claimWebhookWork,
  processWebhookWork,
  recordAckDrop,
} = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
  },
  tryEnqueueWebhookWork: vi.fn(),
  claimWebhookWork: vi.fn(),
  processWebhookWork: vi.fn(),
  recordAckDrop: vi.fn(),
}));

vi.mock("../app/db.server", () => ({
  prisma: prismaMock,
  closeDb: vi.fn(),
  default: prismaMock,
}));

vi.mock("../webhooks/queue.server", () => ({
  tryEnqueueWebhookWork,
  claimWebhookWork,
  processWebhookWork,
  recordAckDrop,
}));

import {
  allowedTopicsFromEnv,
  handlePush,
  handleWorkerRequest,
  workerState,
} from "../webhooks/worker.server";

function envelope(payload: unknown, attributes: Record<string, string>) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      attributes,
      messageId: "m-1",
    },
  };
}

function requestFrom(
  body: unknown | string,
  init?: { method?: string; url?: string },
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return Object.assign(Readable.from([raw]), {
    method: init?.method ?? "POST",
    url: init?.url ?? "/",
    headers: { host: "localhost" },
  });
}

function mockRes() {
  return {
    statusCode: 0,
    body: null as unknown,
    writeHead(status: number) {
      this.statusCode = status;
    },
    end(json: string) {
      this.body = JSON.parse(json);
    },
  };
}

const productPush = envelope(
  { id: 7 },
  {
    "X-Shopify-Topic": "products/update",
    "X-Shopify-Shop-Domain": "record-loft.myshopify.com",
  },
);

describe("allowedTopicsFromEnv", () => {
  it("defaults to products and orders create/update", () => {
    expect([...allowedTopicsFromEnv(undefined)]).toEqual([
      "products/create",
      "products/update",
      "orders/create",
    ]);
    expect(allowedTopicsFromEnv("orders/create")).toEqual(
      new Set(["orders/create"]),
    );
  });
});

describe("handlePush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordAckDrop.mockResolvedValue({});
    tryEnqueueWebhookWork.mockResolvedValue({ row: { id: "1" }, error: null });
    claimWebhookWork.mockResolvedValue(true);
    processWebhookWork.mockResolvedValue({
      status: "success",
      outcome: "completed",
      detail: "updated",
    });
  });

  it("200-acks invalid JSON and unknown topics after recording ack_drop", async () => {
    const invalid = mockRes();
    await handlePush(requestFrom("{") as never, invalid as never);
    expect(invalid.statusCode).toBe(200);
    expect(invalid.body).toEqual({ status: "ignored", reason: "invalid json" });
    expect(recordAckDrop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "invalid json" }),
    );

    const unknown = mockRes();
    await handlePush(
      requestFrom(
        envelope(
          { id: 1 },
          {
            "X-Shopify-Topic": "app/uninstalled",
            "X-Shopify-Shop-Domain": "record-loft.myshopify.com",
          },
        ),
      ) as never,
      unknown as never,
    );
    expect(unknown.statusCode).toBe(200);
    expect(unknown.body).toMatchObject({
      status: "ignored",
      reason: "unsupported topic app/uninstalled",
    });
  });

  it("returns 500 when enqueue fails or the row is already claimed", async () => {
    tryEnqueueWebhookWork.mockResolvedValue({ row: null, error: "db down" });
    const enqueueFailed = mockRes();
    await handlePush(requestFrom(productPush) as never, enqueueFailed as never);
    expect(enqueueFailed.statusCode).toBe(500);
    expect(enqueueFailed.body).toEqual({
      status: "enqueue_failed",
      message: "db down",
    });

    tryEnqueueWebhookWork.mockResolvedValue({ row: { id: "1" }, error: null });
    claimWebhookWork.mockResolvedValue(false);
    const busy = mockRes();
    await handlePush(requestFrom(productPush) as never, busy as never);
    expect(busy.statusCode).toBe(500);
    expect(busy.body).toEqual({ status: "busy" });
  });

  it("acks success and terminal failures, and 500s retryable failures", async () => {
    const success = mockRes();
    await handlePush(requestFrom(productPush) as never, success as never);
    expect(success.statusCode).toBe(200);
    expect(success.body).toMatchObject({ status: "completed" });
    expect(processWebhookWork).toHaveBeenCalledWith(
      expect.objectContaining({
        handler: WebhookFailureHandler.product_description_sync,
        resourceId: 7,
      }),
    );

    processWebhookWork.mockResolvedValue({
      status: "failure",
      code: "product_not_found",
      message: "gone",
      retry: false,
    });
    const dlq = mockRes();
    await handlePush(requestFrom(productPush) as never, dlq as never);
    expect(dlq.statusCode).toBe(200);
    expect(dlq.body).toEqual({
      status: "dlq",
      code: "product_not_found",
      message: "gone",
    });

    processWebhookWork.mockResolvedValue({
      status: "failure",
      code: "graphql_errors",
      message: "blip",
      retry: true,
    });
    const retry = mockRes();
    await handlePush(requestFrom(productPush) as never, retry as never);
    expect(retry.statusCode).toBe(500);
    expect(retry.body).toMatchObject({ status: "failure", code: "graphql_errors" });
  });

  it("tags admin retries without treating the header as a security bypass", async () => {
    const res = mockRes();
    await handlePush(
      requestFrom(
        envelope(
          { id: 7 },
          {
            "X-Shopify-Topic": "products/update",
            "X-Shopify-Shop-Domain": "record-loft.myshopify.com",
            "X-Retry-Source": "admin",
          },
        ),
      ) as never,
      res as never,
    );
    expect(res.statusCode).toBe(200);
    expect(tryEnqueueWebhookWork).toHaveBeenCalled();
  });
});

describe("handleWorkerRequest", () => {
  beforeEach(() => {
    workerState.shuttingDown = false;
    workerState.inFlight = 0;
    prismaMock.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  });

  it("serves liveness and health", async () => {
    const live = mockRes();
    handleWorkerRequest(requestFrom("", { method: "GET", url: "/" }) as never, live as never);
    expect(live.statusCode).toBe(200);
    expect(live.body).toEqual({ ok: true });

    const health = mockRes();
    handleWorkerRequest(
      requestFrom("", { method: "GET", url: "/health" }) as never,
      health as never,
    );
    await vi.waitFor(() => {
      expect(health.statusCode).toBe(200);
    });
    expect(health.body).toEqual({ ok: true, db: true });
  });

  it("returns 503 when the database health check fails", async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error("down"));
    const health = mockRes();
    handleWorkerRequest(
      requestFrom("", { method: "GET", url: "/health" }) as never,
      health as never,
    );
    await vi.waitFor(() => {
      expect(health.statusCode).toBe(503);
    });
    expect(health.body).toEqual({ ok: false, db: false });
  });

  it("rejects pushes while shutting down and 404s unknown paths", () => {
    workerState.shuttingDown = true;
    const down = mockRes();
    handleWorkerRequest(requestFrom(productPush) as never, down as never);
    expect(down.statusCode).toBe(503);
    expect(down.body).toEqual({ status: "shutting_down" });

    workerState.shuttingDown = false;
    const missing = mockRes();
    handleWorkerRequest(
      requestFrom("", { method: "GET", url: "/nope" }) as never,
      missing as never,
    );
    expect(missing.statusCode).toBe(404);
  });
});
