/**
 * Record Planet test data (IDs 9_000_000_xxx — will not collide with Shopify IDs).
 *
 *   yarn seed:test         — insert or refresh test data
 *   yarn seed:test:revert  — remove all test data
 *   yarn seed:test:reset   — revert, then seed again
 *
 * Requires DATABASE_URL in .env
 * Optional: SEED_SHOP (default: record-loft-test.myshopify.com)
 */
import { neonConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import "dotenv/config";
import ws from "ws";
import { PrismaClient } from "../generated/prisma/client";

neonConfig.webSocketConstructor = ws;

const adapter = new PrismaNeon({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({ adapter });

const SHOP = process.env.SEED_SHOP ?? "record-loft-test.myshopify.com";

/** All IDs owned by this seed — revert only touches these. */
export const TEST_DATA = {
  customerIds: [9_000_000_001n, 9_000_000_002n, 9_000_000_003n],
  orderIds: [
    9_000_000_101n,
    9_000_000_102n,
    9_000_000_103n,
    9_000_000_104n,
    9_000_000_105n,
    9_000_000_106n,
    9_000_000_107n,
    9_000_000_108n,
    9_000_000_199n,
  ],
  lineItemIds: [
    9_000_000_201n,
    9_000_000_202n,
    9_000_000_203n,
    9_000_000_204n,
    9_000_000_205n,
    9_000_000_206n,
    9_000_000_207n,
    9_000_000_208n,
    9_000_000_299n,
  ],
  orderNumbers: [
    9_500_001,
    9_500_002,
    9_500_003,
    9_500_004,
    9_500_005,
    9_500_006,
    9_500_007,
    9_500_008,
    9_500_099,
  ],
} as const;

type GloboProperties = Record<string, string>;

type SeedLineItem = {
  id: bigint;
  title: string;
  quantity: number;
  price: string;
  sku?: string;
  properties: GloboProperties | null;
};

type SeedOrder = {
  id: bigint;
  orderNumber: number;
  customerId: bigint;
  totalPrice: string;
  createdAt: Date;
  lineItems: SeedLineItem[];
};

const CUSTOMERS = [
  {
    id: 9_000_000_001n,
    email: "jane.doe@example.com",
    phone: "+1 (612) 555-0101",
    firstName: "Jane",
    lastName: "Doe",
  },
  {
    id: 9_000_000_002n,
    email: "john.smith@example.com",
    phone: "+1 (612) 555-0102",
    firstName: "John",
    lastName: "Smith",
  },
  {
    id: 9_000_000_003n,
    email: "alex.rivera@example.com",
    phone: "+1 (612) 555-0103",
    firstName: "Alex",
    lastName: "Rivera",
  },
] as const;

const ORDERS: SeedOrder[] = [
  {
    id: 9_000_000_101n,
    orderNumber: 9_500_001,
    customerId: 9_000_000_001n,
    totalPrice: "24.99",
    createdAt: new Date("2026-05-10T14:30:00Z"),
    lineItems: [
      {
        id: 9_000_000_201n,
        title: "Abbey Road — LP",
        quantity: 1,
        price: "24.99",
        sku: "RP-ABBEY-LP",
        properties: {
          Title: "Abbey Road",
          Artist: "The Beatles",
          Format: "LP",
          _has_gpo: "1451902",
          "Terms and Conditions":
            "I have read and agreed to the terms and conditions",
        },
      },
    ],
  },
  {
    id: 9_000_000_106n,
    orderNumber: 9_500_006,
    customerId: 9_000_000_001n,
    totalPrice: "17.99",
    createdAt: new Date("2026-05-11T10:00:00Z"),
    lineItems: [
      {
        id: 9_000_000_202n,
        title: "The Dark Side of the Moon — LP",
        quantity: 1,
        price: "17.99",
        sku: "RP-DARKSIDE-LP",
        properties: {
          Title: "The Dark Side of the Moon",
          Artist: "Pink Floyd",
          Format: "LP",
          _has_gpo: "1451888",
          "Terms and Conditions":
            "I have read and agreed to the terms and conditions",
        },
      },
    ],
  },
  {
    id: 9_000_000_102n,
    orderNumber: 9_500_002,
    customerId: 9_000_000_002n,
    totalPrice: "19.99",
    createdAt: new Date("2026-05-12T09:15:00Z"),
    lineItems: [
      {
        id: 9_000_000_203n,
        title: "Kind of Blue — LP",
        quantity: 1,
        price: "19.99",
        sku: "RP-KOB-LP",
        properties: {
          Title: "Kind of Blue",
          Artist: "Miles Davis",
          Format: "LP",
          _has_gpo: "1452100",
          "Terms and Conditions":
            "I have read and agreed to the terms and conditions",
        },
      },
    ],
  },
  {
    id: 9_000_000_103n,
    orderNumber: 9_500_003,
    customerId: 9_000_000_002n,
    totalPrice: "12.99",
    createdAt: new Date("2026-05-14T16:45:00Z"),
    lineItems: [
      {
        id: 9_000_000_204n,
        title: "Giant Steps — 7 inch",
        quantity: 1,
        price: "12.99",
        sku: "RP-GIANT-7",
        properties: {
          Title: "Giant Steps",
          Artist: "John Coltrane",
          Format: "7 inch",
          _has_gpo: "1452201",
          "Terms and Conditions":
            "I have read and agreed to the terms and conditions",
        },
      },
    ],
  },
  {
    id: 9_000_000_104n,
    orderNumber: 9_500_004,
    customerId: 9_000_000_003n,
    totalPrice: "22.99",
    createdAt: new Date("2026-05-15T11:00:00Z"),
    lineItems: [
      {
        id: 9_000_000_205n,
        title: "Nevermind — LP",
        quantity: 1,
        price: "22.99",
        sku: "RP-NVM-LP",
        properties: {
          Title: "Nevermind",
          Artist: "Nirvana",
          Format: "LP",
          _has_gpo: "1452300",
          "Terms and Conditions":
            "I have read and agreed to the terms and conditions",
        },
      },
    ],
  },
  {
    id: 9_000_000_107n,
    orderNumber: 9_500_007,
    customerId: 9_000_000_003n,
    totalPrice: "14.99",
    createdAt: new Date("2026-05-15T15:00:00Z"),
    lineItems: [
      {
        id: 9_000_000_206n,
        title: "Test Titlet — 7 inch",
        quantity: 1,
        price: "14.99",
        sku: "RP-TEST-7",
        properties: {
          Title: "Test Titlet",
          Artist: "Test Artist",
          Format: "7 inch",
          _has_gpo: "1451902",
          "Terms and Conditions":
            "I have read and agreed to the terms and conditions",
        },
      },
    ],
  },
  {
    id: 9_000_000_108n,
    orderNumber: 9_500_008,
    customerId: 9_000_000_003n,
    totalPrice: "16.99",
    createdAt: new Date("2026-05-16T12:00:00Z"),
    lineItems: [
      {
        id: 9_000_000_207n,
        title: "Rumours — LP",
        quantity: 1,
        price: "16.99",
        sku: "RP-RUM-LP",
        properties: {
          Title: "Rumours",
          Artist: "Fleetwood Mac",
          Format: "LP",
          _has_gpo: "1452400",
          "Terms and Conditions":
            "I have read and agreed to the terms and conditions",
        },
      },
    ],
  },
  {
    id: 9_000_000_105n,
    orderNumber: 9_500_005,
    customerId: 9_000_000_001n,
    totalPrice: "29.99",
    createdAt: new Date("2026-05-16T08:20:00Z"),
    lineItems: [
      {
        id: 9_000_000_208n,
        title: "Blue Train — LP",
        quantity: 1,
        price: "29.99",
        sku: "RP-BLUETRAIN-LP",
        properties: {
          Title: "Blue Train",
          Artist: "John Coltrane",
          Format: "LP",
          _has_gpo: "1452500",
          "Terms and Conditions":
            "I have read and agreed to the terms and conditions",
        },
      },
    ],
  },
];

const SHIPPING_ONLY_ORDER = {
  id: 9_000_000_199n,
  orderNumber: 9_500_099,
  customerId: 9_000_000_003n,
  totalPrice: "9.99",
  deliveryMethod: "shipping" as const,
  lineItems: [
    {
      id: 9_000_000_299n,
      title: "In-store pickup item",
      quantity: 1,
      price: "9.99",
      properties: null,
    },
  ],
};

async function upsertCustomer(
  customer: (typeof CUSTOMERS)[number],
) {
  await prisma.customer.upsert({
    where: { id: customer.id },
    update: {
      email: customer.email,
      phone: customer.phone,
      firstName: customer.firstName,
      lastName: customer.lastName,
    },
    create: { ...customer },
  });
}

async function upsertRecordPlanetOrder(order: SeedOrder) {
  await prisma.order.upsert({
    where: { id: order.id },
    update: {
      orderNumber: order.orderNumber,
      shop: SHOP,
      totalPrice: order.totalPrice,
      currency: "USD",
      deliveryMethod: "recordPlanet",
      createdAt: order.createdAt,
      customerId: order.customerId,
    },
    create: {
      id: order.id,
      orderNumber: order.orderNumber,
      shop: SHOP,
      totalPrice: order.totalPrice,
      currency: "USD",
      deliveryMethod: "recordPlanet",
      createdAt: order.createdAt,
      customerId: order.customerId,
    },
  });

  for (const item of order.lineItems) {
    await prisma.lineItem.upsert({
      where: { id: item.id },
      update: {
        orderId: order.id,
        title: item.title,
        quantity: item.quantity,
        price: item.price,
        sku: item.sku,
        properties: item.properties,
        productType: "Record Planet Shipping",
      },
      create: {
        id: item.id,
        orderId: order.id,
        title: item.title,
        quantity: item.quantity,
        price: item.price,
        sku: item.sku,
        properties: item.properties,
        productType: "Record Planet Shipping",
      },
    });
  }
}

async function upsertShippingOrder(
  order: typeof SHIPPING_ONLY_ORDER,
) {
  await prisma.order.upsert({
    where: { id: order.id },
    update: {
      orderNumber: order.orderNumber,
      shop: SHOP,
      totalPrice: order.totalPrice,
      currency: "USD",
      deliveryMethod: order.deliveryMethod,
      customerId: order.customerId,
    },
    create: {
      id: order.id,
      orderNumber: order.orderNumber,
      shop: SHOP,
      totalPrice: order.totalPrice,
      currency: "USD",
      deliveryMethod: order.deliveryMethod,
      customerId: order.customerId,
    },
  });

  for (const item of order.lineItems) {
    await prisma.lineItem.upsert({
      where: { id: item.id },
      update: {
        orderId: order.id,
        title: item.title,
        quantity: item.quantity,
        price: item.price,
        properties: item.properties,
        productType: "Standard",
      },
      create: {
        id: item.id,
        orderId: order.id,
        title: item.title,
        quantity: item.quantity,
        price: item.price,
        properties: item.properties,
        productType: "Standard",
      },
    });
  }
}

export async function seedTestData() {
  console.log(`Seeding Record Planet test data (shop: ${SHOP})…\n`);

  for (const customer of CUSTOMERS) {
    await upsertCustomer(customer);
    console.log(
      `  Customer: ${customer.firstName} ${customer.lastName} <${customer.email}>`,
    );
  }

  for (const order of ORDERS) {
    await upsertRecordPlanetOrder(order);
    const customer = CUSTOMERS.find((c) => c.id === order.customerId);
    console.log(
      `  Order #${order.orderNumber} → ${customer?.lastName}`,
    );
  }

  await upsertShippingOrder(SHIPPING_ONLY_ORDER);
  console.log(
    `  Order #${SHIPPING_ONLY_ORDER.orderNumber}: shipping only (hidden on Record Planet page)`,
  );

  console.log("\nDone. Revert anytime with: yarn seed:test:revert");
  console.log("Try searching for: Beatles, Coltrane, 7 inch, jane.doe");
}

export async function revertTestData() {
  console.log("Reverting Record Planet test data…\n");

  const lineItems = await prisma.lineItem.deleteMany({
    where: { id: { in: [...TEST_DATA.lineItemIds] } },
  });
  console.log(`  Deleted ${lineItems.count} line item(s)`);

  const orders = await prisma.order.deleteMany({
    where: { id: { in: [...TEST_DATA.orderIds] } },
  });
  console.log(`  Deleted ${orders.count} order(s)`);

  const customers = await prisma.customer.deleteMany({
    where: { id: { in: [...TEST_DATA.customerIds] } },
  });
  console.log(`  Deleted ${customers.count} customer(s)`);

  const remaining = await prisma.order.count({
    where: { orderNumber: { in: [...TEST_DATA.orderNumbers] } },
  });

  if (remaining > 0) {
    console.warn(
      `\nWarning: ${remaining} order(s) with test order numbers still exist (different IDs).`,
    );
  } else {
    console.log("\nDone. All seeded test data removed.");
  }
}

function requireDatabaseUrl() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set. Add it to .env and try again.");
    process.exit(1);
  }
}

async function main() {
  requireDatabaseUrl();

  const command = process.argv[2] ?? "seed";

  switch (command) {
    case "seed":
      await seedTestData();
      break;
    case "revert":
      await revertTestData();
      break;
    case "reset":
      await revertTestData();
      console.log("");
      await seedTestData();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Usage: yarn seed:test [seed|revert|reset]");
      process.exit(1);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
