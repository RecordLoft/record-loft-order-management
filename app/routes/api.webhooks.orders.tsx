import {
  WEBHOOK_HANDLERS,
  processWebhookWork,
  recordWebhookFailureNoSession,
} from "../webhook-queue.server";
import { consumeColdStartFlag, msSince } from "../request-timing.server";
import { authenticate } from "../shopify.server";
import type { Route } from "./+types/api.webhooks.orders";

export const action = async ({ request }: Route.ActionArgs) => {
  const totalStart = performance.now();
  const cold = consumeColdStartFlag();

  const authStart = performance.now();
  const { topic, shop, session, admin, payload } =
    await authenticate.webhook(request);
  const authMs = msSince(authStart);

  const webhookId = request.headers.get("x-shopify-webhook-id");

  console.log(
    `[orders-webhook] ${topic} shop=${shop} session=${session ? "yes" : "no"} admin=${admin ? "yes" : "no"}`,
  );

  if (topic !== "ORDERS_CREATE") {
    console.log(
      `[orders-webhook] timing cold=${cold} authMs=${authMs} workMs=0 totalMs=${msSince(totalStart)} topic=${topic}`,
    );
    return new Response("Webhook handled", { status: 200 });
  }

  const orderId = payload.id as number;
  const enqueueInput = {
    shop,
    handler: WEBHOOK_HANDLERS.ORDERS_CREATE,
    topic,
    resourceId: orderId,
    resourceGid: `gid://shopify/Order/${orderId}`,
    webhookId,
    payload,
  };

  if (!admin) {
    console.error(
      `[orders-webhook] No admin API context for ${shop}. ` +
        "Open the app once on this store so an offline session exists.",
    );
    const workStart = performance.now();
    await recordWebhookFailureNoSession(enqueueInput);
    console.log(
      `[orders-webhook] timing cold=${cold} authMs=${authMs} workMs=${msSince(workStart)} totalMs=${msSince(totalStart)} orderId=${orderId} outcome=no_session`,
    );
    return new Response("No session for shop", { status: 200 });
  }

  const graphql = admin.graphql.bind(admin);
  const workStart = performance.now();
  const outcome = await processWebhookWork(enqueueInput, graphql);
  const workMs = msSince(workStart);

  console.log(
    `[orders-webhook] Order ${orderId}: ${outcome} (failures persisted for cron)`,
  );
  console.log(
    `[orders-webhook] timing cold=${cold} authMs=${authMs} workMs=${workMs} totalMs=${msSince(totalStart)} orderId=${orderId} outcome=${outcome}`,
  );

  return new Response("Webhook handled", { status: 200 });
};
