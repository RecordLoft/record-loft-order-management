-- DropColumn (safe if never added)
ALTER TABLE "WebhookJob" DROP COLUMN IF EXISTS "nextAttemptAt";

-- DropIndex
DROP INDEX IF EXISTS "WebhookJob_status_nextAttemptAt_idx";
