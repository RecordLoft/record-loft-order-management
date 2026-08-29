import {
  WEBHOOK_HANDLERS,
  enqueueWebhookWork,
  scheduleWebhookProcessing,
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
  const workStart = performance.now();
  const row = await enqueueWebhookWork({
    shop,
    handler: WEBHOOK_HANDLERS.PRODUCT_DESCRIPTION_SYNC,
    topic,
    resourceId: productId,
    resourceGid: `gid://shopify/Product/${productId}`,
    webhookId,
    payload,
  });
  const scheduled = scheduleWebhookProcessing(
    row.id,
    admin?.graphql.bind(admin),
  );

  console.log(
    `[products-webhook] ${topic} productId=${productId} shop=${shop} ` +
      `outcome=acked scheduled=${scheduled} ${timing} ` +
      `workMs=${msSince(workStart)} totalMs=${msSince(totalStart)}`,
  );

  return new Response("Webhook handled", { status: 200 });
};
