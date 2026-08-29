import {
  WEBHOOK_HANDLERS,
  enqueueWebhookWork,
  scheduleWebhookProcessing,
} from "../webhook-queue.server";
import { consumeColdStartFlag, msSince } from "../request-timing.server";
import { authenticate } from "../shopify.server";
import type { Route } from "./+types/api.webhooks.orders";

export const action = async ({ request }: Route.ActionArgs) => {
  const totalStart = performance.now();
  const cold = consumeColdStartFlag();

  const authStart = performance.now();
  const { topic, shop, admin, payload } = await authenticate.webhook(request);
  const authMs = msSince(authStart);

  const webhookId = request.headers.get("x-shopify-webhook-id");
  const timing = `cold=${cold} authMs=${authMs}`;

  if (topic !== "ORDERS_CREATE") {
    console.log(
      `[orders-webhook] ignored topic=${topic} shop=${shop} ${timing} totalMs=${msSince(totalStart)}`,
    );
    return new Response("Webhook handled", { status: 200 });
  }

  const orderId = payload.id as number;
  const workStart = performance.now();
  const row = await enqueueWebhookWork({
    shop,
    handler: WEBHOOK_HANDLERS.ORDERS_CREATE,
    topic,
    resourceId: orderId,
    resourceGid: `gid://shopify/Order/${orderId}`,
    webhookId,
    payload,
  });
  const scheduled = scheduleWebhookProcessing(
    row.id,
    admin?.graphql.bind(admin),
  );

  console.log(
    `[orders-webhook] ${topic} orderId=${orderId} shop=${shop} ` +
      `outcome=acked scheduled=${scheduled} ${timing} ` +
      `workMs=${msSince(workStart)} totalMs=${msSince(totalStart)}`,
  );

  return new Response("Webhook handled", { status: 200 });
};
