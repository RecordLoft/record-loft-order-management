-- AlterEnum
ALTER TYPE "WebhookFailureHandler" ADD VALUE 'orders_cancelled';
ALTER TYPE "WebhookFailureHandler" ADD VALUE 'refunds_create';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "cancelledAt" TIMESTAMP(3),
ADD COLUMN "refundedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OrderImportPending" (
    "orderId" BIGINT NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "ospStatusName" TEXT,
    "ospStatusSyncedAt" TIMESTAMP(3),

    CONSTRAINT "OrderImportPending_pkey" PRIMARY KEY ("orderId")
);
