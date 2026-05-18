import type { ActionFunctionArgs } from "react-router";
import { syncProductDescription } from "../product-description.server";
import { authenticate } from "../shopify.server";

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
    const result = await syncProductDescription(
      admin.graphql.bind(admin),
      productGid,
    );

    if (result === "updated") {
      console.log(
        `[products-webhook] Updated descriptionHtml for product ${payload.id}`,
      );
    } else if (result === "skipped") {
      console.log(
        `[products-webhook] Skipping product ${payload.id} — description already up to date`,
      );
    } else {
      console.error(
        `[products-webhook] Failed to sync description for product ${payload.id}`,
      );
    }
  } catch (error) {
    console.error("[products-webhook] Handler error:", error);
  }

  return new Response("Webhook handled", { status: 200 });
};
