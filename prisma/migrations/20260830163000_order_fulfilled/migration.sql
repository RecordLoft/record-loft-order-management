-- AlterEnum
ALTER TYPE "WebhookFailureHandler" ADD VALUE 'orders_fulfilled';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN "fulfilledAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "OrderImportPending" ADD COLUMN "fulfilledAt" TIMESTAMP(3);
