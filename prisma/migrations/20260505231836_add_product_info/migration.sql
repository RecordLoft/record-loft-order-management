-- AlterTable
ALTER TABLE "LineItem" ADD COLUMN     "productType" TEXT,
ADD COLUMN     "properties" JSONB,
ADD COLUMN     "storeSection" TEXT;
