# Webhooks

Shopify app-specific subscriptions live in `shopify.app.toml`. Changing destinations requires `shopify app deploy`. Worker code lives in `webhooks/`. Deploy is [docs/deploy-webhooks.md](deploy-webhooks.md).

## What goes where

| Topic | Destination | Why |
|---|---|---|
| `products/create`, `products/update` | `pubsub://record-loft:shopify-products` | High volume. Shopify succeeds when GCP accepts the publish, not when GraphQL finishes. |
| `orders/create` | `pubsub://record-loft:shopify-orders` | Same worker URL, separate topic so you can split later. |
| `app/uninstalled`, `app/scopes_update` | HTTPS on Netlify | Rare, part of the app install. Shopify HMAC via `authenticate.webhook()`. |
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

`concurrency=1`, `max-instances=2`. Extra messages wait in Pub/Sub. That is the Aiven backpressure (not a Netlify 5-job batch). Push subscriptions `shopify-products-push` and `shopify-orders-push` use `ackDeadlineSeconds=60` (same as the Cloud Run timeout) so a slow handler is not redelivered mid-request.

A successful product description write can fire another `products/update`. Coalesce + “skip if HTML unchanged” limit the echo.

## Why the worker does not verify HMAC

Shopify’s docs say HMAC is for **HTTPS** deliveries. Pub/Sub is authenticated by who can publish to the topic, then by Cloud Run `--no-allow-unauthenticated` (only the push subscription can POST). That is the documented contract.

Messages often include `X-Shopify-Hmac-SHA256` as an attribute, but Shopify does not guarantee it on this transport or document what bytes are signed. Requiring a match (or even verifying only when the attribute is present) 200-ack-drops the event if they omit the header or change the digest. The worker would look healthy and the shop would miss product/order work.

So Cloud Run does not check HMAC. Trust is:

- Topic `roles/pubsub.publisher`: `delivery@shopify-pubsub-webhooks.iam.gserviceaccount.com` and `netlify-pubsub-publisher@record-loft.iam.gserviceaccount.com` only
- Cloud Run invoker: the Pub/Sub push subscription

```bash
gcloud pubsub topics get-iam-policy shopify-products --project=record-loft
gcloud pubsub topics get-iam-policy shopify-orders --project=record-loft
```

HTTPS `app/uninstalled` and `app/scopes_update` on Netlify still use `authenticate.webhook()` HMAC. That path is documented and required.

`X-Retry-Source=admin` on republish is a log tag (`source=admin-retry` vs `source=shopify-publish`). It is not a security bypass.

## Failure handling

`WebhookFailure` is the dead-letter queue. There is no GCP dead-letter topic.

- **Pending** — handler failed, `attempts < 5`. Worker returns HTTP 500 so Pub/Sub redelivers.
- **Failed** — attempt 5 exhausted, or no offline session. Worker returns 200 so Pub/Sub stops. These rows are the DLQ.
- **Success** — row is deleted.

**App → Webhook DLQ** (`/app/webhooks-admin`) defaults to failed rows. **Redrive** publishes the stored payload back to Pub/Sub and resets `attempts` to 0. A new Shopify event for the same product/order does the same reset (fresh 5 tries) without opening the DLQ. Retrying (pending) rows are read-only on the page. Netlify does not run handlers.

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

Pub/Sub retries on HTTP 500 while `attempts < 5`. Exhausted failures and no offline session return 200 (row stays in the DLQ). Poison / unknown topic also returns 200 so the message is dropped.

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

`X-Retry-Source=admin` is a log tag (same as Webhook DLQ Redrive). It is not required for the worker to accept the message. Topic publish IAM is the gate.

Use a real product id. A fake id (`1`) returns `product_not_found` and Pub/Sub will retry until you seek the subscription.

Shopify CLI `webhook trigger` to `pubsub://record-loft:shopify-products` tests publish. The CLI shop has no offline session, so GraphQL will fail; that does not mean the subscription is wrong.

## After changing toml

```bash
shopify app deploy
```

Wait a few minutes, edit a product in admin, then Cloud Run logs should show `[pubsub-worker] topic=products/update`.
