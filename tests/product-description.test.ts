import { describe, expect, it, vi } from "vitest";
import {
  buildProductDescriptionHtml,
  displayMetafieldValue,
  parseMetafieldValue,
  selectedMetafieldsFromAll,
  stripHiddenRecordBlock,
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

type GraphqlFn = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

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

  it("handles empty, malformed, and plain values", () => {
    expect(parseMetafieldValue("   ")).toBe("");
    expect(parseMetafieldValue('[Jazz, Soul]')).toBe("Jazz, Soul");
    expect(parseMetafieldValue('"unterminated')).toBe("unterminate");
    expect(parseMetafieldValue("33 1/3")).toBe("33 1/3");
  });
});

describe("displayMetafieldValue", () => {
  it("prefers resolved reference labels over raw GIDs", () => {
    expect(
      displayMetafieldValue({
        namespace: "vinyl",
        key: "format",
        value: "gid://shopify/Metaobject/1",
        referenceDisplayNames: ["LP"],
      }),
    ).toBe("LP");
    expect(
      displayMetafieldValue({
        namespace: "vinyl",
        key: "format",
        value: "gid://shopify/Metaobject/1",
        referenceDisplayName: "7\"",
      }),
    ).toBe('7"');
    expect(
      displayMetafieldValue({
        namespace: "vinyl",
        key: "format",
        value: "gid://shopify/Metaobject/1",
      }),
    ).toBe("");
    expect(
      displayMetafieldValue({
        namespace: "vinyl",
        key: "genre",
        value: '["Jazz","gid://shopify/TaxonomyValue/1"]',
      }),
    ).toBe("Jazz");
  });
});

describe("stripHiddenRecordBlock and selected metafields", () => {
  it("strips the hidden Shop-channel block and keeps visible HTML", () => {
    const html = buildProductDescriptionHtml("<p>Visible</p>", artistFields("Miles"));
    expect(stripHiddenRecordBlock(html!)).toBe("<p>Visible</p>");
    expect(stripHiddenRecordBlock("<p>Only visible</p>")).toBe("<p>Only visible</p>");
  });

  it("maps DESCRIPTION_METAFIELDS from the full index", () => {
    expect(
      selectedMetafieldsFromAll([
        { namespace: "vinyl", key: "artist", value: "Miles" },
        { namespace: "vinyl", key: "speed", value: "33" },
        { namespace: "custom", key: "ignored", value: "nope" },
      ]),
    ).toMatchObject({
      artist: "Miles",
      speed: "33",
      format: "",
    });
  });

  it("appends RPM unless the speed already includes it", () => {
    const withSuffix = buildProductDescriptionHtml("<p>A</p>", {
      ...emptyFields(),
      speed: "33",
    });
    expect(withSuffix).toContain("33 RPM");
    const alreadyLabeled = buildProductDescriptionHtml("<p>A</p>", {
      ...emptyFields(),
      speed: "45 RPM",
    });
    expect(alreadyLabeled).toContain("45 RPM");
    expect(alreadyLabeled).not.toContain("45 RPM RPM");
  });

  it("removes a stale hidden block when metafields are empty", () => {
    const current = buildProductDescriptionHtml("<p>Visible</p>", artistFields("Miles"));
    expect(buildProductDescriptionHtml(current!, emptyFields())).toBe(
      "<p>Visible</p>",
    );
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

  it("returns retryable graphql_errors when metafield fetch is throttled", async () => {
    const graphql = vi.fn(async () =>
      jsonResponse({ errors: [{ message: "Throttled" }] }),
    );
    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1"),
    ).resolves.toMatchObject({
      outcome: "error",
      code: "graphql_errors",
      message: JSON.stringify([{ message: "Throttled" }]),
    });
  });
});

describe("syncProductDescription", () => {
  it("writes descriptionHtml and reports updated", async () => {
    const graphql = vi.fn<GraphqlFn>(async (query) => {
      if (query.includes("productUpdate")) {
        return jsonResponse({ data: { productUpdate: { userErrors: [] } } });
      }
      return jsonResponse({
        data: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Kind of Blue",
            descriptionHtml: "<p>Visible</p>",
            metafields: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ namespace: "vinyl", key: "artist", value: "Miles" }],
            },
          },
        },
      });
    });

    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1"),
    ).resolves.toEqual({ outcome: "updated" });
    const updateCall = graphql.mock.calls.find(([query]) =>
      String(query).includes("productUpdate"),
    );
    expect(updateCall?.[1]).toEqual(
      expect.objectContaining({
        variables: {
          input: expect.objectContaining({
            id: "gid://shopify/Product/1",
            descriptionHtml: expect.stringContaining("Miles"),
          }),
        },
      }),
    );
  });

  it("skips the mutation on dryRun but still reports updated", async () => {
    const graphql = vi.fn<GraphqlFn>(async () =>
      jsonResponse({
        data: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Kind of Blue",
            descriptionHtml: "<p>Visible</p>",
            metafields: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ namespace: "vinyl", key: "artist", value: "Miles" }],
            },
          },
        },
      }),
    );
    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1", { dryRun: true }),
    ).resolves.toEqual({ outcome: "updated" });
    expect(
      graphql.mock.calls.some(([query]) => String(query).includes("productUpdate")),
    ).toBe(false);
  });

  it("returns graphql_errors and user_errors from productUpdate", async () => {
    const graphqlErrors = vi.fn(async (query: string) => {
      if (query.includes("productUpdate")) {
        return jsonResponse({ errors: [{ message: "Throttled" }] });
      }
      return jsonResponse({
        data: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Kind of Blue",
            descriptionHtml: "<p>Visible</p>",
            metafields: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ namespace: "vinyl", key: "artist", value: "Miles" }],
            },
          },
        },
      });
    });
    await expect(
      syncProductDescription(graphqlErrors, "gid://shopify/Product/1"),
    ).resolves.toMatchObject({ outcome: "error", code: "graphql_errors" });

    const userErrors = vi.fn(async (query: string) => {
      if (query.includes("productUpdate")) {
        return jsonResponse({
          data: {
            productUpdate: {
              userErrors: [{ field: ["descriptionHtml"], message: "too long" }],
            },
          },
        });
      }
      return jsonResponse({
        data: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Kind of Blue",
            descriptionHtml: "<p>Visible</p>",
            metafields: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ namespace: "vinyl", key: "artist", value: "Miles" }],
            },
          },
        },
      });
    });
    await expect(
      syncProductDescription(userErrors, "gid://shopify/Product/1"),
    ).resolves.toMatchObject({
      outcome: "error",
      code: "user_errors",
      message: "too long",
    });
  });

  it("pages through metafields and resolves leftover metaobject GIDs", async () => {
    const graphql = vi.fn(
      async (
        query: string,
        options?: { variables?: { cursor?: string } },
      ) => {
      if (query.includes("MetaobjectDisplayNames")) {
        return jsonResponse({
          data: {
            nodes: [
              { id: "gid://shopify/Metaobject/9", displayName: "Jazz" },
            ],
          },
        });
      }
      if (query.includes("ProductMetafieldsPage")) {
        const cursor = options?.variables?.cursor;
        if (!cursor) {
          return jsonResponse({
            data: {
              product: {
                id: "gid://shopify/Product/1",
                title: "Kind of Blue",
                descriptionHtml: "<p>Visible</p>",
                metafields: {
                  pageInfo: { hasNextPage: true, endCursor: "c1" },
                  nodes: [
                    {
                      namespace: "shopify",
                      key: "music-genre",
                      value: "gid://shopify/Metaobject/9",
                    },
                  ],
                },
              },
            },
          });
        }
        return jsonResponse({
          data: {
            product: {
              id: "gid://shopify/Product/1",
              title: "Kind of Blue",
              descriptionHtml: "<p>Visible</p>",
              metafields: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{ namespace: "vinyl", key: "artist", value: "Miles" }],
              },
            },
          },
        });
      }
      return jsonResponse({ data: { productUpdate: { userErrors: [] } } });
    },
    );

    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1"),
    ).resolves.toEqual({ outcome: "updated" });
    const updateCall = graphql.mock.calls.find(([query]) =>
      String(query).includes("productUpdate"),
    );
    const html = (updateCall?.[1] as { variables: { input: { descriptionHtml: string } } })
      .variables.input.descriptionHtml;
    expect(html).toContain("Miles");
    expect(html).toContain("Jazz");
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

  it("retries graphql_errors from the product fetch", async () => {
    const graphql = vi.fn(async () =>
      jsonResponse({ errors: [{ message: "Throttled" }] }),
    );
    await expect(
      handleProductDescriptionSync("record-loft.myshopify.com", { id: 1 }, graphql),
    ).resolves.toMatchObject({
      outcome: "error",
      code: "graphql_errors",
      retry: true,
    });
  });

  it("maps updated and skipped outcomes", async () => {
    const current = buildProductDescriptionHtml("<p>Visible</p>", artistFields("Miles"));
    const skipped = vi.fn(async () =>
      jsonResponse({
        data: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Kind of Blue",
            descriptionHtml: current,
            metafields: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ namespace: "vinyl", key: "artist", value: "Miles" }],
            },
          },
        },
      }),
    );
    await expect(
      handleProductDescriptionSync("record-loft.myshopify.com", { id: 1 }, skipped),
    ).resolves.toEqual({ outcome: "skipped", detail: "skipped" });

    const updated = vi.fn(async (query: string) => {
      if (query.includes("productUpdate")) {
        return jsonResponse({ data: { productUpdate: { userErrors: [] } } });
      }
      return jsonResponse({
        data: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Kind of Blue",
            descriptionHtml: "<p>Visible</p>",
            metafields: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ namespace: "vinyl", key: "artist", value: "Miles" }],
            },
          },
        },
      });
    });
    await expect(
      handleProductDescriptionSync("record-loft.myshopify.com", { id: 1 }, updated),
    ).resolves.toEqual({ outcome: "completed", detail: "updated" });
  });

  it("retries user_errors", async () => {
    const graphql = vi.fn(async (query: string) => {
      if (query.includes("productUpdate")) {
        return jsonResponse({
          data: {
            productUpdate: {
              userErrors: [{ field: ["id"], message: "locked" }],
            },
          },
        });
      }
      return jsonResponse({
        data: {
          product: {
            id: "gid://shopify/Product/1",
            title: "Kind of Blue",
            descriptionHtml: "<p>Visible</p>",
            metafields: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ namespace: "vinyl", key: "artist", value: "Miles" }],
            },
          },
        },
      });
    });
    await expect(
      handleProductDescriptionSync("record-loft.myshopify.com", { id: 1 }, graphql),
    ).resolves.toMatchObject({
      outcome: "error",
      code: "user_errors",
      retry: true,
    });
  });
});
