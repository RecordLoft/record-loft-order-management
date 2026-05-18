import type { ActionFunctionArgs } from "react-router";
import {
  buildProductDescriptionHtml,
  fetchProductWithAllMetafields,
  selectedMetafieldsFromAll,
} from "../product-description.server";
import { authenticate } from "../shopify.server";

const PRODUCT_UPDATE = `#graphql
  mutation UpdateProductDescription($input: ProductInput!) {
    productUpdate(input: $input) {
      product {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

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
        "Open the app once on this store so an offline session exists.",
    );
    return new Response("No session for shop", { status: 200 });
  }

  try {
    const productGid = `gid://shopify/Product/${payload.id}`;

    const productData = await fetchProductWithAllMetafields(
      admin.graphql.bind(admin),
      productGid,
    );

    if (!productData) {
      console.error("[products-webhook] Failed to load product metafields");
      return new Response("Webhook handled", { status: 200 });
    }

    console.log(
      `[products-webhook] Loaded ${productData.metafields.length} metafield(s) for product ${payload.id}`,
    );

    const selectedFields = selectedMetafieldsFromAll(productData.metafields);
    const nextDescription = buildProductDescriptionHtml(
      productData.descriptionHtml ?? "",
      selectedFields,
    );

    if (nextDescription === null) {
      console.log(
        `[products-webhook] Skipping product ${payload.id} — description already up to date`,
      );
      return new Response("Webhook handled", { status: 200 });
    }

    const updateResponse = await admin.graphql(PRODUCT_UPDATE, {
      variables: {
        input: {
          id: productGid,
          descriptionHtml: nextDescription,
        },
      },
    });

    const updateJson = (await updateResponse.json()) as {
      data?: {
        productUpdate?: {
          userErrors: { field: string[]; message: string }[];
        };
      };
      errors?: unknown;
    };

    if (updateJson.errors) {
      console.error(
        "[products-webhook] productUpdate errors:",
        JSON.stringify(updateJson.errors, null, 2),
      );
    }

    const userErrors = updateJson.data?.productUpdate?.userErrors ?? [];
    if (userErrors.length > 0) {
      console.error("[products-webhook] productUpdate userErrors:", userErrors);
    } else if (!updateJson.errors) {
      console.log(
        `[products-webhook] Updated descriptionHtml for product ${payload.id}`,
      );
    }
  } catch (error) {
    console.error("[products-webhook] Handler error:", error);
  }

  return new Response("Webhook handled", { status: 200 });
};
