import {
  applyOrderStatusCache,
  parseOspWebhookPayload,
  verifyOspWebhookToken,
} from "../order-status-pro.server";
import type { ActionFunctionArgs } from "react-router";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!verifyOspWebhookToken(params.token)) {
    console.warn("[osp-webhook] Rejected: invalid or missing URL token");
    return new Response("Unauthorized", { status: 401 });
  }

  const rawBody = await request.text();

  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    console.warn("[osp-webhook] Rejected: invalid JSON body");
    return new Response("Bad request", { status: 400 });
  }

  const parsed = parseOspWebhookPayload(body);
  if (!parsed) {
    console.warn("[osp-webhook] Unrecognized payload:", rawBody.slice(0, 500));
    return new Response("Webhook handled", { status: 200 });
  }

  const updated = await applyOrderStatusCache(parsed.orderId, parsed.status);
  console.log(
    `[osp-webhook] order=${parsed.orderId} status=${parsed.status.code ?? parsed.status.name} updated=${updated}`,
  );

  return new Response("Webhook handled", { status: 200 });
};
