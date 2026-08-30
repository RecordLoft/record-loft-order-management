import { createHmac, timingSafeEqual } from "node:crypto";
import { WebhookFailureHandler } from "../generated/prisma/client";
import type { WebhookWorkInput } from "./queue.server";

export type PubSubPushEnvelope = {
  message?: {
    data?: string;
    attributes?: Record<string, string>;
    messageId?: string;
    message_id?: string;
  };
  subscription?: string;
};

export type ParsedPubSubWebhook = {
  topic: string;
  shop: string;
  webhookId: string | null;
  messageId: string | null;
  payload: Record<string, unknown>;
  handler: WebhookFailureHandler;
  work: WebhookWorkInput;
};

const TOPIC_HANDLERS: Record<string, WebhookFailureHandler> = {
  "products/create": WebhookFailureHandler.product_description_sync,
  "products/update": WebhookFailureHandler.product_description_sync,
  products_create: WebhookFailureHandler.product_description_sync,
  products_update: WebhookFailureHandler.product_description_sync,
  "orders/create": WebhookFailureHandler.orders_create,
  orders_create: WebhookFailureHandler.orders_create,
};

export function normalizeTopic(raw: string): string {
  return raw.trim().toLowerCase().replaceAll("_", "/");
}

function attribute(
  attributes: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!attributes) return undefined;
  const want = name.toLowerCase();
  for (const [key, value] of Object.entries(attributes)) {
    if (key.toLowerCase() === want && value) return value;
  }
  return undefined;
}

export function unwrapShopifyPayload(
  data: unknown,
): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;
  const nested = obj.payload;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const inner = nested as Record<string, unknown>;
    if (inner.id != null) return inner;
  }
  return obj;
}

export function handlerForTopic(
  topic: string,
): WebhookFailureHandler | undefined {
  const normalized = normalizeTopic(topic);
  return TOPIC_HANDLERS[normalized] ?? TOPIC_HANDLERS[topic.toLowerCase()];
}

export function verifyShopifyHmac(
  rawBody: Buffer,
  hmacHeader: string | undefined,
  secret: string | undefined,
): boolean {
  if (!hmacHeader || !secret) return true;
  const digest = createHmac("sha256", secret).update(rawBody).digest("base64");
  const expected = Buffer.from(digest);
  const actual = Buffer.from(hmacHeader);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export function parsePubSubPush(
  envelope: PubSubPushEnvelope,
):
  | { ok: true; parsed: ParsedPubSubWebhook; rawPayload: Buffer }
  | { ok: false; reason: string } {
  const message = envelope.message;
  if (!message?.data) {
    return { ok: false, reason: "missing message.data" };
  }

  let rawPayload: Buffer;
  try {
    rawPayload = Buffer.from(message.data, "base64");
  } catch {
    return { ok: false, reason: "message.data is not valid base64" };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(rawPayload.toString("utf8"));
  } catch {
    return { ok: false, reason: "message.data is not JSON" };
  }

  const payload = unwrapShopifyPayload(decoded);
  if (!payload || payload.id == null) {
    return { ok: false, reason: "payload missing id" };
  }

  const topic =
    attribute(message.attributes, "X-Shopify-Topic") ??
    (typeof payload.topic === "string" ? payload.topic : "");
  if (!topic) {
    return { ok: false, reason: "missing X-Shopify-Topic" };
  }

  const shop =
    attribute(message.attributes, "X-Shopify-Shop-Domain") ??
    (typeof payload.domain === "string" ? payload.domain : "");
  if (!shop) {
    return { ok: false, reason: "missing X-Shopify-Shop-Domain" };
  }

  const handler = handlerForTopic(topic);
  if (!handler) {
    return { ok: false, reason: `unsupported topic ${topic}` };
  }

  const resourceId = Number(payload.id);
  if (!Number.isFinite(resourceId)) {
    return { ok: false, reason: "payload.id is not a number" };
  }

  const webhookId =
    attribute(message.attributes, "X-Shopify-Webhook-Id") ?? null;
  const resourceKind =
    handler === WebhookFailureHandler.orders_create ? "Order" : "Product";

  const work: WebhookWorkInput = {
    shop,
    handler,
    topic: normalizeTopic(topic).toUpperCase().replaceAll("/", "_"),
    resourceId,
    resourceGid: `gid://shopify/${resourceKind}/${resourceId}`,
    webhookId,
    payload,
  };

  return {
    ok: true,
    rawPayload,
    parsed: {
      topic: normalizeTopic(topic),
      shop,
      webhookId,
      messageId: message.messageId ?? message.message_id ?? null,
      payload,
      handler,
      work,
    },
  };
}
