# Repository structure

Custom app on the Shopify React Router template. Runtime is split: Netlify serves HTTP for people; Cloud Run serves Pub/Sub for Shopify events.

```
app/                    React Router app (Netlify)
  routes/               Pages and HTTPS endpoints
  shopify.server.ts     shopifyApp(), sessions, unauthenticated.admin
  db.server.ts          Prisma + Aiven (pool max 1)
  record-planet.server.ts
  order-status-pro.server.ts
  webhook-retry-publish.server.ts
webhooks/               Cloud Run worker, queue, handlers
tests/                  Vitest suite (`tests/**/*.test.ts`)
vitest.config.ts        Node environment; excludes extensions
docs/                   Architecture and deploy (keep in sync with code)
.github/workflows/      CI (test + typecheck) and Cloud Run worker deploy
netlify/functions/      warm-app (hits /api/health every 5 min)
prisma/                 Schema + migrations
extensions/             Admin action extensions (Shopify-hosted)
certs/aiven-ca.pem      TLS CA for Aiven
shopify.app.toml        App URL, scopes, webhook destinations
Dockerfile.worker       Image for Cloud Run
```

Behavior changes must update **docs and tests in the same change**. Read this file and the linked docs before editing. Tests stay in `tests/` (not colocated), mock Prisma / Shopify / GCP, and do not need a live database. Polaris UI and Shopify-hosted extensions are not in the suite.

## Netlify routes

| Path | Role |
|---|---|
| `/app` | Embedded shell + nav (Record Planet, Webhook DLQ) |
| `/app/record-planet` | Record Planet orders, search, status updates |
| `/app/webhooks-admin` | Dead-letter queue for `WebhookFailure` (Redrive) |
| `/auth/*` | OAuth |
| `/api/health` | Keep-warm target (`CRON_SECRET`) |
| `/api/update-status`, `/api/viable-statuses`, `/api/order-status-sync` | StatusPro from the UI. All three use `authenticate.admin()`. Status update and viable-statuses also require the order to belong to `session.shop`. |
| `/api/webhooks/order-status-pro/:token` | StatusPro inbound (not Shopify) |
| `/webhooks/app/uninstalled` | HTTPS Shopify lifecycle |
| `/webhooks/app/scopes_update` | HTTPS Shopify lifecycle |
| `/print/pick-list` | Pick list print (`authenticate.admin()`, IDs as `BigInt`, orders scoped to `session.shop`) |

There are **no** `/api/webhooks/products` or `/api/webhooks/orders` routes. Those topics go to Pub/Sub.

## Webhook code (`webhooks/`)

See [webhooks/README.md](../webhooks/README.md).

- **Product** — rebuild `descriptionHtml` from metafields.
- **Order create** — persist the order, mark fulfillment in progress when applicable. Fulfillment orders are paginated (50 per page).

`queue.server.ts` coalesces work on `(shop, handler, resourceId)`, claims the row (`processing`, lease on `lastAttemptAt`), then runs the handler via `unauthenticated.admin(shop)`. A `processing` row older than 3 minutes can be claimed again or redriven. Success deletes the row. Failure increments `attempts`; after 5 failures, no session, or a terminal error (`product_not_found`, non-retryable GraphQL) the row is `failed` and Pub/Sub is acked. Invalid / unknown messages are stored as `ack_drop` (still HTTP 200). `/app/webhooks-admin` is the DLQ; Redrive republishes via `app/webhook-retry-publish.server.ts` (not `ack_drop` rows; stale processing is allowed). Netlify does not run handlers.

Cloud Run starts `webhooks/worker.server.ts` (plain `node:http`). `GET /` is liveness; `GET /health` pings Postgres. SIGTERM drains in-flight pushes before `closeDb()`. The image still copies `app/` so the worker can load Prisma and the offline session.

Record Planet queries filter by `session.shop`. `shopifyApp()` uses `AppDistribution.SingleMerchant`.

## Extensions

- `extensions/pick-list-print` — admin action to print a pick list.
- `extensions/ready-for-pickup` — admin action for ready-for-pickup.

They ship with `shopify app deploy`, not Netlify. Each extension has its own `tsconfig.json`; the repo root typecheck excludes `extensions/`.

## Tests

Top-level `tests/` is the suite. `vitest.config.ts` includes `tests/**/*.test.ts`. CI and the pre-commit hook run `yarn test`. Use `yarn test:watch` while editing.

| File | Covers |
|---|---|
| `parse-pubsub.test.ts` | Pub/Sub envelope, topics, ack-drop context |
| `queue.test.ts` | Coalesce, claim/lease, enqueue, DLQ, retries |
| `product-description.test.ts` | Hidden Shop-channel HTML, metafield sync |
| `orders-create.handler.test.ts` | Order import, Record Planet fulfillment |
| `shopify-fulfillment.test.ts` | Fulfillment-order paging and `REPORT_PROGRESS` |
| `worker.test.ts` | Cloud Run HTTP: ack, 500 retry, health, shutdown |
| `record-planet.test.ts` | Search helpers and `/app/record-planet` loader |
| `order-status-pro.test.ts` | StatusPro client, cache, admin + inbound routes |
| `webhook-retry-publish.test.ts` | Redrive to Pub/Sub |
| `admin-routes.test.ts` | DLQ admin, pick list, HTTPS lifecycle |
| `cron-health.test.ts` | Cron auth, `/api/health`, site URL |
| `warm-app.test.ts` | Netlify keep-warm |

When you change a route, handler, queue rule, or StatusPro contract, add or update the matching file. Do not invent a second test tree.

## CI

`.github/workflows/ci.yml` runs `yarn test` and `yarn typecheck` on pull requests and pushes to `main`. The pre-commit hook still runs `yarn test` locally. Worker deploys stay in `deploy-webhooks.yml`.

## Database

Aiven Postgres (`max_connections` is 20 on the current Free-sized instance). Prisma `max: 1` per process. Cloud Run is `concurrency=1` and `max-instances=2`, so the worker uses at most two connections. Netlify keep-warm and admin add a few more. There is no Aiven PgBouncer on Free. `Order` is indexed on `(shop, deliveryMethod)` for Record Planet list/search.
