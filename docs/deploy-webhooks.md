# Deploy the webhook worker

GitHub Actions builds `Dockerfile.worker` (the Cloud Run image; there is no app `Dockerfile`) and deploys Cloud Run `shopify-webhooks` on push to `main` (path-filtered) or **Actions → Deploy webhooks → Run workflow**. Jobs run in order: **test** (`yarn test` + `yarn typecheck`) → **migrate** (`yarn prisma migrate deploy`) → **deploy**.

The migrate job needs GitHub secrets `DATABASE_URL` and `DIRECT_URL` (Aiven). Without them the workflow fails before Cloud Run updates, so a schema-changing revision cannot start against an unmigrated database. The worker image still does not run migrations itself.

Auth for the deploy job is **Workload Identity Federation**. There is no GCP JSON key in GitHub.

Existing Cloud Run env (`DATABASE_URL`, Shopify client id/secret, `SCOPES`, `SHOPIFY_APP_URL`) is left as-is. Only the migrate job uses `DATABASE_URL` / `DIRECT_URL` from secrets.

## One-time GCP + GitHub setup

Run this from a machine already logged into `gcloud` on project `record-loft`:

```bash
PROJECT_ID=record-loft
REPO=RecordLoft/record-loft-order-management
SA_NAME=github-webhooks-deploy
POOL=github
PROVIDER=github

PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
RUNTIME_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud iam service-accounts create "$SA_NAME" \
  --project="$PROJECT_ID" \
  --display-name="GitHub Actions webhook deploy" \
  || true

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA}" \
  --role=roles/run.admin \
  --condition=None

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SA}" \
  --role=roles/artifactregistry.writer \
  --condition=None

gcloud iam service-accounts add-iam-policy-binding "$RUNTIME_SA" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:${SA}" \
  --role=roles/iam.serviceAccountUser

gcloud iam workload-identity-pools create "$POOL" \
  --project="$PROJECT_ID" \
  --location=global \
  --display-name="GitHub Actions" \
  || true

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" \
  --project="$PROJECT_ID" \
  --location=global \
  --workload-identity-pool="$POOL" \
  --display-name="GitHub" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.actor=assertion.actor" \
  --attribute-condition="assertion.repository=='${REPO}'" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  || true

gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${REPO}"

echo
echo "Add these GitHub repo variables (Settings → Secrets and variables → Actions → Variables):"
echo "  GCP_WIF_PROVIDER=projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"
echo "  GCP_DEPLOY_SA=${SA}"
```

Also add **secrets** `DATABASE_URL` and `DIRECT_URL` (Aiven) so the migrate job can run `prisma migrate deploy` before Cloud Run updates.

The first `gcloud run deploy` from Actions can take a minute. After that, image layers cache on the runner. Deploy uses `--cpu-boost` (extra CPU only during startup; still request-based billing, no min instances). The image runs `node dist/worker.js`.

## Manual fallback

```bash
docker build -f Dockerfile.worker -t us-central1-docker.pkg.dev/record-loft/webhooks/shopify-webhooks:local .
docker push us-central1-docker.pkg.dev/record-loft/webhooks/shopify-webhooks:local

gcloud run deploy shopify-webhooks \
  --project=record-loft \
  --region=us-central1 \
  --image=us-central1-docker.pkg.dev/record-loft/webhooks/shopify-webhooks:local \
  --no-allow-unauthenticated \
  --concurrency=1 \
  --max-instances=2 \
  --cpu-boost \
  --timeout=60 \
  --port=8080
```

Or `gcloud builds submit . --project=record-loft --config=cloudbuild.worker.yaml` if you still want Cloud Build.

## After deploy

`GET /` on the service URL should return `{ ok: true }`. `GET /health` should return `{ ok: true, db: true }` (needs an authenticated caller; use Cloud Run logs or an identity token).

Edit a product in Shopify admin. In Log Explorer, filter `resource.labels.service_name="shopify-webhooks"` and `jsonPayload.topic="products/update"`. The summary line is `jsonPayload.message` (for example `[pubsub-worker] webhook completed topic=products/update shop=... resourceId=...`).
