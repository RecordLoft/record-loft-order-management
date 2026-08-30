import { describe, expect, it, vi } from "vitest";
import {
  buildProductDescriptionHtml,
  parseMetafieldValue,
  selectedMetafieldsFromAll,
  syncProductDescription,
  type VinylMetafields,
} from "../webhooks/product-description.server";
import { handleProductDescriptionSync } from "../webhooks/product-description.handler.server";

function emptyFields(): VinylMetafields {
  return selectedMetafieldsFromAll([]);
}

function artistFields(artist: string): VinylMetafields {
  return { ...emptyFields(), artist };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

describe("buildProductDescriptionHtml", () => {
  it("skips when the hidden block is already current", () => {
    const first = buildProductDescriptionHtml("<p>Visible</p>", artistFields("Miles"));
    expect(first).not.toBeNull();
    expect(buildProductDescriptionHtml(first!, artistFields("Miles"))).toBeNull();
  });

  it("rebuilds when a metafield changes", () => {
    const current = buildProductDescriptionHtml("<p>Visible</p>", artistFields("Miles"));
    const next = buildProductDescriptionHtml(current!, artistFields("Coltrane"));
    expect(next).toContain("Coltrane");
    expect(next).not.toContain("Miles");
  });

  it("skips when there are no selected metafields and no hidden block", () => {
    expect(buildProductDescriptionHtml("<p>Visible</p>", emptyFields())).toBeNull();
  });
});

describe("parseMetafieldValue", () => {
  it("joins JSON arrays and strips quoted strings", () => {
    expect(parseMetafieldValue('["Jazz","Soul"]')).toBe("Jazz, Soul");
    expect(parseMetafieldValue('"Rock"')).toBe("Rock");
  });
});

describe("syncProductDescription", () => {
  it("skips the productUpdate mutation when HTML is unchanged", async () => {
    const current = buildProductDescriptionHtml("<p>Visible</p>", artistFields("Miles"));
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("productUpdate")) {
        return jsonResponse({ data: { productUpdate: { userErrors: [] } } });
      }
      return jsonResponse({
        data: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Kind of Blue",
            descriptionHtml: current,
            metafields: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { namespace: "vinyl", key: "artist", value: "Miles" },
              ],
            },
          },
        },
      });
    });

    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1"),
    ).resolves.toEqual({ outcome: "skipped" });
    expect(
      graphql.mock.calls.some(([query]) =>
        String(query).includes("productUpdate"),
      ),
    ).toBe(false);
  });

  it("returns product_not_found when Shopify has no product", async () => {
    const graphql = vi.fn(async () => jsonResponse({ data: { product: null } }));
    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1"),
    ).resolves.toMatchObject({
      outcome: "error",
      code: "product_not_found",
    });
  });
});

describe("handleProductDescriptionSync", () => {
  it("does not retry product_not_found", async () => {
    const graphql = vi.fn(async () => jsonResponse({ data: { product: null } }));
    await expect(
      handleProductDescriptionSync("record-loft.myshopify.com", { id: 1 }, graphql),
    ).resolves.toMatchObject({
      outcome: "error",
      code: "product_not_found",
      retry: false,
    });
  });
});
