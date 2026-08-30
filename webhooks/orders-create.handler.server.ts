import { prisma } from "../app/db.server";
import { applyOrderImportPending } from "../app/order-import-pending.server";
import { log } from "./log.server";
import type { GraphqlRequest } from "./product-description.server";
import {
  listFulfillmentOrdersForOrder,
  markFulfillmentOrdersInProgress,
  type FulfillmentOrderForProgress,
} from "./shopify-fulfillment.server";
import type { WebhookHandlerResult } from "./types.server";

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
  fulfillment_status?: string | null;
  updated_at?: string | null;
};

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

function fulfilledAtFromPayload(payload: OrderWebhookPayload): Date | undefined {
  if (payload.fulfillment_status?.trim().toLowerCase() !== "fulfilled") {
    return undefined;
  }
  if (payload.updated_at) {
    const parsed = new Date(payload.updated_at);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export async function handleOrdersCreate(
  shop: string,
  payload: OrderWebhookPayload,
  graphql: GraphqlRequest,
): Promise<WebhookHandlerResult> {
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
    log.info({
      component: "orders-create",
      message: "fetching product information",
      shop,
      resourceId: id,
      productIds,
      step: "fetch_products",
    });
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
        retry: true,
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

  log.info({
    component: "orders-create",
    message: "importing order",
    shop,
    resourceId: id,
    sourceName: source_name,
    shippingLineCount: Array.isArray(shipping_lines)
      ? shipping_lines.length
      : shipping_lines == null
        ? 0
        : 1,
    step: "import",
  });

  const customerPhone = resolveCustomerPhone(payload);
  const orderId = BigInt(id);
  const fulfilledAt = fulfilledAtFromPayload(payload);
  const lineItemRows = line_items.map((item) => {
    const enrichment = productMap.get(item.product_id?.toString() ?? "");
    return {
      id: BigInt(item.id),
      orderId,
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
  });

  await prisma.$transaction(async (tx) => {
    if (customer) {
      await tx.customer.upsert({
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

    await tx.order.upsert({
      where: { id: orderId },
      update: {
        shop,
        orderNumber: order_number,
        totalPrice: total_price,
        currency,
        deliveryMethod,
        customerId: customer ? BigInt(customer.id) : undefined,
        ...(fulfilledAt ? { fulfilledAt } : {}),
      },
      create: {
        id: orderId,
        orderNumber: order_number,
        shop,
        totalPrice: total_price,
        currency,
        deliveryMethod,
        customerId: customer ? BigInt(customer.id) : null,
        ...(fulfilledAt ? { fulfilledAt } : {}),
      },
    });

    await tx.lineItem.deleteMany({ where: { orderId } });
    if (lineItemRows.length > 0) {
      await tx.lineItem.createMany({ data: lineItemRows });
    }
  });

  log.info({
    component: "orders-create",
    message: "imported order",
    shop,
    resourceId: id,
    step: "imported",
  });

  await applyOrderImportPending(orderId);

  if (deliveryMethod === "recordPlanet") {
    const progress = await markFulfillmentOrdersInProgress(
      graphql,
      fulfillmentOrders,
      {
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
