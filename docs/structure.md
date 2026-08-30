# Repository structure

Custom app on the Shopify React Router template. Runtime is split: Netlify serves HTTP for people; Cloud Run serves Pub/Sub for Shopify events.

```
app/                    React Router app (Netlify)
  routes/               Pages and HTTPS endpoints
  shopify.server.ts     shopifyApp(), sessions, unauthenticated.admin
  db.server.ts          Prisma + Aiven (pool max 1)
  record-planet.server.ts
  order-status-pro.server.ts
webhooks/               Cloud Run worker, queue, handlers
.github/workflows/      Deploy webhooks to Cloud Run
netlify/functions/      warm-app (hits /api/health every 5 min)
prisma/                 Schema + migrations
extensions/             Admin action extensions (Shopify-hosted)
certs/aiven-ca.pem      TLS CA for Aiven
shopify.app.toml        App URL, scopes, webhook destinations
Dockerfile.worker       Image for Cloud Run
```

## Netlify routes

| Path | Role |
|---|---|
| `/app` | Embedded shell + nav (Record Planet, Webhook DLQ) |
| `/app/record-planet` | Record Planet orders, search, status updates |
| `/app/webhooks-admin` | Dead-letter queue for `WebhookFailure` (Redrive) |
| `/auth/*` | OAuth |
| `/api/health` | Keep-warm target |
| `/api/update-status`, `/api/viable-statuses`, `/api/order-status-sync` | StatusPro + fulfillment from the UI |
| `/api/webhooks/order-status-pro/:token` | StatusPro inbound (not Shopify) |
| `/webhooks/app/uninstalled` | HTTPS Shopify lifecycle |
| `/webhooks/app/scopes_update` | HTTPS Shopify lifecycle |
| `/print/pick-list` | Pick list print |

There are **no** `/api/webhooks/products` or `/api/webhooks/orders` routes. Those topics go to Pub/Sub.

## Webhook code (`webhooks/`)

See [webhooks/README.md](../webhooks/README.md).

- **Product** — rebuild `descriptionHtml` from metafields.
- **Order create** — persist the order, mark fulfillment in progress when applicable.

`queue.server.ts` coalesces work on `(shop, handler, resourceId)`, runs the handler via `unauthenticated.admin(shop)`, deletes the row on success, increments `attempts` on failure. After 5 failures (or no session) the row is `failed` and Pub/Sub is acked. `/app/webhooks-admin` is the DLQ; Redrive republishes via `app/webhook-retry-publish.server.ts`. Netlify does not run handlers.

Cloud Run starts `webhooks/worker.server.ts` (plain `node:http`). It does not start Vite or React Router. The image still copies `app/` so the worker can load Prisma and the offline session.

## Extensions

- `extensions/pick-list-print` — admin action to print a pick list.
- `extensions/ready-for-pickup` — admin action for ready-for-pickup.

They ship with `shopify app deploy`, not Netlify.

## Database

Aiven Postgres (`max_connections` is 20 on the current Free-sized instance). Prisma `max: 1` per process. Cloud Run is `concurrency=1` and `max-instances=2`, so the worker uses at most two connections. Netlify keep-warm and admin add a few more. There is no Aiven PgBouncer on Free.
