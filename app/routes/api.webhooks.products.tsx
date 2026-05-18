import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

const FLOW_TRIGGER_HANDLE = "product_updated_custom";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, session, admin, payload } =
    await authenticate.webhook(request);

  console.log(
    `[products-webhook] ${topic} shop=${shop} session=${session ? "yes" : "no"} admin=${admin ? "yes" : "no"}`,
  );

  if (topic !== "PRODUCTS_CREATE" && topic !== "PRODUCTS_UPDATE") {
    return new Response("Webhook handled", { status: 200 });
  }

  if (!admin) {
    console.error(
      `[products-webhook] No admin API context for ${shop}. ` +
      "Open the app once on this store (or re-install) so an offline session exists.",
    );
    return new Response("No session for shop", { status: 200 });
  }

  try {
    const graphqlProductId = `gid://shopify/Product/${payload.id}`;
    console.log(
      `[products-webhook] Forwarding ${topic} for ${graphqlProductId} → Flow (${FLOW_TRIGGER_HANDLE})`,
    );

    const response = await admin.graphql(
      `#graphql
        mutation runFlowTrigger($handle: String!, $payload: JSON!) {
          flowTriggerReceive(handle: $handle, payload: $payload) {
            userErrors {
              field
              message
            }
          }
        }
      `,
      {
        variables: {
          handle: FLOW_TRIGGER_HANDLE,
          payload: {
            product_id: graphqlProductId,
          },
        },
      },
    );

    const result = (await response.json()) as {
      errors?: unknown;
      data?: {
        flowTriggerReceive?: {
          userErrors?: { field: string[]; message: string }[];
        };
      };
    };

    if (result.errors) {
      console.error(
        "[products-webhook] GraphQL errors:",
        JSON.stringify(result.errors, null, 2),
      );
    }

    const userErrors = result.data?.flowTriggerReceive?.userErrors ?? [];
    if (userErrors.length > 0) {
      console.error("[products-webhook] Flow userErrors:", userErrors);
    } else if (!result.errors) {
      console.log(`[products-webhook] Flow trigger sent for ${graphqlProductId}`);
    }
  } catch (error) {
    console.error("[products-webhook] Handler error:", error);
  }

  return new Response("Webhook handled", { status: 200 });
};
