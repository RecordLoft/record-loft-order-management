import {
  syncProductDescription,
  type DescriptionSyncResult,
  type GraphqlRequest,
} from "./product-description.server";
import type { WebhookHandlerResult } from "./types.server";

type ProductWebhookPayload = {
  id: number;
};

function mapSyncResult(result: DescriptionSyncResult): WebhookHandlerResult {
  if (result.outcome === "updated") {
    return { outcome: "completed", detail: "updated" };
  }
  if (result.outcome === "skipped") {
    return { outcome: "skipped", detail: "skipped" };
  }
  return {
    outcome: "error",
    code: result.code ?? "sync_error",
    message: result.message,
    retry: result.code !== "product_not_found",
  };
}

export async function handleProductDescriptionSync(
  _shop: string,
  payload: ProductWebhookPayload,
  graphql: GraphqlRequest,
): Promise<WebhookHandlerResult> {
  const productGid = `gid://shopify/Product/${payload.id}`;
  const result = await syncProductDescription(graphql, productGid);
  return mapSyncResult(result);
}
