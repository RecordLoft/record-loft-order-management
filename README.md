# Record Loft Order Management

Embedded Shopify app for Record Loft. Merchants use it inside admin for Record Planet orders, pick lists, fulfillment status, and webhook dead letters. Catalog and order **events** are not handled on Netlify; Shopify publishes those to Google Pub/Sub and Cloud Run runs the handlers.

| Surface | Host |
|---|---|
| Embedded admin, OAuth, StatusPro webhook, HTTPS lifecycle (`app/uninstalled`, `app/scopes_update`) | **Netlify** (`application_url`) |
| `products/create`, `products/update`, `orders/create` | **Pub/Sub → Cloud Run** |
| Sessions, queued/failed jobs | **Aiven Postgres** |
| Admin action extensions | **Shopify** (not this host) |

## Docs

- [How the app is structured](docs/structure.md)
- [Webhooks and Pub/Sub](docs/webhooks.md)
- [Deploy the Cloud Run worker](docs/deploy-webhooks.md)
- [Webhook code](webhooks/README.md)

## Local development

```bash
yarn
yarn prisma generate
shopify app dev
```

`yarn` runs Husky, which installs a pre-commit hook that runs the full suite (`yarn test`). Use `yarn test:watch` while editing.

Needs `.env` with `DATABASE_URL` (Aiven) and the Shopify app client id/secret (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`). Redrive from local `shopify app dev` or Netlify admin also needs `GCP_PUBSUB_SA_JSON` — see [docs/webhooks.md](docs/webhooks.md#environment).

## Production deploys

Apply Prisma migrations **before** the worker or Netlify start using a new enum/column (`yarn prisma migrate deploy` against Aiven).

1. **Netlify** — git push builds the React Router app (`@netlify/vite-plugin-react-router`).
2. **Cloud Run worker** — GitHub Action `Deploy webhooks` builds `Dockerfile.worker` and deploys `shopify-webhooks`. See [docs/deploy-webhooks.md](docs/deploy-webhooks.md).
3. **Shopify app version** — `shopify app deploy` syncs `shopify.app.toml` (webhook URIs, API version, scopes, extensions). Required when destinations, API version, or extensions change.

Do not deploy the root `Dockerfile` to Cloud Run. That image is the unused full-app template, not the worker.

Admin GraphQL and webhook subscriptions use API version **2026-04** (`ApiVersion.April26` in `shopify.server.ts`, same value in `shopify.app.toml` and both extensions). The installed Shopify SDK has no July 2026 enum.
