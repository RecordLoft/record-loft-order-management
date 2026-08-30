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

Needs `.env` with `DATABASE_URL` (Aiven) and the Shopify app client id/secret (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`). Retry from local `shopify app dev` or Netlify admin also needs `GCP_PUBSUB_SA_JSON` — see [docs/webhooks.md](docs/webhooks.md#environment).

## Production deploys

1. **Netlify** — git push builds the React Router app (`@netlify/vite-plugin-react-router`).
2. **Cloud Run worker** — GitHub Action `Deploy webhooks` builds `Dockerfile.worker` and deploys `shopify-webhooks`. See [docs/deploy-webhooks.md](docs/deploy-webhooks.md).
3. **Shopify app version** — `shopify app deploy` syncs `shopify.app.toml` (webhook URIs, scopes, extensions). Required when webhook destinations change.

Do not deploy the root `Dockerfile` to Cloud Run. That image is the unused full-app template, not the worker.
