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
  claimWebhookWork,
  processWebhookWork,
  recordAckDrop,
  tryEnqueueWebhookWork,
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
): Promise<void> {
  const context = ackDropContext(envelope);
  try {
    await recordAckDrop({ ...context, reason });
  } catch (error) {
    console.error(`[pubsub-worker] ack-drop persist failed reason=${reason}`, error);
  }
}

export async function handlePush(req: IncomingMessage, res: ServerResponse) {
  let envelope: PubSubPushEnvelope;
  try {
    envelope = (await readJson(req)) as PubSubPushEnvelope;
  } catch (error) {
    const reason =
      error instanceof BodyTooLargeError ? "body too large" : "invalid json";
    console.warn(`[pubsub-worker] ack-drop reason=${reason}`);
    await persistAckDrop({}, reason);
    send(res, 200, { status: "ignored", reason });
    return;
  }

  const parsed = parsePubSubPush(envelope ?? {});
  if (!parsed.ok) {
    console.warn(`[pubsub-worker] ack-drop reason=${parsed.reason}`);
    await persistAckDrop(envelope ?? {}, parsed.reason);
    send(res, 200, { status: "ignored", reason: parsed.reason });
    return;
  }

  const { work, topic, shop, messageId } = parsed.parsed;
  const source = isAdminRetry(envelope.message?.attributes)
    ? "admin-retry"
    : "shopify-publish";
  if (!allowedTopicsFromEnv().has(topic)) {
    const reason = `topic ${topic} not allowed`;
    console.log(
      `[pubsub-worker] ignored topic=${topic} shop=${shop} messageId=${messageId} source=${source}`,
    );
    await persistAckDrop(envelope, reason);
    send(res, 200, { status: "ignored", reason });
    return;
  }

  const started = Date.now();
  const { error: enqueueError } = await tryEnqueueWebhookWork(work);
  if (enqueueError) {
    console.error(
      `[pubsub-worker] topic=${topic} shop=${shop} resourceId=${work.resourceId} ` +
        `messageId=${messageId} source=${source} outcome=enqueue_failed ` +
        `message=${enqueueError} latencyMs=${Date.now() - started}`,
    );
    send(res, 500, { status: "enqueue_failed", message: enqueueError });
    return;
  }

  const claimed = await claimWebhookWork(work);
  if (!claimed) {
    console.log(
      `[pubsub-worker] topic=${topic} shop=${shop} resourceId=${work.resourceId} ` +
        `messageId=${messageId} source=${source} outcome=busy latencyMs=${Date.now() - started}`,
    );
    send(res, 500, { status: "busy" });
    return;
  }

  const result = await processWebhookWork(work);
  const latencyMs = Date.now() - started;

  if (result.status === "success") {
    console.log(
      `[pubsub-worker] topic=${topic} shop=${shop} resourceId=${work.resourceId} ` +
        `messageId=${messageId} source=${source} outcome=${result.outcome} ` +
        `detail=${result.detail} latencyMs=${latencyMs}`,
    );
    send(res, 200, { status: result.outcome, latencyMs });
    return;
  }

  console.error(
    `[pubsub-worker] topic=${topic} shop=${shop} resourceId=${work.resourceId} ` +
      `messageId=${messageId} source=${source} outcome=failure code=${result.code} ` +
      `message=${result.message} retry=${result.retry} latencyMs=${latencyMs}`,
  );
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
        console.error("[pubsub-worker] health db failed", error);
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
        console.error("[pubsub-worker] unhandled", error);
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
    console.log(
      `[pubsub-worker] listening on ${PORT} topics=${[...allowedTopicsFromEnv()].join(",")}`,
    );
  });

  process.on("SIGTERM", () => {
    console.log("[pubsub-worker] SIGTERM, draining");
    workerState.shuttingDown = true;
    server.close(() => {
      drainAndExit();
    });
  });

  return server;
}

if (!process.env.VITEST) {
  startWorker();
}
