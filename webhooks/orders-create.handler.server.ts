import { prisma } from "../app/db.server";
import type { GraphqlRequest } from "./product-description.server";
import {
  listFulfillmentOrdersForOrder,
  markFulfillmentOrdersInProgress,
  type FulfillmentOrderForProgress,
} from "./shopify-fulfillment.server";

type OrderWebhookPayload = {
  id: number;
  order_number: number;
  total_price: string;
  currency: string;
  line_items: Array<{
    id: number;
    product_id: number | null;
    title: string;
    quantity: number;
    price: string;
    variant_id: number | null;
    sku: string | null;
    properties?: { name: string; value: string }[];
  }>;
  customer?: {
    id: number;
    email: string | null;
    first_name: string | null;
    last_name: string | null;
    phone?: string | null;
  } | null;
  source_name?: string;
  shipping_lines?: unknown;
  phone?: string | null;
  billing_address?: { phone?: string | null } | null;
  shipping_address?: { phone?: string | null } | null;
};

import type { WebhookHandlerResult } from "./types.server";

function flattenProperties(properties: { name: string; value: string }[]) {
  if (!properties || !Array.isArray(properties)) return {};
  return properties.reduce(
    (acc, prop) => {
      acc[prop.name] = prop.value;
      return acc;
    },
    {} as Record<string, string>,
  );
}

function resolveCustomerPhone(payload: OrderWebhookPayload) {
  const { customer, phone, billing_address, shipping_address } = payload;
  return (
    customer?.phone ??
    phone ??
    billing_address?.phone ??
    shipping_address?.phone ??
    null
  );
}

export async function handleOrdersCreate(
  shop: string,
  payload: OrderWebhookPayload,
  graphql: GraphqlRequest,
): Promise<WebhookHandlerResult> {
  const threadId = crypto.randomUUID();
  const {
    id,
    order_number,
    total_price,
    currency,
    line_items,
    customer,
    source_name,
    shipping_lines,
  } = payload;

  const productIds = [
    ...new Set(
      line_items
        .map((item) => item.product_id)
        .filter((pid): pid is number => pid !== null && pid !== undefined),
    ),
  ];

  let productMap = new Map<
    string,
    {
      productType: string | null;
      storeSection: string | null;
      category: string | null;
    }
  >();
  let deliveryMethod: string | null = null;
  let fulfillmentOrders: FulfillmentOrderForProgress[] = [];

  if (productIds.length > 0) {
    console.log(
      `[${threadId}] Fetching product information for IDs:`,
      productIds,
    );
    const response = await graphql(
      `
        query getOrderEnrichment($productIds: [ID!]!) {
          nodes(ids: $productIds) {
            ... on Product {
              id
              productType
              category {
                name
              }
              storeSection: metafield(
                namespace: "custom"
                key: "store_section"
              ) {
                value
              }
            }
          }
        }
      `,
      {
        variables: {
          productIds: productIds.map((pid) => `gid://shopify/Product/${pid}`),
        },
      },
    );

    const json = (await response.json()) as {
      data?: {
        nodes: Array<{
          id?: string;
          productType?: string | null;
          category?: { name?: string | null } | null;
          storeSection?: { value?: string | null } | null;
        } | null>;
      };
      errors?: unknown;
    };

    if (json.errors) {
      return {
        outcome: "error",
        code: "graphql_errors",
        message: JSON.stringify(json.errors),
        retry: false,
      };
    }

    for (const p of json.data?.nodes ?? []) {
      if (!p?.id) continue;
      const numericId = p.id.split("/").pop()!;
      productMap.set(numericId, {
        productType: p.productType ?? null,
        storeSection: p.storeSection?.value ?? null,
        category: p.category?.name ?? null,
      });
    }

    const listed = await listFulfillmentOrdersForOrder(
      graphql,
      `gid://shopify/Order/${id}`,
    );
    if (!listed.ok) {
      return {
        outcome: "error",
        code: listed.code,
        message: listed.message,
        retry: listed.retryable,
      };
    }
    fulfillmentOrders = listed.fulfillmentOrders;

    deliveryMethod =
      fulfillmentOrders[0]?.deliveryMethod?.methodType?.toLowerCase() ?? null;

    const hasRecordPlanetItem = line_items.some(
      (item) =>
        productMap.get(item.product_id?.toString() ?? "")?.productType ===
        "Record Planet Shipping",
    );

    if (hasRecordPlanetItem) {
      deliveryMethod = "recordPlanet";
    }
  }

  console.log(`[${threadId}] Attempting to import order ${BigInt(id)}`);
  console.log(`[${threadId}] Source name: ${source_name}`);
  console.log(
    `[${threadId}] Shipping lines: ${JSON.stringify(shipping_lines)}`,
  );

  const customerPhone = resolveCustomerPhone(payload);

  await prisma.order.upsert({
    where: { id: BigInt(id) },
    update: {
      deliveryMethod,
    },
    create: {
      id: BigInt(id),
      orderNumber: order_number,
      shop,
      totalPrice: total_price,
      currency,
      deliveryMethod,
      customer: customer
        ? {
            connectOrCreate: {
              where: { id: BigInt(customer.id) },
              create: {
                id: BigInt(customer.id),
                email: customer.email,
                firstName: customer.first_name,
                lastName: customer.last_name,
                phone: customerPhone,
              },
            },
          }
        : undefined,
      lineItems: {
        create: line_items.map((item) => {
          const enrichment = productMap.get(item.product_id?.toString() ?? "");

          return {
            id: BigInt(item.id),
            title: item.title,
            quantity: item.quantity,
            price: item.price,
            variantId: item.variant_id ? BigInt(item.variant_id) : null,
            sku: item.sku,
            properties: flattenProperties(item.properties ?? []),
            productType: enrichment?.productType ?? null,
            storeSection: enrichment?.storeSection ?? null,
            category: enrichment?.category ?? null,
          };
        }),
      },
    },
  });

  if (customer) {
    await prisma.customer.upsert({
      where: { id: BigInt(customer.id) },
      update: {
        email: customer.email,
        firstName: customer.first_name,
        lastName: customer.last_name,
        phone: customerPhone,
      },
      create: {
        id: BigInt(customer.id),
        email: customer.email,
        firstName: customer.first_name,
        lastName: customer.last_name,
        phone: customerPhone,
      },
    });
  }

  console.log(`[${threadId}] Imported order ${BigInt(id)}`);

  if (deliveryMethod === "recordPlanet") {
    const progress = await markFulfillmentOrdersInProgress(
      graphql,
      fulfillmentOrders,
      {
        logPrefix: threadId,
        reasonNotes: "Record Planet Shipping order received",
      },
    );

    if (!progress.ok) {
      return {
        outcome: "error",
        code: progress.code,
        message: progress.message,
        retry: progress.retryable,
      };
    }

    const detail =
      progress.marked > 0
        ? `imported, ${progress.marked} fulfillment(s) in progress`
        : "imported, fulfillment already in progress";

    return { outcome: "completed", detail };
  }

  return { outcome: "completed", detail: "imported" };
}
