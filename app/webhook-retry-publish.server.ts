import { createSign } from "node:crypto";
import {
  WebhookFailureHandler,
  WebhookFailureStatus,
} from "../generated/prisma/client";
import { prisma } from "./db.server";
import {
  ADMIN_RETRY_ATTRIBUTE,
  ADMIN_RETRY_VALUE,
  normalizeTopic,
} from "../webhooks/parse-pubsub";

const PROJECT_ID = process.env.GCP_PROJECT_ID ?? "record-loft";
const TOKEN_AUD = "https://oauth2.googleapis.com/token";
const PUBSUB_SCOPE = "https://www.googleapis.com/auth/pubsub";

const PUBSUB_TOPIC_BY_HANDLER: Record<WebhookFailureHandler, string> = {
  [WebhookFailureHandler.product_description_sync]: "shopify-products",
  [WebhookFailureHandler.orders_create]: "shopify-orders",
};

type ServiceAccountJson = {
  client_email: string;
  private_key: string;
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

function base64Url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64url");
}

function serviceAccountFromEnv(): ServiceAccountJson {
  const raw = process.env.GCP_PUBSUB_SA_JSON?.trim();
  if (!raw) {
    throw new Error(
      "GCP_PUBSUB_SA_JSON is not configured. Add the publish-only service account JSON on Netlify.",
    );
  }
  const parsed = JSON.parse(raw) as Partial<ServiceAccountJson>;
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("GCP_PUBSUB_SA_JSON must include client_email and private_key");
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

async function pubsubAccessToken(): Promise<string> {
  const { client_email, private_key } = serviceAccountFromEnv();
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: client_email,
      sub: client_email,
      aud: TOKEN_AUD,
      iat: now,
      exp: now + 3600,
      scope: PUBSUB_SCOPE,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const jwt = `${header}.${claim}.${base64Url(signer.sign(private_key))}`;

  const response = await fetch(TOKEN_AUD, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Failed to get a Pub/Sub token (${response.status}): ${detail.slice(0, 300)}`);
  }
  const json = (await response.json()) as { access_token?: string };
  if (!json.access_token) {
    throw new Error("Pub/Sub token response missing access_token");
  }
  return json.access_token;
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
        [ADMIN_RETRY_ATTRIBUTE]: ADMIN_RETRY_VALUE,
        ...(row.webhookId ? { "X-Shopify-Webhook-Id": row.webhookId } : {}),
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
      status: WebhookFailureStatus.failed,
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
      attempts: 0,
      completedAt: null,
    },
  });

  return { queued: rows.length, ids: rows.map((row) => row.id) };
}
