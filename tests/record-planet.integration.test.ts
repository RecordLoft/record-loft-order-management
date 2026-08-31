import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../app/db.server";
import {
  matchingOrderIds,
  matchingOrderIdsByCustomer,
  recordPlanetOrderWhere,
} from "../app/record-planet.server";
import { INTEGRATION_SHOP, resetIntegrationDb } from "./integration-db";

async function seedRecordPlanetOrder(input: {
  id: bigint;
  orderNumber: number;
  title: string;
  properties?: Record<string, string>;
  phone?: string | null;
  cancelledAt?: Date | null;
  shop?: string;
}) {
  const shop = input.shop ?? INTEGRATION_SHOP;
  const customerId = input.id;
  await prisma.customer.create({
    data: {
      id: customerId,
      email: `buyer-${input.orderNumber}@example.com`,
      firstName: "Ada",
      lastName: "Lovelace",
      phone: input.phone ?? null,
    },
  });
  await prisma.order.create({
    data: {
      id: input.id,
      orderNumber: input.orderNumber,
      shop,
      totalPrice: 32,
      currency: "USD",
      deliveryMethod: "recordPlanet",
      customerId,
      cancelledAt: input.cancelledAt ?? null,
      lineItems: {
        create: {
          id: input.id * 10n,
          title: input.title,
          quantity: 1,
          price: 32,
          properties: input.properties ?? {},
        },
      },
    },
  });
}

describe("Record Planet SQL against Postgres", () => {
  beforeEach(async () => {
    await resetIntegrationDb();
  });

  it("escapes ILIKE wildcards so _ is literal", async () => {
    await seedRecordPlanetOrder({
      id: 1n,
      orderNumber: 101,
      title: "Kind of Blue",
    });
    await seedRecordPlanetOrder({
      id: 2n,
      orderNumber: 102,
      title: "A_B mix",
    });

    await expect(matchingOrderIds(INTEGRATION_SHOP, "_")).resolves.toEqual([
      2n,
    ]);
  });

  it("matches phone digits after stripping punctuation", async () => {
    await seedRecordPlanetOrder({
      id: 3n,
      orderNumber: 103,
      title: "Blue Train",
      phone: "(555) 010-0199",
    });

    await expect(
      matchingOrderIdsByCustomer(INTEGRATION_SHOP, "0100"),
    ).resolves.toEqual([3n]);
    await expect(
      matchingOrderIdsByCustomer(INTEGRATION_SHOP, "555"),
    ).resolves.toEqual([3n]);
  });

  it("hides cancelled orders from Active and returns them in Closed", async () => {
    await seedRecordPlanetOrder({
      id: 4n,
      orderNumber: 104,
      title: "Active title",
    });
    await seedRecordPlanetOrder({
      id: 5n,
      orderNumber: 105,
      title: "Cancelled title",
      cancelledAt: new Date("2026-08-01T00:00:00Z"),
    });

    await expect(matchingOrderIds(INTEGRATION_SHOP, "title")).resolves.toEqual([
      4n,
    ]);
    await expect(
      matchingOrderIds(INTEGRATION_SHOP, "title", "closed"),
    ).resolves.toEqual([5n]);
    await expect(
      matchingOrderIds(INTEGRATION_SHOP, "title", "all"),
    ).resolves.toEqual(expect.arrayContaining([4n, 5n]));
    expect(await matchingOrderIds(INTEGRATION_SHOP, "title", "all")).toHaveLength(
      2,
    );
  });

  it("scopes search to the session shop", async () => {
    await seedRecordPlanetOrder({
      id: 6n,
      orderNumber: 106,
      title: "Kind of Blue",
    });
    await seedRecordPlanetOrder({
      id: 7n,
      orderNumber: 107,
      title: "Kind of Blue",
      shop: "other.myshopify.com",
    });

    const where = await recordPlanetOrderWhere(INTEGRATION_SHOP, "Kind");
    expect(where.shop).toBe(INTEGRATION_SHOP);
    expect(where.id).toEqual({ in: [6n] });
  });
});
