import { type ActionFunctionArgs } from "@remix-run/node";
import { prisma } from "../db.server";
import { authenticate } from "../shopify.server";

const flattenProperties = (properties: { name: string, value: string }[]) => {
  if (!properties || !Array.isArray(properties)) return {};
  return properties.reduce((acc, prop) => {
    acc[prop.name] = prop.value;
    return acc;
  }, {} as Record<string, string>);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);
  const threadId = crypto.randomUUID();
  if (topic === "ORDERS_CREATE" && admin) {
    try {
      const { id, order_number, total_price, currency, line_items, customer, source_name, shipping_lines } = payload;

      const productIds = [
        ...new Set(
          line_items
            .map((item: any) => item.product_id)
            .filter((id: any) => id !== null && id !== undefined))
      ];

      let productMap = new Map();
      let deliveryMethod: string | null = null;

      if (productIds.length > 0) {
        console.log(`[${threadId}] Fetching product information for IDs:`, productIds);
        const response = await admin.graphql(`
          query getOrderEnrichment($orderId: ID!, $productIds: [ID!]!) {
            order(id: $orderId) {
              fulfillmentOrders(first: 1) {
                nodes {
                  deliveryMethod {
                    methodType
                  }
                }
              }
            }
            nodes(ids: $productIds) {
              ... on Product {
                id
                productType
                category { name }
                storeSection: metafield(namespace: "custom", key: "store_section") { value }
              }
            }
          }
        `, {
          variables: {
            orderId: `gid://shopify/Order/${id}`,
            productIds: productIds.map(pid => `gid://shopify/Product/${pid}`)
          }
        });

        const json = await response.json();

        json.data.nodes.forEach((p: any) => {
          if (!p) return;

          const numericId = p.id.split("/").pop();

          productMap.set(numericId, {
            productType: p.productType,
            storeSection: p.storeSection?.value ?? null,
            category: p.category?.name ?? null,
          });
        });

        deliveryMethod = json.data.order?.fulfillmentOrders?.nodes[0]?.deliveryMethod?.methodType?.toLowerCase() || null;


        const hasRecordPlanetItem = line_items.some((item: any) =>
          productMap.get(item.product_id?.toString())?.productType === "Record Planet Shipping"
        );

        if (hasRecordPlanetItem) {
          deliveryMethod = "recordPlanet";
        }

        console.log(`[${threadId}] Product map:`, productMap);
        console.log(`[${threadId}] Delivery method: ${deliveryMethod}`);
      }


      console.log(`[${threadId}] Attempting to import order ${BigInt(id)}`)


      console.log(`[${threadId}] Source name: ${source_name}`);
      console.log(`[${threadId}] Shipping lines: ${JSON.stringify(shipping_lines)}`);
      console.log(`[${threadId}] Line items: ${JSON.stringify(line_items)}`);
      console.log(`[${threadId}] Payload: ${JSON.stringify(payload)}`);

      await prisma.order.upsert({
        // Convert the raw ID to BigInt
        where: { id: BigInt(id) },
        update: {},
        create: {
          id: BigInt(id),
          orderNumber: order_number,
          shop: shop,
          totalPrice: total_price,
          currency: currency,
          deliveryMethod: deliveryMethod,
          // Handle Customer with BigInt
          customer: customer ? {
            connectOrCreate: {
              where: { id: BigInt(customer.id) },
              create: {
                id: BigInt(customer.id),
                email: customer.email,
                firstName: customer.first_name,
                lastName: customer.last_name,
              }
            }
          } : undefined,
          // Handle Line Items with BigInt
          lineItems: {
            create: line_items.map((item: any) => {
              const enrichment = productMap.get(item.product_id?.toString());

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

      console.log(`[${threadId}] Imported order ${BigInt(id)}`)
    } catch (error) {
      console.error(`[${threadId}] Error syncing order ${payload.id}:`, error);
      return new Response("Error processed", { status: 500 });
    }
  }

  return new Response();
};