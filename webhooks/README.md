# Webhooks

Pub/Sub worker and handlers. `/app/webhooks-admin` is the dead-letter queue (failed rows after 5 auto-retries, plus `ack_drop`). `app/webhook-retry-publish.server.ts` redrives stored payloads to Pub/Sub; Netlify does not run handlers. Redrive skips `ack_drop` rows and live `processing` rows; stale processing (lease older than 90 seconds) can be redriven. SIGTERM releases a live claim. Ack-drop persist failure returns 500.

`app/` stays the React Router app. This folder is what Cloud Run runs.

| File | Role |
|---|---|
| `worker.server.ts` | Cloud Run HTTP server (Pub/Sub push). Compiled to `dist/worker.js`. `GET /` liveness, `GET /health` DB ping. Startup pings Postgres before listen. |
| `log.server.ts` | Structured JSON lines for Log Explorer (`severity`, `message`, trace) |
| `parse-pubsub.ts` | Decode the push envelope + Shopify attributes |
| `queue.server.ts` | Coalesce, claim (`processing`), run, persist / delete `WebhookFailure` |
| `product-description.handler.server.ts` | Rebuild product `descriptionHtml` |
| `product-description.server.ts` | Description metafield → HTML |
| `orders-create.handler.server.ts` | Import the order, apply pending cancel/refund/OSP, mark fulfillment in progress |
| `orders-lifecycle.handler.server.ts` | `orders/cancelled`, `orders/fulfilled`, and `refunds/create` (full refund only; pending if the order is not imported yet) |
| `shopify-fulfillment.server.ts` | Fulfillment-order progress mutations |
| `types.server.ts` | Handler result type |

Still imported from `app/`: `db.server.ts` and `shopify.server.ts` (Prisma + offline admin session).

Deploy: [docs/deploy-webhooks.md](../docs/deploy-webhooks.md). Topics and env: [docs/webhooks.md](../docs/webhooks.md).
