import { type ActionFunctionArgs } from "@remix-run/node";
import { prisma } from "../db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  if (topic === "ORDERS_CREATE") {
    const { id, order_number, total_price, currency, line_items, customer } = payload;

    await prisma.order.upsert({
      where: { id: id.toString() },
      update: {}, // We generally don't overwrite created orders here
      create: {
        id: id.toString(),
        orderNumber: order_number,
        shop: shop,
        totalPrice: total_price,
        currency: currency,
        // Nested Customer Creation/Link
        customer: customer ? {
          connectOrCreate: {
            where: { id: customer.id.toString() },
            create: {
              id: customer.id.toString(),
              email: customer.email,
              firstName: customer.first_name,
              lastName: customer.last_name,
            }
          }
        } : undefined,
        // Nested Line Items Creation
        lineItems: {
          create: line_items.map((item: any) => ({
            id: item.id.toString(),
            title: item.title,
            quantity: item.quantity,
            price: item.price,
            variantId: item.variant_id?.toString(),
            sku: item.sku,
          })),
        },
      },
    });

    // OPTIONAL: Trigger Netlify Build Hook
    // await fetch('https://api.netlify.com/build_hooks/YOUR_ID', { method: 'POST' });
  }

  return new Response();
};