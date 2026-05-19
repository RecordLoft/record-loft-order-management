-- Drop successful rows; table only retains failures for retry/debug.
DELETE FROM "WebhookJob" WHERE status IN ('completed', 'skipped');

ALTER TABLE "WebhookJob" RENAME TO "WebhookFailure";

ALTER TYPE "WebhookJobHandler" RENAME TO "WebhookFailureHandler";

CREATE TYPE "WebhookFailureStatus" AS ENUM ('pending', 'processing', 'failed');

ALTER TABLE "WebhookFailure" ALTER COLUMN "status" DROP DEFAULT;

ALTER TABLE "WebhookFailure"
  ALTER COLUMN "status" TYPE "WebhookFailureStatus"
  USING ("status"::text::"WebhookFailureStatus");

DROP TYPE "WebhookJobStatus";

ALTER TABLE "WebhookFailure" ALTER COLUMN "status" SET DEFAULT 'pending';

ALTER INDEX "WebhookJob_pkey" RENAME TO "WebhookFailure_pkey";
ALTER INDEX "WebhookJob_status_createdAt_idx" RENAME TO "WebhookFailure_status_createdAt_idx";
ALTER INDEX "WebhookJob_shop_handler_status_idx" RENAME TO "WebhookFailure_shop_handler_status_idx";
ALTER INDEX "WebhookJob_shop_handler_resourceId_key" RENAME TO "WebhookFailure_shop_handler_resourceId_key";
