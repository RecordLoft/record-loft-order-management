ALTER TABLE "Order" ADD COLUMN "ospStatusCode" TEXT;
ALTER TABLE "Order" ADD COLUMN "ospStatusName" TEXT;
ALTER TABLE "Order" ADD COLUMN "ospStatusSyncedAt" TIMESTAMP(3);
