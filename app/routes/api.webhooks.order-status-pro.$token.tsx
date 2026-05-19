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
    return new Response("Unauthorized", { status: 401 });
  }

  const rawBody = await request.text();

  let body: unknown;
  try {
    body = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  const parsed = parseOspWebhookPayload(body);
  if (parsed) {
    await applyOrderStatusCache(parsed.orderId, parsed.statusName);
  }

  return new Response("Webhook handled", { status: 200 });
};
