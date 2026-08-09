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
  const { topic, shop, admin, payload } = await authenticate.webhook(request);
  const authMs = msSince(authStart);

  const webhookId = request.headers.get("x-shopify-webhook-id");
  const timing = `cold=${cold} authMs=${authMs}`;

  if (topic !== "PRODUCTS_CREATE" && topic !== "PRODUCTS_UPDATE") {
    console.log(
      `[products-webhook] ignored topic=${topic} shop=${shop} ${timing} totalMs=${msSince(totalStart)}`,
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
    const workStart = performance.now();
    await recordWebhookFailureNoSession(enqueueInput);
    console.error(
      `[products-webhook] ${topic} productId=${productId} shop=${shop} ` +
        `outcome=failure code=no_admin_session persisted=cron_retry ` +
        `${timing} workMs=${msSince(workStart)} totalMs=${msSince(totalStart)}`,
    );
    return new Response("No session for shop", { status: 200 });
  }

  const graphql = admin.graphql.bind(admin);
  const workStart = performance.now();
  const result = await processWebhookWork(enqueueInput, graphql);
  const workMs = msSince(workStart);
  const totalMs = msSince(totalStart);

  if (result.status === "success") {
    console.log(
      `[products-webhook] ${topic} productId=${productId} shop=${shop} ` +
        `outcome=${result.outcome} detail=${result.detail} ` +
        `${timing} workMs=${workMs} totalMs=${totalMs}`,
    );
  } else {
    console.error(
      `[products-webhook] ${topic} productId=${productId} shop=${shop} ` +
        `outcome=failure code=${result.code} message=${result.message} ` +
        `persisted=cron_retry ${timing} workMs=${workMs} totalMs=${totalMs}`,
    );
  }

  return new Response("Webhook handled", { status: 200 });
};
