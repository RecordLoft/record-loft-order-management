import { prisma } from "../app/db.server";

export const INTEGRATION_SHOP = "record-loft.myshopify.com";

export async function resetIntegrationDb(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "LineItem",
      "Order",
      "Customer",
      "OrderImportPending",
      "WebhookFailure",
      "Session"
    RESTART IDENTITY CASCADE
  `);
}
