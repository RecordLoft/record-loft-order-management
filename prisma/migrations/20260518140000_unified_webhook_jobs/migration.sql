-- Cleanup abandoned local-only table (safe no-op in production)
DROP TABLE IF EXISTS "ProductDescriptionSyncJob";
DROP TYPE IF EXISTS "ProductDescriptionSyncStatus";

-- CreateEnum
CREATE TYPE "WebhookJobStatus" AS ENUM ('pending', 'processing', 'completed', 'skipped', 'failed');

-- CreateEnum
CREATE TYPE "WebhookJobHandler" AS ENUM ('product_description_sync', 'orders_create');

-- CreateTable
CREATE TABLE "WebhookJob" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "handler" "WebhookJobHandler" NOT NULL,
    "topic" TEXT NOT NULL,
    "resourceId" BIGINT NOT NULL,
    "resourceGid" TEXT,
    "webhookId" TEXT,
    "payload" JSONB NOT NULL,
    "status" "WebhookJobStatus" NOT NULL DEFAULT 'pending',
    "outcome" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastAttemptAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookJob_status_createdAt_idx" ON "WebhookJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookJob_shop_handler_status_idx" ON "WebhookJob"("shop", "handler", "status");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookJob_shop_handler_resourceId_key" ON "WebhookJob"("shop", "handler", "resourceId");
