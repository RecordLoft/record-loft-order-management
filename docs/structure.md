# Repository structure

Custom app on the Shopify React Router template. Runtime is split: Netlify serves HTTP for people; Cloud Run serves Pub/Sub for Shopify events.

```
app/                    React Router app (Netlify)
  routes/               Pages and HTTPS endpoints
  shopify.server.ts     shopifyApp(), sessions, unauthenticated.admin
  db.server.ts          Prisma + Aiven (pool max 1)
  record-planet.server.ts
  order-status-pro.server.ts
  order-import-pending.server.ts
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

Behavior changes must update **docs and tests in the same change**. Read this file and the linked docs before editing. Tests stay in `tests/` (not colocated). `yarn test` mocks Prisma / Shopify / GCP and does not need a live database. `yarn test:integration` uses Testcontainers Postgres (Docker) and still mocks Shopify / GCP. Polaris UI and Shopify-hosted extensions are not in the suite.

## Netlify routes

| Path | Role |
|---|---|
| `/app` | Embedded shell + nav (Record Planet, Webhook DLQ) |
| `/app/record-planet` | Record Planet orders, search, Active/Closed (cancelled, fully refunded, or fulfilled)/All view, status updates |
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

- **Product** — rebuild `descriptionHtml` from metafields. GraphQL errors retry; `product_not_found` is terminal.
- **Order create** — persist the order (including custom line items with no `product_id`), apply any `OrderImportPending` cancel/refund/fulfill/OSP fields, mark fulfillment in progress when applicable. Fulfillment orders are paginated (50 per page). List/`REPORT_PROGRESS` GraphQL errors retry; leftover OPEN orders are not a silent success. Already-done FO statuses include FULFILLED, CLOSED, IN_PROGRESS, and CANCELLED (case-insensitive). If the create payload is already `fulfillment_status: fulfilled`, `fulfilledAt` is set on import.
- **Order cancelled / refund created / fulfilled** — set `cancelledAt` / `refundedAt` (full refund only) / `fulfilledAt` (fully fulfilled). A partial refund does not set `refundedAt`, so the order stays Active. Full refund is `financial_status: refunded` or refund line quantities covering every imported line item (or every line in the payload before import). DB-only; no Admin session required. If the order is not imported yet, the flags land on `OrderImportPending`.
- **StatusPro** — fail-fast on client or OSP 429 (no sleep in Netlify). Bulk updates start at 5 orders.

`queue.server.ts` coalesces work on `(shop, handler, resourceId)`, claims the row (`processing`, lease on `lastAttemptAt`), then runs the handler. Product and orders-create use `unauthenticated.admin(shop)`; cancel/refund/fulfill do not. A `processing` row older than 90 seconds can be claimed again or redriven. Success deletes the row. Failure increments `attempts`; after 5 failures, no session (product/create only), or a terminal error (`product_not_found`, non-retryable GraphQL `userErrors`) the row is `failed` and Pub/Sub is acked. Invalid / unknown messages are stored as `ack_drop` (HTTP 200 once persisted), each with a unique `resourceId` so distinct poison messages do not overwrite each other. If ack-drop persist fails, the worker returns 500 so Pub/Sub retries. SIGTERM releases the claimed row back to `pending`. `/app/webhooks-admin` is the DLQ; Redrive republishes via `app/webhook-retry-publish.server.ts` (not `ack_drop` rows; stale processing is allowed). Netlify does not run handlers.

Cloud Run starts `webhooks/worker.server.ts` compiled to `dist/worker.js` (plain `node`). `GET /` is liveness; `GET /health` pings Postgres. SIGTERM releases the claimed row and drains in-flight pushes (capped at 50s) before `closeDb()`. Push bodies over 2MB are ack-dropped after persist. The image still copies `app/` so the worker can load Prisma and the offline session. Worker, queue, and Cloud Run handlers write one JSON line per event (`severity`, `message`, `topic`, `shop`, `resourceId`, `outcome`, `cold`, plus `logging.googleapis.com/trace` from `X-Cloud-Trace-Context`) so Log Explorer can filter `jsonPayload`. `message` is the list-line summary (`[component] what happened key=value`) — see [webhooks.md](webhooks.md#log-explorer).

Record Planet queries filter by `session.shop` and default to **Active** (not cancelled, fully refunded, or fulfilled). `?view=closed` or `?view=all` includes those orders; search uses the same view. The storefront allows only one Record Planet item per cart, bought alone, so the list and search treat `lineItems[0]` as the product. `shopifyApp()` uses `AppDistribution.SingleMerchant`.

## Extensions

- `extensions/pick-list-print` — admin action to print a pick list.
- `extensions/ready-for-pickup` — admin action for ready-for-pickup.

They ship with `shopify app deploy`, not Netlify. Each extension has its own `tsconfig.json`; the repo root typecheck excludes `extensions/`.

## Tests

Top-level `tests/` is the suite. `vitest.config.ts` includes `tests/**/*.test.ts` and excludes `*.integration.test.ts`. CI and the pre-commit hook run `yarn test`. Use `yarn test:watch` while editing.

`yarn test:integration` (`vitest.integration.config.ts`) starts Postgres via Testcontainers, runs `prisma migrate deploy`, and exercises SQL the unit mocks hide: queue unique keys / leases, Record Planet ILIKE and views, pending-import apply. Shopify GraphQL, StatusPro HTTP, and Pub/Sub stay mocked. Docker is required. CI runs this after `yarn test`; pre-commit does not.

Shopify webhook JSON fixtures live in `tests/fixtures/` and are used by the handler unit tests and the pending-import integration test.

| File | Covers |
|---|---|
| `parse-pubsub.test.ts` | Pub/Sub envelope, topics, ack-drop context |
| `queue.test.ts` | Coalesce, claim/lease, enqueue (no steal of live processing), DLQ, retries |
| `product-description.test.ts` | Hidden Shop-channel HTML, metafield sync |
| `orders-create.handler.test.ts` | Order import, Record Planet fulfillment, Shopify create fixture |
| `shopify-fulfillment.test.ts` | Fulfillment-order paging and `REPORT_PROGRESS` |
| `orders-lifecycle.handler.test.ts` | Cancel / refund / fulfill persist, pending import apply, Shopify fixtures |
| `log.test.ts` | Cloud Run JSON log fields, severity, Error stack, trace header |
| `worker.test.ts` | Cloud Run HTTP: ack, 500 retry, health, ALLOWED_TOPICS, `/pubsub`, shutdown, `cold` |
| `record-planet.test.ts` | Search helpers and `/app/record-planet` loader (`view` / `q`) |
| `order-status-pro.test.ts` | StatusPro client, client throttle, cache, admin + inbound routes |
| `webhook-retry-publish.test.ts` | Redrive to Pub/Sub (failed + stale processing; publish failure) |
| `admin-routes.test.ts` | DLQ admin (`status` filter), pick list, HTTPS lifecycle |
| `cron-health.test.ts` | Cron auth, `/api/health`, site URL, Cloud Run session-storage probe |
| `warm-app.test.ts` | Netlify keep-warm |
| `queue.integration.test.ts` | Coalesce, DLQ resurrect, live lease, 90s steal, ack-drop uniqueness |
| `record-planet.integration.test.ts` | ILIKE escape, phone digits, Active/Closed/All, shop scope |
| `order-import.integration.test.ts` | Cancel + OSP pending applied on create |

When you change a route, handler, queue rule, or StatusPro contract, add or update the matching file. Do not invent a second test tree.

## CI

`.github/workflows/ci.yml` runs `yarn test`, `yarn test:integration` (Docker / Testcontainers Postgres), and `yarn typecheck` on pull requests and pushes to `main`. The pre-commit hook still runs `yarn test` locally (no Docker). Worker deploys stay in `deploy-webhooks.yml` (test → integration → `prisma migrate deploy` with `DATABASE_URL`/`DIRECT_URL` secrets → Cloud Run).

## Database

Aiven Postgres (`max_connections` is 20 on the current Free-sized instance). Prisma `max: 1` per process. Cloud Run is `concurrency=1` and `max-instances=2`, so the worker uses at most two connections. Netlify keep-warm plus a single admin user add a few more; that is well under the Free cap. There is no Aiven PgBouncer on Free. `Order` is indexed on `(shop, deliveryMethod)` for Record Planet list/search. `OrderImportPending` holds cancel/refund/fulfill/OSP status that arrived before `orders/create`. Aiven URLs set `sslmode=require` and use `certs/aiven-ca.pem`. Local and Testcontainers URLs without `sslmode` skip TLS.
