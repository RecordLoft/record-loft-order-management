import { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, admin, payload } = await authenticate.webhook(request);

  if (!admin) {
    return new Response("Account reference error", { status: 400 });
  }

  if (topic === "PRODUCTS_UPDATE" || topic === "PRODUCTS_CREATE") {
    try {
      const graphqlProductId = `gid://shopify/Product/${payload.id}`;
      console.log(`📦 Processing ${topic} event for product: ${graphqlProductId}`);

      const response = await admin.graphql(`
        mutation runFlowTrigger($handle: String!, $triggerData: JSON!) {
          flowTriggerReceive(handle: $handle, triggerData: $triggerData) {
            userErrors {
              field
              message
            }
          }
        }
      `, {
        variables: {
          handle: "product_updated_custom",
          triggerData: {
            "product_id": graphqlProductId
          }
        }
      });

      const result = await response.json() as any;

      if (result.errors) {
        console.error("❌ GraphQL Syntax/Schema Errors:", JSON.stringify(result.errors, null, 2));
      }

      const userErrors = result.data?.flowTriggerReceive?.userErrors;
      if (userErrors && userErrors.length > 0) {
        console.error("❌ Flow Engine Rejection Errors:", userErrors);
      } else if (!result.errors) {
        console.log(`🚀 Success! Forwarded ${topic} straight down to Shopify Flow.`);
      }

    } catch (error) {
      console.error("❌ Webhook processing exploded:", error);
    }
  }

  return new Response("Webhook handled", { status: 200 });
};