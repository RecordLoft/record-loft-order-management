import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookFailureHandler } from "../generated/prisma/client";

const {
  prismaMock,
  tryEnqueueWebhookWork,
  claimWebhookWork,
  processWebhookWork,
  recordAckDrop,
  releaseWebhookWork,
} = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
  },
  tryEnqueueWebhookWork: vi.fn(),
  claimWebhookWork: vi.fn(),
  processWebhookWork: vi.fn(),
  recordAckDrop: vi.fn(),
  releaseWebhookWork: vi.fn(),
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
  releaseWebhookWork,
}));

import { closeDb } from "../app/db.server";
import {
  allowedTopicsFromEnv,
  drainAndExit,
  handlePush,
  handleWorkerRequest,
  releaseClaimedWork,
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
  init?: { method?: string; url?: string; headers?: Record<string, string> },
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return Object.assign(Readable.from([raw]), {
    method: init?.method ?? "POST",
    url: init?.url ?? "/",
    headers: { host: "localhost", ...init?.headers },
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
      "orders/cancelled",
      "orders/fulfilled",
      "refunds/create",
    ]);
    expect(allowedTopicsFromEnv("orders/create")).toEqual(
      new Set(["orders/create"]),
    );
  });
});

describe("handlePush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerState.claimedWork = null;
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

    const oversized = mockRes();
    const huge = "x".repeat(2_000_001);
    await handlePush(requestFrom(huge) as never, oversized as never);
    expect(oversized.statusCode).toBe(200);
    expect(oversized.body).toEqual({ status: "ignored", reason: "body too large" });
    expect(recordAckDrop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "body too large" }),
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

  it("returns 500 when ack-drop persist fails so Pub/Sub retries", async () => {
    recordAckDrop.mockRejectedValue(new Error("db down"));
    const res = mockRes();
    await handlePush(requestFrom("{") as never, res as never);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      status: "ack_drop_persist_failed",
      reason: "invalid json",
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

  it("writes structured JSON with outcome fields and request trace", async () => {
    const lines: unknown[] = [];
    const info = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      lines.push(JSON.parse(String(line)));
    });
    const res = mockRes();
    await handlePush(
      requestFrom(productPush, {
        headers: { "x-cloud-trace-context": "abc123def/1;o=1" },
      }) as never,
      res as never,
    );
    info.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "INFO",
          message: expect.stringMatching(
            /^\[pubsub-worker\] webhook completed topic=products\/update shop=record-loft\.myshopify\.com resourceId=7 messageId=m-1 source=shopify-publish outcome=completed detail=updated latencyMs=\d+$/,
          ),
          component: "pubsub-worker",
          topic: "products/update",
          shop: "record-loft.myshopify.com",
          resourceId: "7",
          messageId: "m-1",
          source: "shopify-publish",
          outcome: "completed",
          "logging.googleapis.com/trace":
            "projects/record-loft/traces/abc123def",
        }),
      ]),
    );
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

  it("ack-drops topics outside ALLOWED_TOPICS", async () => {
    const previous = process.env.ALLOWED_TOPICS;
    process.env.ALLOWED_TOPICS = "orders/create";
    try {
      const res = mockRes();
      await handlePush(requestFrom(productPush) as never, res as never);
      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        status: "ignored",
        reason: "topic products/update not allowed",
      });
      expect(recordAckDrop).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "topic products/update not allowed" }),
      );
      expect(tryEnqueueWebhookWork).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        delete process.env.ALLOWED_TOPICS;
      } else {
        process.env.ALLOWED_TOPICS = previous;
      }
    }
  });
});

describe("handleWorkerRequest", () => {
  beforeEach(() => {
    workerState.shuttingDown = false;
    workerState.inFlight = 0;
    workerState.claimedWork = null;
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

  it("accepts Pub/Sub pushes on /pubsub", async () => {
    tryEnqueueWebhookWork.mockResolvedValue({ row: { id: "1" }, error: null });
    claimWebhookWork.mockResolvedValue(true);
    processWebhookWork.mockResolvedValue({
      status: "success",
      outcome: "completed",
      detail: "updated",
    });
    const res = mockRes();
    handleWorkerRequest(
      requestFrom(productPush, { method: "POST", url: "/pubsub" }) as never,
      res as never,
    );
    await vi.waitFor(() => {
      expect(res.statusCode).toBe(200);
    });
    expect(res.body).toMatchObject({ status: "completed" });
  });
});

describe("releaseClaimedWork", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workerState.claimedWork = null;
    releaseWebhookWork.mockResolvedValue(true);
  });

  it("releases the claimed row and clears worker state", async () => {
    const claimed = {
      shop: "record-loft.myshopify.com",
      handler: WebhookFailureHandler.orders_create,
      topic: "ORDERS_CREATE",
      resourceId: 7,
      payload: { id: 7 },
    };
    workerState.claimedWork = claimed;
    await releaseClaimedWork();
    expect(releaseWebhookWork).toHaveBeenCalledWith(claimed);
    expect(workerState.claimedWork).toBeNull();
  });

  it("no-ops when nothing is claimed", async () => {
    await releaseClaimedWork();
    expect(releaseWebhookWork).not.toHaveBeenCalled();
  });
});

describe("drainAndExit", () => {
  beforeEach(() => {
    workerState.inFlight = 0;
    vi.mocked(closeDb).mockResolvedValue(undefined);
  });

  it("closes the db and exits 0 when nothing is in flight", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    drainAndExit();
    await vi.waitFor(() => {
      expect(closeDb).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(0);
    });
    exit.mockRestore();
  });

  it("exits 1 when the drain deadline passes with work still in flight", async () => {
    workerState.inFlight = 1;
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    drainAndExit(Date.now() - 1);
    await vi.waitFor(() => {
      expect(closeDb).toHaveBeenCalled();
      expect(exit).toHaveBeenCalledWith(1);
    });
    exit.mockRestore();
  });
});
