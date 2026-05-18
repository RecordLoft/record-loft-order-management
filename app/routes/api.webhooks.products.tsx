import {
  WEBHOOK_HANDLERS,
  enqueueWebhookJob,
  enqueueWebhookJobNoSession,
  scheduleImmediateWebhookJobProcessing,
} from "../webhook-queue.server";
import { authenticate } from "../shopify.server";
import type { Route } from "./+types/api.webhooks.products";

export const action = async ({ request, context }: Route.ActionArgs) => {
  const { topic, shop, session, admin, payload } =
    await authenticate.webhook(request);

  const webhookId = request.headers.get("x-shopify-webhook-id");

  console.log(
    `[products-webhook] ${topic} shop=${shop} session=${session ? "yes" : "no"} admin=${admin ? "yes" : "no"}`,
  );

  if (topic !== "PRODUCTS_CREATE" && topic !== "PRODUCTS_UPDATE") {
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
    await enqueueWebhookJobNoSession(enqueueInput);
    return new Response("No session for shop", { status: 200 });
  }

  const job = await enqueueWebhookJob(enqueueInput);
  const graphql = admin.graphql.bind(admin);

  // 200 first; same invocation continues work via waitUntil (not a second function).
  const response = new Response("Webhook handled", { status: 200 });
  scheduleImmediateWebhookJobProcessing(context, job.id, graphql);

  console.log(`[products-webhook] Enqueued job ${job.id} for product ${productId}`);

  return response;
};
