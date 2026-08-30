# Webhooks

Shopify app-specific subscriptions live in `shopify.app.toml`. Changing destinations requires `shopify app deploy`. Worker code lives in `webhooks/`. Deploy is [docs/deploy-webhooks.md](deploy-webhooks.md).

## What goes where

| Topic | Destination | Why |
|---|---|---|
| `products/create`, `products/update` | `pubsub://record-loft:shopify-products` | High volume. Shopify succeeds when GCP accepts the publish, not when GraphQL finishes. |
| `orders/create` | `pubsub://record-loft:shopify-orders` | Same worker URL, separate topic so you can split later. |
| `app/uninstalled`, `app/scopes_update` | HTTPS on Netlify | Rare, part of the app install. |
| StatusPro | `/api/webhooks/order-status-pro/:token` | Third party, not Shopify HMAC. |

`SHOPIFY_APP_URL` is still `https://record-loft-order-management.netlify.app`. That is the **embedded app**, not the webhook URL. Cloud Run needs it only because it reuses `shopifyApp()` to load the offline session.

## Flow (products / orders)

```
Shop event
  → Shopify publishes to Pub/Sub          (delivery success)
      → push subscription (OIDC)
          → Cloud Run shopify-webhooks
              → enqueue (coalesce same product/order)
              → handleProductDescriptionSync / handleOrdersCreate
              → 200 ack or 500 retry
```

Both topics push to the same service. Example URL (may change on recreate):

`https://shopify-webhooks-hoyw7t3asq-uc.a.run.app/`

Resolve the current URL:

```bash
gcloud run services describe shopify-webhooks --project=record-loft --region=us-central1 --format='value(status.url)'
```

`concurrency=1`, `max-instances=2`. Extra messages wait in Pub/Sub. That is the Aiven backpressure (not a Netlify 5-job batch).

A successful product description write can fire another `products/update`. Coalesce + “skip if HTML unchanged” limit the echo.

## Failure handling

Rows in `WebhookFailure`: pending / processing / failed. Success deletes the row. Merchants retry from **App → Webhook status** (`/app/webhooks-admin`). Retry publishes the stored payload back to Pub/Sub; Cloud Run runs the handler. Netlify does not process webhook work.

Netlify (and local retry) need `GCP_PUBSUB_SA_JSON` — the publish-only service account JSON.

```bash
PROJECT_ID=record-loft
SA=netlify-pubsub-publisher@${PROJECT_ID}.iam.gserviceaccount.com

gcloud iam service-accounts create netlify-pubsub-publisher \
  --project="$PROJECT_ID" \
  --display-name="Netlify webhook retry publisher"

gcloud pubsub topics add-iam-policy-binding shopify-products \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${SA}" \
  --role=roles/pubsub.publisher

gcloud pubsub topics add-iam-policy-binding shopify-orders \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${SA}" \
  --role=roles/pubsub.publisher

gcloud iam service-accounts keys create /tmp/netlify-pubsub-publisher.json \
  --iam-account="$SA" \
  --project="$PROJECT_ID"
```

Paste the JSON file contents into Netlify as `GCP_PUBSUB_SA_JSON`. Do not commit the key.

Pub/Sub retries on HTTP 500 (handler error, no offline session). Poison / unknown topic returns 200 so the message is dropped.

## Environment

**Netlify** (app): `DATABASE_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SCOPES`, `SHOPIFY_APP_URL`, StatusPro + `CRON_SECRET` as used today, plus `GCP_PUBSUB_SA_JSON` so admin retry can publish.

**Cloud Run** (worker):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Aiven (same as Netlify) |
| `SHOPIFY_API_KEY` | Partner **Client ID** |
| `SHOPIFY_API_SECRET` | Partner **Client secret** |
| `SCOPES` | Same list as `shopify.app.toml` |
| `SHOPIFY_APP_URL` | Netlify app URL (library init, not ingress) |
| `ALLOWED_TOPICS` | Optional. Default is products + orders. |

Not needed on Cloud Run: `DIRECT_URL`, StatusPro, `CRON_SECRET`.

`SHOPIFY_API_KEY` / `SECRET` are the app client id and secret, not the shop’s Admin access token. The token is the offline session in Postgres.

## Test without Shopify

```bash
gcloud pubsub topics publish shopify-products \
  --project=record-loft \
  --message='{"id":YOUR_PRODUCT_NUMERIC_ID}' \
  --attribute=X-Shopify-Topic=products/update,X-Shopify-Shop-Domain=YOUR_SHOP.myshopify.com,X-Shopify-Webhook-Id=manual-1,X-Retry-Source=admin
```

`X-Retry-Source=admin` skips Shopify HMAC (same as `/app/webhooks-admin` retry). Live Shopify messages must include a valid HMAC.

Use a real product id. A fake id (`1`) returns `product_not_found` and Pub/Sub will retry until you seek the subscription.

Shopify CLI `webhook trigger` to `pubsub://record-loft:shopify-products` tests publish. The CLI shop has no offline session, so GraphQL will fail; that does not mean the subscription is wrong.

## After changing toml

```bash
shopify app deploy
```

Wait a few minutes, edit a product in admin, then Cloud Run logs should show `[pubsub-worker] topic=products/update`.
