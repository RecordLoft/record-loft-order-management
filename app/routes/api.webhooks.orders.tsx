import {
  WEBHOOK_HANDLERS,
  enqueueWebhookJob,
  enqueueWebhookJobNoSession,
  scheduleImmediateWebhookJobProcessing,
} from "../webhook-queue.server";
import { authenticate } from "../shopify.server";
import type { Route } from "./+types/api.webhooks.orders";

export const action = async ({ request, context }: Route.ActionArgs) => {
  const { topic, shop, session, admin, payload } =
    await authenticate.webhook(request);

  const webhookId = request.headers.get("x-shopify-webhook-id");

  console.log(
    `[orders-webhook] ${topic} shop=${shop} session=${session ? "yes" : "no"} admin=${admin ? "yes" : "no"}`,
  );

  if (topic !== "ORDERS_CREATE") {
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
    await enqueueWebhookJobNoSession(enqueueInput);
    return new Response("No session for shop", { status: 200 });
  }

  const job = await enqueueWebhookJob(enqueueInput);
  const graphql = admin.graphql.bind(admin);

  const response = new Response("Webhook handled", { status: 200 });
  scheduleImmediateWebhookJobProcessing(context, job.id, graphql);

  console.log(`[orders-webhook] Enqueued job ${job.id} for order ${orderId}`);

  return response;
};
