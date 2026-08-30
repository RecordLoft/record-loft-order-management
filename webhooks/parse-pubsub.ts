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
  "orders/cancelled": WebhookFailureHandler.orders_cancelled,
  orders_cancelled: WebhookFailureHandler.orders_cancelled,
  "orders/fulfilled": WebhookFailureHandler.orders_fulfilled,
  orders_fulfilled: WebhookFailureHandler.orders_fulfilled,
  "refunds/create": WebhookFailureHandler.refunds_create,
  refunds_create: WebhookFailureHandler.refunds_create,
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

export const ADMIN_RETRY_ATTRIBUTE = "X-Retry-Source";
export const ADMIN_RETRY_VALUE = "admin";

export function isAdminRetry(
  attributes: Record<string, string> | undefined,
): boolean {
  return attribute(attributes, ADMIN_RETRY_ATTRIBUTE) === ADMIN_RETRY_VALUE;
}

export function ackDropContext(envelope: PubSubPushEnvelope): {
  shop?: string;
  topic?: string;
  resourceId?: number;
  payload?: unknown;
  webhookId?: string;
  messageId?: string;
} {
  const attributes = envelope.message?.attributes;
  const shop = attribute(attributes, "X-Shopify-Shop-Domain");
  const topic = attribute(attributes, "X-Shopify-Topic");
  const webhookId = attribute(attributes, "X-Shopify-Webhook-Id");
  const messageId =
    envelope.message?.messageId ?? envelope.message?.message_id;
  if (!envelope.message?.data) {
    return { shop, topic, webhookId, messageId };
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(envelope.message.data, "base64").toString("utf8"),
    ) as unknown;
    const payload = unwrapShopifyPayload(decoded) ?? undefined;
    const rawId = payload?.id;
    const resourceId =
      typeof rawId === "number"
        ? rawId
        : typeof rawId === "string" && /^\d+$/.test(rawId)
          ? Number(rawId)
          : undefined;
    return { shop, topic, resourceId, payload, webhookId, messageId };
  } catch {
    return { shop, topic, webhookId, messageId };
  }
}

function numericResourceId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

const ORDER_HANDLERS = new Set<WebhookFailureHandler>([
  WebhookFailureHandler.orders_create,
  WebhookFailureHandler.orders_cancelled,
  WebhookFailureHandler.orders_fulfilled,
  WebhookFailureHandler.refunds_create,
]);

export function parsePubSubPush(
  envelope: PubSubPushEnvelope,
): { ok: true; parsed: ParsedPubSubWebhook } | { ok: false; reason: string } {
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

  let resourceId: number | null;
  if (handler === WebhookFailureHandler.refunds_create) {
    resourceId = numericResourceId(payload.order_id ?? payload.orderId);
    if (resourceId == null) {
      return { ok: false, reason: "payload missing order_id" };
    }
  } else {
    resourceId = numericResourceId(payload.id);
    if (resourceId == null) {
      return { ok: false, reason: "payload.id is not a number" };
    }
  }

  const webhookId =
    attribute(message.attributes, "X-Shopify-Webhook-Id") ?? null;
  const resourceKind = ORDER_HANDLERS.has(handler) ? "Order" : "Product";

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
