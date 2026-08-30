/**
 * Cloud Run Pub/Sub push worker. Deploy via .github/workflows/deploy-webhooks.yml.
 * Manual fallback: docs/deploy-webhooks.md
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { closeDb } from "../app/db.server";
import {
  isAdminRetry,
  parsePubSubPush,
  verifyShopifyHmac,
  type PubSubPushEnvelope,
} from "./parse-pubsub";
import { processWebhookWork, tryEnqueueWebhookWork } from "./queue.server";

const PORT = Number(process.env.PORT || 8080);
const ALLOWED_TOPICS = new Set(
  (process.env.ALLOWED_TOPICS ?? "products/create,products/update,orders/create")
    .split(",")
    .map((topic) => topic.trim().toLowerCase())
    .filter(Boolean),
);

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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

async function handlePush(req: IncomingMessage, res: ServerResponse) {
  let envelope: PubSubPushEnvelope;
  try {
    envelope = (await readJson(req)) as PubSubPushEnvelope;
  } catch {
    send(res, 200, { status: "ignored", reason: "invalid json" });
    return;
  }

  const parsed = parsePubSubPush(envelope ?? {});
  if (!parsed.ok) {
    console.warn(`[pubsub-worker] ack-drop reason=${parsed.reason}`);
    send(res, 200, { status: "ignored", reason: parsed.reason });
    return;
  }

  const hmac = envelope.message?.attributes
    ? Object.entries(envelope.message.attributes).find(
        ([key]) => key.toLowerCase() === "x-shopify-hmac-sha256",
      )?.[1]
    : undefined;
  if (isAdminRetry(envelope.message?.attributes)) {
    // Admin republish has no Shopify HMAC; topic publish IAM is the gate.
  } else if (
    !verifyShopifyHmac(
      parsed.rawPayload,
      hmac,
      process.env.SHOPIFY_API_SECRET,
    )
  ) {
    console.error("[pubsub-worker] hmac mismatch — ack-drop");
    send(res, 200, { status: "ignored", reason: "hmac mismatch" });
    return;
  }

  const { work, topic, shop, messageId } = parsed.parsed;
  if (!ALLOWED_TOPICS.has(topic)) {
    console.log(
      `[pubsub-worker] ignored topic=${topic} shop=${shop} messageId=${messageId}`,
    );
    send(res, 200, { status: "ignored", reason: `topic ${topic} not allowed` });
    return;
  }

  const started = Date.now();
  const { error: enqueueError } = await tryEnqueueWebhookWork(work);
  const result = await processWebhookWork(work);
  const latencyMs = Date.now() - started;

  if (result.status === "success") {
    console.log(
      `[pubsub-worker] topic=${topic} shop=${shop} resourceId=${work.resourceId} ` +
        `messageId=${messageId} outcome=${result.outcome} detail=${result.detail} ` +
        `latencyMs=${latencyMs}` +
        (enqueueError ? ` enqueueError=${enqueueError}` : ""),
    );
    send(res, 200, { status: result.outcome, latencyMs });
    return;
  }

  console.error(
    `[pubsub-worker] topic=${topic} shop=${shop} resourceId=${work.resourceId} ` +
      `messageId=${messageId} outcome=failure code=${result.code} ` +
      `message=${result.message} latencyMs=${latencyMs}`,
  );
  send(res, 500, {
    status: "failure",
    code: result.code,
    message: result.message,
  });
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    send(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && (url.pathname === "/" || url.pathname === "/pubsub")) {
    handlePush(req, res).catch((error: unknown) => {
      console.error("[pubsub-worker] unhandled", error);
      send(res, 500, { status: "error" });
    });
    return;
  }

  send(res, 404, { status: "not_found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `[pubsub-worker] listening on ${PORT} topics=${[...ALLOWED_TOPICS].join(",")}`,
  );
});

process.on("SIGTERM", () => {
  console.log("[pubsub-worker] SIGTERM, closing db");
  closeDb().finally(() => process.exit(0));
});
