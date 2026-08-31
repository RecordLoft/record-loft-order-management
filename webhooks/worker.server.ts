/**
 * Cloud Run Pub/Sub push worker. Deploy via .github/workflows/deploy-webhooks.yml.
 * Manual fallback: docs/deploy-webhooks.md
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { closeDb, prisma } from "../app/db.server";
import {
  ackDropContext,
  isAdminRetry,
  parsePubSubPush,
  type PubSubPushEnvelope,
} from "./parse-pubsub";
import {
  log,
  runWithLogContext,
  traceHeaderFromRequest,
} from "./log.server";
import {
  claimWebhookWork,
  processWebhookWork,
  recordAckDrop,
  releaseWebhookWork,
  tryEnqueueWebhookWork,
  type WebhookWorkInput,
} from "./queue.server";

const PORT = Number(process.env.PORT || 8080);

export function allowedTopicsFromEnv(
  raw = process.env.ALLOWED_TOPICS,
): Set<string> {
  return new Set(
    (raw ?? "products/create,products/update,orders/create,orders/cancelled,orders/fulfilled,refunds/create")
      .split(",")
      .map((topic) => topic.trim().toLowerCase())
      .filter(Boolean),
  );
}

export const workerState = {
  shuttingDown: false,
  inFlight: 0,
  claimedWork: null as WebhookWorkInput | null,
};

export const MAX_PUSH_BODY_BYTES = 2_000_000;
export const DRAIN_TIMEOUT_MS = 50_000;

export class BodyTooLargeError extends Error {
  constructor() {
    super("body too large");
    this.name = "BodyTooLargeError";
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_PUSH_BODY_BYTES) {
      throw new BodyTooLargeError();
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  return JSON.parse(raw) as unknown;
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function persistAckDrop(
  envelope: PubSubPushEnvelope,
  reason: string,
): Promise<boolean> {
  const context = ackDropContext(envelope);
  try {
    await recordAckDrop({ ...context, reason });
    return true;
  } catch (error) {
    log.error({
      component: "pubsub-worker",
      message: "ack-drop persist failed",
      reason,
      error,
    });
    return false;
  }
}

function sendAckDrop(
  res: ServerResponse,
  reason: string,
  persisted: boolean,
) {
  if (!persisted) {
    send(res, 500, { status: "ack_drop_persist_failed", reason });
    return;
  }
  send(res, 200, { status: "ignored", reason });
}

export async function releaseClaimedWork(): Promise<void> {
  const work = workerState.claimedWork;
  if (!work) return;
  workerState.claimedWork = null;
  try {
    await releaseWebhookWork(work);
  } catch (error) {
    log.error({
      component: "pubsub-worker",
      message: "release claimed work failed",
      error,
    });
  }
}

async function handlePushInner(req: IncomingMessage, res: ServerResponse) {
  let envelope: PubSubPushEnvelope;
  try {
    envelope = (await readJson(req)) as PubSubPushEnvelope;
  } catch (error) {
    const reason =
      error instanceof BodyTooLargeError ? "body too large" : "invalid json";
    log.warn({
      component: "pubsub-worker",
      message: "ack-drop",
      reason,
    });
    sendAckDrop(res, reason, await persistAckDrop({}, reason));
    return;
  }

  const parsed = parsePubSubPush(envelope ?? {});
  if (!parsed.ok) {
    log.warn({
      component: "pubsub-worker",
      message: "ack-drop",
      reason: parsed.reason,
    });
    sendAckDrop(
      res,
      parsed.reason,
      await persistAckDrop(envelope ?? {}, parsed.reason),
    );
    return;
  }

  const { work, topic, shop, messageId } = parsed.parsed;
  const source = isAdminRetry(envelope.message?.attributes)
    ? "admin-retry"
    : "shopify-publish";
  if (!allowedTopicsFromEnv().has(topic)) {
    const reason = `topic ${topic} not allowed`;
    log.info({
      component: "pubsub-worker",
      message: "ignored topic",
      topic,
      shop,
      messageId,
      source,
    });
    sendAckDrop(res, reason, await persistAckDrop(envelope, reason));
    return;
  }

  const started = Date.now();
  const { error: enqueueError } = await tryEnqueueWebhookWork(work);
  if (enqueueError) {
    log.error({
      component: "pubsub-worker",
      message: "enqueue failed",
      topic,
      shop,
      resourceId: work.resourceId,
      messageId,
      source,
      outcome: "enqueue_failed",
      error: enqueueError,
      latencyMs: Date.now() - started,
    });
    send(res, 500, { status: "enqueue_failed", message: enqueueError });
    return;
  }

  const claimed = await claimWebhookWork(work);
  if (!claimed) {
    log.info({
      component: "pubsub-worker",
      message: "row already claimed",
      topic,
      shop,
      resourceId: work.resourceId,
      messageId,
      source,
      outcome: "busy",
      latencyMs: Date.now() - started,
    });
    send(res, 500, { status: "busy" });
    return;
  }

  workerState.claimedWork = work;
  let result: Awaited<ReturnType<typeof processWebhookWork>>;
  try {
    result = await processWebhookWork(work);
  } finally {
    if (workerState.claimedWork === work) {
      workerState.claimedWork = null;
    }
  }
  const latencyMs = Date.now() - started;

  if (result.status === "success") {
    log.info({
      component: "pubsub-worker",
      message: "webhook completed",
      topic,
      shop,
      resourceId: work.resourceId,
      messageId,
      source,
      outcome: result.outcome,
      detail: result.detail,
      latencyMs,
    });
    send(res, 200, { status: result.outcome, latencyMs });
    return;
  }

  log.error({
    component: "pubsub-worker",
    message: "webhook failed",
    topic,
    shop,
    resourceId: work.resourceId,
    messageId,
    source,
    outcome: "failure",
    code: result.code,
    detail: result.message,
    retry: result.retry,
    latencyMs,
  });
  if (result.retry) {
    send(res, 500, {
      status: "failure",
      code: result.code,
      message: result.message,
    });
    return;
  }
  send(res, 200, {
    status: "dlq",
    code: result.code,
    message: result.message,
  });
}

export async function handlePush(req: IncomingMessage, res: ServerResponse) {
  return runWithLogContext(
    { traceHeader: traceHeaderFromRequest(req) },
    () => handlePushInner(req, res),
  );
}

export function handleWorkerRequest(
  req: IncomingMessage,
  res: ServerResponse,
) {
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );

  if (req.method === "GET" && url.pathname === "/") {
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    prisma.$queryRaw`SELECT 1`
      .then(() => send(res, 200, { ok: true, db: true }))
      .catch((error: unknown) => {
        runWithLogContext(
          { traceHeader: traceHeaderFromRequest(req) },
          () => {
            log.error({
              component: "pubsub-worker",
              message: "health check failed: database unreachable",
              error,
            });
          },
        );
        send(res, 503, { ok: false, db: false });
      });
    return;
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/" || url.pathname === "/pubsub")
  ) {
    if (workerState.shuttingDown) {
      send(res, 503, { status: "shutting_down" });
      return;
    }
    workerState.inFlight += 1;
    handlePush(req, res)
      .catch((error: unknown) => {
        runWithLogContext(
          { traceHeader: traceHeaderFromRequest(req) },
          () => {
            log.error({
              component: "pubsub-worker",
              message: "unhandled error",
              error,
            });
          },
        );
        send(res, 500, { status: "error" });
      })
      .finally(() => {
        workerState.inFlight -= 1;
      });
    return;
  }

  send(res, 404, { status: "not_found" });
}

export function drainAndExit(deadline = Date.now() + DRAIN_TIMEOUT_MS) {
  if (workerState.inFlight > 0 && Date.now() < deadline) {
    setTimeout(() => drainAndExit(deadline), 50);
    return;
  }
  const forced = workerState.inFlight > 0;
  closeDb().finally(() => process.exit(forced ? 1 : 0));
}

export function startWorker() {
  const server = createServer(handleWorkerRequest);

  server.listen(PORT, "0.0.0.0", () => {
    log.info({
      component: "pubsub-worker",
      message: "listening",
      port: PORT,
      topics: [...allowedTopicsFromEnv()],
    });
  });

  process.on("SIGTERM", () => {
    log.info({
      component: "pubsub-worker",
      message: "SIGTERM, draining",
    });
    workerState.shuttingDown = true;
    void releaseClaimedWork();
    server.close(() => {
      drainAndExit();
    });
  });

  return server;
}

if (!process.env.VITEST) {
  startWorker();
}
