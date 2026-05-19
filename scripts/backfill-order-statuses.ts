/**
 * One-time backfill of Order Status Pro statuses for Record Planet orders.
 *
 *   yarn backfill:order-statuses
 */
import prisma from "../app/db.server";
import { backfillMissingOrderStatuses } from "../app/order-status-pro.server";

async function main() {
  const orders = await prisma.order.findMany({
    where: { deliveryMethod: "recordPlanet" },
    select: { id: true, ospStatusSyncedAt: true },
  });

  const uncached = orders
    .filter((order) => !order.ospStatusSyncedAt)
    .map((order) => order.id);

  console.log(
    `Record Planet orders: ${orders.length}, uncached: ${uncached.length}`,
  );

  if (uncached.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  await backfillMissingOrderStatuses(uncached);
  console.log("Backfill complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
