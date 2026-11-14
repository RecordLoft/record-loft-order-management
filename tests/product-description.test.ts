import { describe, expect, it, vi } from "vitest";
import {
  buildProductDescriptionHtml,
  desiredHandleBase,
  displayMetafieldValue,
  flattenRedirectsAfterHandleChange,
  handleizeForUrl,
  MAX_HANDLE_LENGTH,
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
            handle: "kind-of-blue",
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

describe("handleizeForUrl and desiredHandleBase", () => {
  it("lowercases, drops apostrophes and collapses symbols", () => {
    expect(handleizeForUrl(`Don't Stop: Greatest Hits 12" (US)`)).toBe(
      "dont-stop-greatest-hits-12-us",
    );
    expect(handleizeForUrl("Beyoncé – Lemonade")).toBe("beyonce-lemonade");
    expect(handleizeForUrl("  ---  ")).toBe("");
  });

  it("caps length without a trailing hyphen", () => {
    const handle = handleizeForUrl(`${"a".repeat(149)} bbbb`);
    expect(handle.length).toBeLessThanOrEqual(MAX_HANDLE_LENGTH);
    expect(handle.endsWith("-")).toBe(false);
  });

  it("prefers custom.ebay_title and falls back to the product title", () => {
    expect(
      desiredHandleBase("Product Title", [
        { namespace: "custom", key: "ebay_title", value: "Miles Davis Kind Of Blue LP" },
      ]),
    ).toBe("miles-davis-kind-of-blue-lp");
    expect(desiredHandleBase("Product Title", [])).toBe("product-title");
    expect(
      desiredHandleBase("Product Title", [
        { namespace: "custom", key: "ebay_title", value: "   " },
      ]),
    ).toBe("product-title");
  });
});

describe("syncProductDescription handle updates", () => {
  type Owners = Record<string, string | null>;

  function productResponse(opts: {
    handle: string;
    title?: string;
    ebayTitle?: string;
    /** Null = not published to the Online Store. Omitted = published. */
    onlineStoreUrl?: string | null;
    /** Drop the hidden record block so the description needs rebuilding. */
    staleDescription?: boolean;
  }) {
    const nodes = [{ namespace: "vinyl", key: "artist", value: "Miles" }];
    if (opts.ebayTitle !== undefined) {
      nodes.push({ namespace: "custom", key: "ebay_title", value: opts.ebayTitle });
    }
    return {
      data: {
        product: {
          id: "gid://shopify/Product/1",
          title: opts.title ?? "Kind of Blue",
          handle: opts.handle,
          ...(opts.onlineStoreUrl !== undefined
            ? { onlineStoreUrl: opts.onlineStoreUrl }
            : {}),
          descriptionHtml: opts.staleDescription
            ? "<p>Visible</p>"
            : buildProductDescriptionHtml("<p>Visible</p>", artistFields("Miles")),
          metafields: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes,
          },
        },
      },
    };
  }

  function mockShop(
    product: ReturnType<typeof productResponse>,
    owners: Owners = {},
  ) {
    return vi.fn<GraphqlFn>(async (query, options) => {
      if (query.includes("productUpdate")) {
        return jsonResponse({ data: { productUpdate: { userErrors: [] } } });
      }
      if (query.includes("ProductIdByHandle")) {
        const handle = String(options?.variables?.handle);
        const id = owners[handle] ?? null;
        return jsonResponse({
          data: { productByIdentifier: id ? { id } : null },
        });
      }
      return jsonResponse(product);
    });
  }

  function updateInput(graphql: ReturnType<typeof mockShop>) {
    const call = graphql.mock.calls.find(([query]) =>
      String(query).includes("productUpdate"),
    );
    return (call?.[1] as { variables: { input: Record<string, unknown> } })
      ?.variables.input;
  }

  it("sets the handle from the eBay title with a redirect", async () => {
    const graphql = mockShop(
      productResponse({
        handle: "kind-of-blue-copy",
        ebayTitle: "Miles Davis Kind Of Blue LP",
      }),
    );
    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1"),
    ).resolves.toEqual({ outcome: "updated" });
    expect(updateInput(graphql)).toEqual({
      id: "gid://shopify/Product/1",
      handle: "miles-davis-kind-of-blue-lp",
      redirectNewHandle: true,
    });
  });

  it("falls back to the product title when the eBay title is blank", async () => {
    const graphql = mockShop(
      productResponse({ handle: "old", ebayTitle: "", title: "Kind of Blue" }),
    );
    await syncProductDescription(graphql, "gid://shopify/Product/1");
    expect(updateInput(graphql)).toMatchObject({ handle: "kind-of-blue" });
  });

  it("skips entirely when the handle and description are current", async () => {
    const graphql = mockShop(
      productResponse({ handle: "miles-davis-kind-of-blue-lp", ebayTitle: "Miles Davis Kind Of Blue LP" }),
    );
    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1"),
    ).resolves.toEqual({ outcome: "skipped" });
    expect(updateInput(graphql)).toBeUndefined();
    expect(
      graphql.mock.calls.some(([query]) => String(query).includes("ProductIdByHandle")),
    ).toBe(false);
  });

  it("moves to the next free suffix when another product holds the handle", async () => {
    const graphql = mockShop(
      productResponse({ handle: "old", ebayTitle: "Miles Davis Kind Of Blue LP" }),
      {
        "miles-davis-kind-of-blue-lp": "gid://shopify/Product/2",
        "miles-davis-kind-of-blue-lp-1": "gid://shopify/Product/3",
      },
    );
    await syncProductDescription(graphql, "gid://shopify/Product/1");
    expect(updateInput(graphql)).toMatchObject({
      handle: "miles-davis-kind-of-blue-lp-2",
    });
  });

  it("keeps a suffixed handle it already owns while the base stays taken", async () => {
    const graphql = mockShop(
      productResponse({
        handle: "miles-davis-kind-of-blue-lp-1",
        ebayTitle: "Miles Davis Kind Of Blue LP",
      }),
      { "miles-davis-kind-of-blue-lp": "gid://shopify/Product/2" },
    );
    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1"),
    ).resolves.toEqual({ outcome: "skipped" });
  });

  it("returns to the base handle once it is free again", async () => {
    const graphql = mockShop(
      productResponse({
        handle: "miles-davis-kind-of-blue-lp-1",
        ebayTitle: "Miles Davis Kind Of Blue LP",
      }),
    );
    await syncProductDescription(graphql, "gid://shopify/Product/1");
    expect(updateInput(graphql)).toMatchObject({
      handle: "miles-davis-kind-of-blue-lp",
    });
  });

  it("still follows the eBay title when the product is not on the Online Store, but without a redirect", async () => {
    const graphql = mockShop(
      productResponse({
        handle: "old",
        ebayTitle: "Miles Davis Kind Of Blue LP",
        onlineStoreUrl: null,
      }),
    );
    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1"),
    ).resolves.toEqual({ outcome: "updated" });
    expect(updateInput(graphql)).toEqual({
      id: "gid://shopify/Product/1",
      handle: "miles-davis-kind-of-blue-lp",
      redirectNewHandle: false,
    });
  });

  it("updates description and handle together for an unpublished product", async () => {
    const graphql = mockShop(
      productResponse({
        handle: "old",
        ebayTitle: "Miles Davis Kind Of Blue LP",
        onlineStoreUrl: null,
        staleDescription: true,
      }),
    );
    await syncProductDescription(graphql, "gid://shopify/Product/1");
    expect(updateInput(graphql)).toMatchObject({
      handle: "miles-davis-kind-of-blue-lp",
      redirectNewHandle: false,
    });
    expect(updateInput(graphql)).toHaveProperty("descriptionHtml");
  });

  it("is a no-op for an unpublished product whose handle is already current", async () => {
    const graphql = mockShop(
      productResponse({
        handle: "miles-davis-kind-of-blue-lp",
        ebayTitle: "Miles Davis Kind Of Blue LP",
        onlineStoreUrl: null,
      }),
    );
    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1"),
    ).resolves.toEqual({ outcome: "skipped" });
  });

  it("adds a redirect when the product is on the Online Store", async () => {
    const graphql = mockShop(
      productResponse({
        handle: "old",
        ebayTitle: "Miles Davis Kind Of Blue LP",
        onlineStoreUrl: "https://example.com/products/old",
      }),
    );
    await syncProductDescription(graphql, "gid://shopify/Product/1");
    expect(updateInput(graphql)).toMatchObject({
      handle: "miles-davis-kind-of-blue-lp",
      redirectNewHandle: true,
    });
  });

  it("gets the redirect once it is published and the title changes again", async () => {
    // Same product, two syncs: unpublished first, then live with a new title.
    const unpublished = mockShop(
      productResponse({
        handle: "kind-of-blue-copy",
        ebayTitle: "Miles Davis Kind Of Blue LP",
        onlineStoreUrl: null,
      }),
    );
    await syncProductDescription(unpublished, "gid://shopify/Product/1");
    expect(updateInput(unpublished)).toMatchObject({ redirectNewHandle: false });

    const published = mockShop(
      productResponse({
        handle: "miles-davis-kind-of-blue-lp",
        ebayTitle: "Miles Davis Kind Of Blue LP 180g",
        onlineStoreUrl: "https://example.com/products/miles-davis-kind-of-blue-lp",
      }),
    );
    await syncProductDescription(published, "gid://shopify/Product/1");
    expect(updateInput(published)).toEqual({
      id: "gid://shopify/Product/1",
      handle: "miles-davis-kind-of-blue-lp-180g",
      redirectNewHandle: true,
    });
  });

  it("does not write on dryRun", async () => {
    const graphql = mockShop(
      productResponse({ handle: "old", ebayTitle: "Miles Davis Kind Of Blue LP" }),
    );
    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1", { dryRun: true }),
    ).resolves.toEqual({ outcome: "updated" });
    expect(updateInput(graphql)).toBeUndefined();
  });

  it("retries when the handle lookup is throttled", async () => {
    const graphql = vi.fn<GraphqlFn>(async (query) => {
      if (query.includes("ProductIdByHandle")) {
        return jsonResponse({ errors: [{ message: "Throttled" }] });
      }
      return jsonResponse(productResponse({ handle: "old" }));
    });
    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1"),
    ).resolves.toMatchObject({ outcome: "error", code: "graphql_errors" });
    expect(updateInput(graphql as ReturnType<typeof mockShop>)).toBeUndefined();
  });
});

describe("flattenRedirectsAfterHandleChange", () => {
  type Redirect = { id: string; path: string; target: string };

  /** In-memory redirect table that answers the lookup, update and delete calls. */
  function mockRedirects(initial: Redirect[], opts?: { pageSize?: number }) {
    const table = initial.map((r) => ({ ...r }));
    const pageSize = opts?.pageSize ?? 100;
    const graphql = vi.fn<GraphqlFn>(async (query, options) => {
      const vars = options?.variables ?? {};
      if (query.includes("UrlRedirectsByQuery")) {
        const match = /^(path|target):"(.*)"$/.exec(String(vars.query));
        if (!match) throw new Error(`unexpected search ${String(vars.query)}`);
        const field = match[1] as "path" | "target";
        // Fuzzy like Shopify's search: prefix matches come back too.
        const hits = table.filter((r) => r[field].startsWith(match[2]));
        const start = vars.after ? Number(vars.after) : 0;
        const slice = hits.slice(start, start + pageSize);
        const next = start + pageSize;
        return jsonResponse({
          data: {
            urlRedirects: {
              nodes: slice,
              pageInfo: {
                hasNextPage: next < hits.length,
                endCursor: next < hits.length ? String(next) : null,
              },
            },
          },
        });
      }
      if (query.includes("UrlRedirectRepoint")) {
        const row = table.find((r) => r.id === vars.id);
        if (row) {
          row.target = (vars.urlRedirect as { target: string }).target;
        }
        return jsonResponse({
          data: { urlRedirectUpdate: { userErrors: [] } },
        });
      }
      if (query.includes("UrlRedirectDelete")) {
        const index = table.findIndex((r) => r.id === vars.id);
        if (index >= 0) table.splice(index, 1);
        return jsonResponse({
          data: { urlRedirectDelete: { userErrors: [] } },
        });
      }
      throw new Error("unexpected query");
    });
    return { graphql, table };
  }

  it("repoints redirects that targeted the old handle at the new one", async () => {
    const { graphql, table } = mockRedirects([
      { id: "r1", path: "/products/a", target: "/products/b" },
      { id: "r2", path: "/products/b", target: "/products/c" },
    ]);
    await expect(
      flattenRedirectsAfterHandleChange(graphql, { oldHandle: "b", newHandle: "d" }),
    ).resolves.toEqual({ ok: true, repointed: 1, removed: 0 });
    expect(table.find((r) => r.id === "r1")?.target).toBe("/products/d");
    // Redirects that never pointed at the old handle are left alone.
    expect(table.find((r) => r.id === "r2")?.target).toBe("/products/c");
  });

  it("ignores redirects that only share a prefix with the old handle", async () => {
    const { graphql, table } = mockRedirects([
      { id: "r1", path: "/products/x", target: "/products/b-1" },
      { id: "r2", path: "/products/y", target: "/products/b" },
    ]);
    await flattenRedirectsAfterHandleChange(graphql, { oldHandle: "b", newHandle: "d" });
    expect(table.find((r) => r.id === "r1")?.target).toBe("/products/b-1");
    expect(table.find((r) => r.id === "r2")?.target).toBe("/products/d");
  });

  it("deletes a redirect from the new handle so it cannot shadow the live page", async () => {
    const { graphql, table } = mockRedirects([
      // Flip back: an earlier rename left new → old behind.
      { id: "r1", path: "/products/d", target: "/products/b" },
      // A stale redirect from the new handle to something unrelated.
      { id: "r2", path: "/products/d", target: "/products/zzz" },
      { id: "r3", path: "/products/keep", target: "/products/zzz" },
    ]);
    await expect(
      flattenRedirectsAfterHandleChange(graphql, { oldHandle: "b", newHandle: "d" }),
    ).resolves.toEqual({ ok: true, repointed: 0, removed: 2 });
    expect(table.map((r) => r.id)).toEqual(["r3"]);
  });

  it("follows pagination", async () => {
    const initial = Array.from({ length: 150 }, (_, i) => ({
      id: `r${i}`,
      path: `/products/old-${i}`,
      target: "/products/b",
    }));
    const { graphql, table } = mockRedirects(initial, { pageSize: 100 });
    await expect(
      flattenRedirectsAfterHandleChange(graphql, { oldHandle: "b", newHandle: "d" }),
    ).resolves.toMatchObject({ ok: true, repointed: 150 });
    expect(table.every((r) => r.target === "/products/d")).toBe(true);
  });

  it("with repoint off, only clears redirects that would shadow the new handle", async () => {
    const { graphql, table } = mockRedirects([
      { id: "r1", path: "/products/a", target: "/products/b" },
      { id: "r2", path: "/products/d", target: "/products/zzz" },
    ]);
    await expect(
      flattenRedirectsAfterHandleChange(
        graphql,
        { oldHandle: "b", newHandle: "d" },
        { repoint: false },
      ),
    ).resolves.toEqual({ ok: true, repointed: 0, removed: 1 });
    expect(table.map((r) => r.id)).toEqual(["r1"]);
    expect(table[0].target).toBe("/products/b");
    expect(
      graphql.mock.calls.some(([, o]) =>
        String(o?.variables?.query).startsWith("target:"),
      ),
    ).toBe(false);
  });

  it("does nothing when the handle did not change", async () => {
    const { graphql } = mockRedirects([]);
    await expect(
      flattenRedirectsAfterHandleChange(graphql, { oldHandle: "b", newHandle: "b" }),
    ).resolves.toEqual({ ok: true, repointed: 0, removed: 0 });
    await expect(
      flattenRedirectsAfterHandleChange(graphql, { oldHandle: "", newHandle: "b" }),
    ).resolves.toEqual({ ok: true, repointed: 0, removed: 0 });
    expect(graphql).not.toHaveBeenCalled();
  });

  it("reports a missing scope instead of throwing", async () => {
    const graphql = vi.fn<GraphqlFn>(async () =>
      jsonResponse({
        errors: [{ message: "Access denied for urlRedirects field." }],
      }),
    );
    await expect(
      flattenRedirectsAfterHandleChange(graphql, { oldHandle: "b", newHandle: "d" }),
    ).resolves.toMatchObject({ ok: false, repointed: 0, removed: 0 });
  });

  it("stops and reports when a repoint is rejected", async () => {
    const graphql = vi.fn<GraphqlFn>(async (query) => {
      if (query.includes("UrlRedirectsByQuery")) {
        return jsonResponse({
          data: {
            urlRedirects: {
              nodes: [{ id: "r1", path: "/products/a", target: "/products/b" }],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      }
      return jsonResponse({
        data: {
          urlRedirectUpdate: { userErrors: [{ message: "Target is invalid" }] },
        },
      });
    });
    await expect(
      flattenRedirectsAfterHandleChange(graphql, { oldHandle: "b", newHandle: "d" }),
    ).resolves.toEqual({
      ok: false,
      message: "Target is invalid",
      repointed: 0,
      removed: 0,
    });
  });
});

describe("syncProductDescription redirect flattening", () => {
  function productJson(handle: string, onlineStoreUrl?: string | null) {
    return {
      data: {
        product: {
          id: "gid://shopify/Product/1",
          title: "Kind of Blue",
          handle,
          ...(onlineStoreUrl !== undefined ? { onlineStoreUrl } : {}),
          descriptionHtml: buildProductDescriptionHtml(
            "<p>Visible</p>",
            artistFields("Miles"),
          ),
          metafields: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              { namespace: "vinyl", key: "artist", value: "Miles" },
              { namespace: "custom", key: "ebay_title", value: "Miles Davis Kind Of Blue LP" },
            ],
          },
        },
      },
    };
  }

  function mockShop(
    redirectsResponse: unknown,
    onlineStoreUrl?: string | null,
  ) {
    return vi.fn<GraphqlFn>(async (query) => {
      if (query.includes("productUpdate")) {
        return jsonResponse({ data: { productUpdate: { userErrors: [] } } });
      }
      if (query.includes("ProductIdByHandle")) {
        return jsonResponse({ data: { productByIdentifier: null } });
      }
      if (query.includes("UrlRedirectsByQuery")) {
        return jsonResponse(redirectsResponse);
      }
      if (query.includes("UrlRedirectRepoint")) {
        return jsonResponse({ data: { urlRedirectUpdate: { userErrors: [] } } });
      }
      return jsonResponse(productJson("old-handle", onlineStoreUrl));
    });
  }

  it("repoints older redirects at the new handle after a rename", async () => {
    const graphql = mockShop({
      data: {
        urlRedirects: {
          nodes: [
            { id: "r1", path: "/products/older", target: "/products/old-handle" },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1"),
    ).resolves.toEqual({ outcome: "updated" });
    const repoint = graphql.mock.calls.find(([q]) =>
      String(q).includes("UrlRedirectRepoint"),
    );
    expect(repoint?.[1]).toEqual({
      variables: {
        id: "r1",
        urlRedirect: { target: "/products/miles-davis-kind-of-blue-lp" },
      },
    });
  });

  it("does not repoint redirects for an unpublished product", async () => {
    const graphql = mockShop(
      {
        data: {
          urlRedirects: {
            nodes: [
              { id: "r1", path: "/products/older", target: "/products/old-handle" },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
      null,
    );
    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1"),
    ).resolves.toEqual({ outcome: "updated" });
    expect(
      graphql.mock.calls.some(([q]) => String(q).includes("UrlRedirectRepoint")),
    ).toBe(false);
  });

  it("logs one compact 'product synced' line with the change and redirect counts", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const graphql = mockShop({
        data: {
          urlRedirects: {
            nodes: [
              { id: "r1", path: "/products/older", target: "/products/old-handle" },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
      await syncProductDescription(graphql, "gid://shopify/Product/1");
      const lines = spy.mock.calls
        .map(([line]) => JSON.parse(String(line)))
        .filter((entry) => entry.component === "product-description");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        severity: "INFO",
        handle: "old-handle->miles-davis-kind-of-blue-lp",
        published: true,
        redirects: "repointed:1,removed:0",
      });
      expect(lines[0].changes).toContain("handle");
      expect(String(lines[0].message)).toContain("product synced");
      expect(JSON.stringify(lines[0]).length).toBeLessThan(1024);
    } finally {
      spy.mockRestore();
    }
  });

  it("still succeeds when the redirect lookup is denied", async () => {
    const graphql = mockShop({
      errors: [{ message: "Access denied for urlRedirects field." }],
    });
    await expect(
      syncProductDescription(graphql, "gid://shopify/Product/1"),
    ).resolves.toEqual({ outcome: "updated" });
  });

  it("does not touch redirects on a dry run or when the handle is unchanged", async () => {
    const dry = mockShop({ data: { urlRedirects: { nodes: [], pageInfo: {} } } });
    await syncProductDescription(dry, "gid://shopify/Product/1", { dryRun: true });
    expect(
      dry.mock.calls.some(([q]) => String(q).includes("UrlRedirectsByQuery")),
    ).toBe(false);

    const same = vi.fn<GraphqlFn>(async (query) => {
      if (query.includes("productUpdate")) {
        return jsonResponse({ data: { productUpdate: { userErrors: [] } } });
      }
      if (query.includes("ProductIdByHandle")) {
        return jsonResponse({ data: { productByIdentifier: null } });
      }
      return jsonResponse(productJson("miles-davis-kind-of-blue-lp"));
    });
    await syncProductDescription(same, "gid://shopify/Product/1");
    expect(
      same.mock.calls.some(([q]) => String(q).includes("UrlRedirectsByQuery")),
    ).toBe(false);
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
            handle: "kind-of-blue",
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
