import {
  WEBHOOK_HANDLERS,
  processWebhookWork,
  recordWebhookFailureNoSession,
} from "../webhook-queue.server";
import { consumeColdStartFlag, msSince } from "../request-timing.server";
import { authenticate } from "../shopify.server";
import type { Route } from "./+types/api.webhooks.products";

export const action = async ({ request }: Route.ActionArgs) => {
  const totalStart = performance.now();
  const cold = consumeColdStartFlag();

  const authStart = performance.now();
  const { topic, shop, session, admin, payload } =
    await authenticate.webhook(request);
  const authMs = msSince(authStart);

  const webhookId = request.headers.get("x-shopify-webhook-id");

  console.log(
    `[products-webhook] ${topic} shop=${shop} session=${session ? "yes" : "no"} admin=${admin ? "yes" : "no"}`,
  );

  if (topic !== "PRODUCTS_CREATE" && topic !== "PRODUCTS_UPDATE") {
    console.log(
      `[products-webhook] timing cold=${cold} authMs=${authMs} workMs=0 totalMs=${msSince(totalStart)} topic=${topic}`,
    );
    return new Response("Webhook handled", { status: 200 });
  }

  const productId = payload.id as number;
  const enqueueInput = {
    shop,
    handler: WEBHOOK_HANDLERS.PRODUCT_DESCRIPTION_SYNC,
    topic,
    resourceId: productId,
    resourceGid: `gid://shopify/Product/${productId}`,
    webhookId,
    payload,
  };

  if (!admin) {
    console.error(
      `[products-webhook] No admin API context for ${shop}. ` +
        "Open the app once on this store so an offline session exists.",
    );
    const workStart = performance.now();
    await recordWebhookFailureNoSession(enqueueInput);
    console.log(
      `[products-webhook] timing cold=${cold} authMs=${authMs} workMs=${msSince(workStart)} totalMs=${msSince(totalStart)} productId=${productId} outcome=no_session`,
    );
    return new Response("No session for shop", { status: 200 });
  }

  const graphql = admin.graphql.bind(admin);
  const workStart = performance.now();
  const outcome = await processWebhookWork(enqueueInput, graphql);
  const workMs = msSince(workStart);

  console.log(
    `[products-webhook] Product ${productId}: ${outcome} (failures persisted for cron)`,
  );
  console.log(
    `[products-webhook] timing cold=${cold} authMs=${authMs} workMs=${workMs} totalMs=${msSince(totalStart)} productId=${productId} outcome=${outcome}`,
  );

  return new Response("Webhook handled", { status: 200 });
};
