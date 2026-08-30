# Webhooks

Pub/Sub worker and handlers. The embedded admin still serves `/app/webhooks-admin` from `app/routes/app.webhooks-admin.tsx` (retry republishes to Pub/Sub; it does not run handlers).

`app/` stays the React Router app. This folder is what Cloud Run runs.

| File | Role |
|---|---|
| `worker.server.ts` | Cloud Run HTTP server (Pub/Sub push) |
| `parse-pubsub.ts` | Decode the push envelope + Shopify attributes |
| `queue.server.ts` | Coalesce, run, persist / delete `WebhookFailure` |
| `product-description.handler.server.ts` | Rebuild product `descriptionHtml` |
| `product-description.server.ts` | Description metafield → HTML |
| `orders-create.handler.server.ts` | Import the order, mark fulfillment in progress |
| `shopify-fulfillment.server.ts` | Fulfillment-order progress mutations |
| `types.server.ts` | Handler result type |

Still imported from `app/`: `db.server.ts` and `shopify.server.ts` (Prisma + offline admin session).

Deploy: [docs/deploy-webhooks.md](../docs/deploy-webhooks.md). Topics and env: [docs/webhooks.md](../docs/webhooks.md).
