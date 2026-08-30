import { GoogleAuth } from "google-auth-library";
import {
  WebhookFailureHandler,
  WebhookFailureStatus,
} from "../generated/prisma/client";
import { prisma } from "./db.server";
import { normalizeTopic } from "../webhooks/parse-pubsub";

const PROJECT_ID = process.env.GCP_PROJECT_ID ?? "record-loft";

const PUBSUB_TOPIC_BY_HANDLER: Record<WebhookFailureHandler, string> = {
  [WebhookFailureHandler.product_description_sync]: "shopify-products",
  [WebhookFailureHandler.orders_create]: "shopify-orders",
};

type FailureToPublish = {
  id: string;
  shop: string;
  handler: WebhookFailureHandler;
  topic: string;
  webhookId: string | null;
  payload: unknown;
};

export type RepublishResult = {
  queued: number;
  ids: string[];
};

function credentialsFromEnv(): Record<string, unknown> | undefined {
  const raw = process.env.GCP_PUBSUB_SA_JSON?.trim();
  if (!raw) return undefined;
  return JSON.parse(raw) as Record<string, unknown>;
}

async function pubsubAccessToken(): Promise<string> {
  const credentials = credentialsFromEnv();
  const auth = new GoogleAuth({
    ...(credentials ? { credentials } : {}),
    scopes: ["https://www.googleapis.com/auth/pubsub"],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) {
    throw new Error("Failed to get a Pub/Sub access token");
  }
  return token.token;
}

async function publishMessages(
  topic: string,
  rows: FailureToPublish[],
  accessToken: string,
): Promise<void> {
  const body = {
    messages: rows.map((row) => ({
      data: Buffer.from(JSON.stringify(row.payload), "utf8").toString("base64"),
      attributes: {
        "X-Shopify-Topic": normalizeTopic(row.topic),
        "X-Shopify-Shop-Domain": row.shop,
        ...(row.webhookId
          ? { "X-Shopify-Webhook-Id": row.webhookId }
          : {}),
      },
    })),
  };

  const response = await fetch(
    `https://pubsub.googleapis.com/v1/projects/${PROJECT_ID}/topics/${topic}:publish`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Pub/Sub publish failed (${response.status}) on ${topic}: ${detail.slice(0, 500)}`,
    );
  }
}

/**
 * Re-publish stored webhook payloads so Cloud Run processes them.
 * Netlify does not run handlers.
 */
export async function republishWebhookFailures(
  shop: string,
  options: { ids?: string[]; limit?: number } = {},
): Promise<RepublishResult> {
  const rows = await prisma.webhookFailure.findMany({
    where: {
      shop,
      status: {
        in: [WebhookFailureStatus.pending, WebhookFailureStatus.failed],
      },
      ...(options.ids ? { id: { in: options.ids } } : {}),
    },
    orderBy: { updatedAt: "asc" },
    take: options.limit ?? 20,
    select: {
      id: true,
      shop: true,
      handler: true,
      topic: true,
      webhookId: true,
      payload: true,
    },
  });

  if (rows.length === 0) {
    return { queued: 0, ids: [] };
  }

  const accessToken = await pubsubAccessToken();
  const byTopic = new Map<string, FailureToPublish[]>();
  for (const row of rows) {
    const topic = PUBSUB_TOPIC_BY_HANDLER[row.handler];
    const list = byTopic.get(topic) ?? [];
    list.push(row);
    byTopic.set(topic, list);
  }

  for (const [topic, group] of byTopic) {
    await publishMessages(topic, group, accessToken);
  }

  await prisma.webhookFailure.updateMany({
    where: { id: { in: rows.map((row) => row.id) } },
    data: {
      status: WebhookFailureStatus.pending,
      completedAt: null,
    },
  });

  return { queued: rows.length, ids: rows.map((row) => row.id) };
}
