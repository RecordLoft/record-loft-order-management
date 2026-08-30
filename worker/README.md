# Cloud Run webhook worker

Plain Node HTTP server (`tsx worker/server.ts`). Not React Router.

- `GET /` or `/health` — startup probe
- `POST /` or `/pubsub` — Pub/Sub push envelope (base64 `message.data` + Shopify attributes)

It imports `app/webhook-queue.server.ts` and the existing handlers. Image: `Dockerfile.worker` (Node 22). Do not use the root `Dockerfile`.

GCP project: `record-loft`. Region: `us-central1`. Service: `shopify-webhooks`.

## Deploy (after the image exists)

Local `gcloud run deploy --source --dockerfile` is not available on older CLIs. Build with Cloud Build, then deploy the image.

```bash
gcloud builds submit . --project=record-loft --config=cloudbuild.worker.yaml
```

```bash
set -a && source .env && set +a

gcloud run deploy shopify-webhooks \
  --project=record-loft \
  --region=us-central1 \
  --image=us-central1-docker.pkg.dev/record-loft/webhooks/shopify-webhooks:latest \
  --no-allow-unauthenticated \
  --concurrency=1 \
  --max-instances=2 \
  --timeout=60 \
  --port=8080 \
  --set-env-vars="^;^DATABASE_URL=${DATABASE_URL};SHOPIFY_API_KEY=${SHOPIFY_API_KEY};SHOPIFY_API_SECRET=${SHOPIFY_API_SECRET};SCOPES=${SCOPES};SHOPIFY_APP_URL=https://record-loft-order-management.netlify.app"
```

`.env` must include the Shopify client id/secret and `SCOPES` or the process exits before it binds `8080`.

## Subscriptions

Already created (recreate only if deleted):

| Subscription | Topic | Endpoint |
|---|---|---|
| `shopify-products-push` | `shopify-products` | `https://shopify-webhooks-hoyw7t3asq-uc.a.run.app/` |
| `shopify-orders-push` | `shopify-orders` | same |

Push uses the default compute SA as Invoker. Pub/Sub’s service agent needs `roles/iam.serviceAccountTokenCreator` on that SA.

One service handles both topics. Split later with a second deploy and `ALLOWED_TOPICS` if orders wait behind catalog bursts.

## Logs

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="shopify-webhooks"' \
  --project=record-loft --limit=30 --format='value(textPayload)'
```

Look for `[pubsub-worker]`.
