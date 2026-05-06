import { type ActionFunctionArgs } from "@remix-run/node";
import { prisma } from "../db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload, admin } = await authenticate.webhook(request);

  if (topic === "ORDERS_CREATE" && admin) {
    try {
      const { id, order_number, total_price, currency, line_items, customer } = payload;

      const productIds = [
        ...new Set(
          line_items
            .map((item: any) => item.product_id)
            .filter(Boolean)
        ),
      ];

      let productMap = new Map();

      if (productIds.length > 0) {
        const response = await admin.graphql(`
          query ($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Product {
                id
                productType
                # Updated section below
                category {
                  name
                }
                storeSection: metafield(namespace: "custom", key: "store_section") {
                  value
                }
              }
            }
          }
        `, {
          variables: {
            ids: productIds.map(id => `gid://shopify/Product/${id}`)
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
      }

      console.log("Attempting to import order " + BigInt(id))

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

                properties: item.properties ?? null,

                productType: enrichment?.productType ?? null,
                storeSection: enrichment?.storeSection ?? null,
                category: enrichment?.category ?? null,
              };
            }),
          },
        },
      });

      console.log("Imported order " + BigInt(id))
    } catch (error) {
      console.error(`Error syncing order ${payload.id}:`, error);
      return new Response("Error processed", { status: 500 });
    }
  }

  return new Response();
};