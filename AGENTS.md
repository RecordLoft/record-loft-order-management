# Agent notes

This repo has architecture docs and a Vitest suite. Both are part of the product. Read them before editing, and update them when behavior changes.

## Read first

- [docs/structure.md](docs/structure.md) — hosts, routes, queue/DLQ, **test map**
- [docs/webhooks.md](docs/webhooks.md) — Pub/Sub vs HTTPS, ack/retry, env
- [webhooks/README.md](webhooks/README.md) — worker files
- [docs/deploy-webhooks.md](docs/deploy-webhooks.md) — Cloud Run only when changing deploy

## Tests

- Location: top-level `tests/` only. Do not colocate server/route/worker tests.
- Run: `yarn test` (CI + pre-commit) or `yarn test:watch`.
- Style: mock `app/db.server` and `app/shopify.server`. No live database, Pub/Sub, or StatusPro.
- Integration: `yarn test:integration` (CI, Docker). Testcontainers Postgres; still mock Shopify / GCP. Files are `tests/**/*.integration.test.ts`.
- If you change a handler, route, queue rule, or StatusPro contract, update the matching file listed in `docs/structure.md`.
- Polaris UI and `extensions/` are out of scope unless you add a React test harness.

## Docs

If a route, topic, retry rule, env var, or host split changes, update the doc that describes it. Do not leave README / `docs/` describing the old flow.
