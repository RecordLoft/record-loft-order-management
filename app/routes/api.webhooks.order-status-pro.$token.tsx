import {
  applyOrderStatusCache,
  logOspWebhookPayloadInChunks,
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

  logOspWebhookPayloadInChunks(rawBody);

  const parsed = parseOspWebhookPayload(body);
  if (!parsed) {
    const event =
      body && typeof body === "object" && "event" in body
        ? String((body as { event: unknown }).event)
        : "unknown";
    const orderId =
      body &&
      typeof body === "object" &&
      "order" in body &&
      body.order &&
      typeof body.order === "object" &&
      "id" in body.order
        ? String((body.order as { id: unknown }).id)
        : "unknown";
    console.warn(
      `[osp-webhook] parse failed event=${event} orderId=${orderId}`,
    );
    return new Response("Webhook handled", { status: 200 });
  }

  const updated = await applyOrderStatusCache(parsed.orderId, parsed.status);
  if (updated) {
    console.log(
      `[osp-webhook] cached order=${parsed.orderId} code=${parsed.status.code ?? "?"} name=${parsed.status.name ?? "?"}`,
    );
  }

  return new Response("Webhook handled", { status: 200 });
};
