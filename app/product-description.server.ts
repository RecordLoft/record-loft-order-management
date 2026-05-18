const HIDDEN_MARKER = '<div style="display: none !important;">';

/** Metafields to include in the hidden Shop-channel block (order preserved). */
export const DESCRIPTION_METAFIELDS = [
  { namespace: "vinyl", key: "artist", label: "Artist" },
  { namespace: "vinyl", key: "music_genre", label: "Genre" },
  { namespace: "vinyl", key: "format", label: "Format" },
  { namespace: "vinyl", key: "speed", label: "Speed", suffix: " RPM" },
  { namespace: "vinyl", key: "vinyl_grade", label: "Vinyl Grade" },
  {
    namespace: "vinyl",
    key: "jacket_cover_grade",
    label: "Jacket / Cover Grade",
  },
  { namespace: "vinyl", key: "condition", label: "Condition" },
  { namespace: "vinyl", key: "condition_notes", label: "Condition Notes" },
] as const;

export type DescriptionMetafieldKey =
  (typeof DESCRIPTION_METAFIELDS)[number]["key"];

export type VinylMetafields = Record<DescriptionMetafieldKey, string>;

export type ProductMetafield = {
  namespace: string;
  key: string;
  value: string;
};

export function metafieldLookupKey(namespace: string, key: string): string {
  return `${namespace}.${key}`;
}

export function isSetMetafieldValue(
  value: string | undefined | null,
): value is string {
  return Boolean(value?.trim());
}

export function parseMetafieldValue(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        const parts = parsed
          .map((item) => String(item ?? "").trim())
          .filter(isSetMetafieldValue);
        return parts.join(", ");
      }
    } catch {
      // fall through to legacy string cleanup
    }
    return trimmed
      .replace(/[\[\]"]/g, "")
      .split(",")
      .map((part) => part.trim())
      .filter(isSetMetafieldValue)
      .join(", ");
  }

  if (trimmed.startsWith('"')) {
    try {
      return String(JSON.parse(trimmed)).trim();
    } catch {
      return trimmed.slice(1, -1).trim();
    }
  }

  return trimmed;
}

/** Index every metafield on the product; only selected keys are returned for rendering. */
export function indexAllMetafields(
  nodes: ProductMetafield[],
): Map<string, string> {
  const index = new Map<string, string>();

  for (const node of nodes) {
    index.set(
      metafieldLookupKey(node.namespace, node.key),
      parseMetafieldValue(node.value),
    );
  }

  return index;
}

/** Pull values for DESCRIPTION_METAFIELDS from the full metafield index. */
export function selectedMetafieldsFromAll(
  allMetafields: ProductMetafield[],
): VinylMetafields {
  const index = indexAllMetafields(allMetafields);
  const fields = Object.fromEntries(
    DESCRIPTION_METAFIELDS.map((field) => [field.key, ""]),
  ) as VinylMetafields;

  for (const field of DESCRIPTION_METAFIELDS) {
    const value = index.get(metafieldLookupKey(field.namespace, field.key))?.trim();
    if (isSetMetafieldValue(value)) fields[field.key] = value;
  }

  return fields;
}

/** @deprecated Use selectedMetafieldsFromAll */
export function vinylMetafieldsFromNodes(
  nodes: ProductMetafield[],
): VinylMetafields {
  return selectedMetafieldsFromAll(nodes);
}

export function stripHiddenRecordBlock(descriptionHtml: string): string {
  const html = descriptionHtml ?? "";
  const index = html.indexOf(HIDDEN_MARKER);
  if (index === -1) return html.trim();
  return html.slice(0, index).trim();
}

function recordDetailLines(fields: VinylMetafields): string[] {
  const lines: string[] = [];

  for (const field of DESCRIPTION_METAFIELDS) {
    const value = fields[field.key]?.trim();
    if (!isSetMetafieldValue(value)) continue;
    const suffix = "suffix" in field ? field.suffix : "";
    lines.push(`• ${field.label}: ${value}${suffix}`);
  }

  return lines;
}

function buildHiddenRecordBlock(fields: VinylMetafields): string {
  const lines = recordDetailLines(fields);
  if (lines.length === 0) return "";
  return `${HIDDEN_MARKER}### RECORD DETAILS${lines.join("")}</div>`;
}

/** Visible on storefront themes; hidden block stays in HTML for Shop channel. */
export function buildProductDescriptionHtml(
  currentDescriptionHtml: string,
  selectedFields: VinylMetafields,
): string | null {
  const cleaned = stripHiddenRecordBlock(currentDescriptionHtml);

  const hiddenBlock = buildHiddenRecordBlock(selectedFields);
  if (!hiddenBlock) {
    return cleaned === currentDescriptionHtml.trim() ? null : cleaned;
  }

  const next = `${cleaned}${hiddenBlock}`;
  return next === currentDescriptionHtml.trim() ? null : next;
}

export const PRODUCT_METAFIELDS_QUERY = `#graphql
  query ProductMetafieldsPage($id: ID!, $cursor: String) {
    product(id: $id) {
      id
      descriptionHtml
      metafields(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          namespace
          key
          value
        }
      }
    }
  }
`;

type MetafieldsPage = {
  product: {
    id: string;
    descriptionHtml: string;
    metafields: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: ProductMetafield[];
    };
  } | null;
};

export async function fetchProductWithAllMetafields(
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>,
  productGid: string,
): Promise<{ descriptionHtml: string; metafields: ProductMetafield[] } | null> {
  const allMetafields: ProductMetafield[] = [];
  let cursor: string | null = null;
  let descriptionHtml = "";

  do {
    const response = await graphql(PRODUCT_METAFIELDS_QUERY, {
      variables: { id: productGid, cursor },
    });
    const json = (await response.json()) as {
      data?: MetafieldsPage;
      errors?: unknown;
    };

    if (json.errors || !json.data?.product) {
      return null;
    }

    const product = json.data.product;
    descriptionHtml = product.descriptionHtml ?? "";
    allMetafields.push(...product.metafields.nodes);

    cursor = product.metafields.pageInfo.hasNextPage
      ? product.metafields.pageInfo.endCursor
      : null;
  } while (cursor);

  return { descriptionHtml, metafields: allMetafields };
}

export const PRODUCT_UPDATE_MUTATION = `#graphql
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

export type GraphqlRequest = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

export type DescriptionSyncResult = "updated" | "skipped" | "error";

/** Fetch all metafields, rebuild descriptionHtml, update when changed. */
export async function syncProductDescription(
  graphql: GraphqlRequest,
  productGid: string,
  options?: { dryRun?: boolean },
): Promise<DescriptionSyncResult> {
  const productData = await fetchProductWithAllMetafields(graphql, productGid);
  if (!productData) return "error";

  const selectedFields = selectedMetafieldsFromAll(productData.metafields);
  const nextDescription = buildProductDescriptionHtml(
    productData.descriptionHtml ?? "",
    selectedFields,
  );

  if (nextDescription === null) return "skipped";

  if (options?.dryRun) return "updated";

  const updateResponse = await graphql(PRODUCT_UPDATE_MUTATION, {
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

  if (updateJson.errors) return "error";

  const userErrors = updateJson.data?.productUpdate?.userErrors ?? [];
  if (userErrors.length > 0) return "error";

  return "updated";
}

export const PRODUCTS_LIST_QUERY = `#graphql
  query ProductsListPage($cursor: String) {
    products(first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        title
      }
    }
  }
`;

export async function listAllProductGids(
  graphql: GraphqlRequest,
): Promise<{ id: string; title: string }[]> {
  const products: { id: string; title: string }[] = [];
  let cursor: string | null = null;

  do {
    const response = await graphql(PRODUCTS_LIST_QUERY, {
      variables: { cursor },
    });
    const json = (await response.json()) as {
      data?: {
        products: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: { id: string; title: string }[];
        };
      };
      errors?: unknown;
    };

    if (json.errors || !json.data?.products) {
      throw new Error(
        `Failed to list products: ${JSON.stringify(json.errors)}`,
      );
    }

    products.push(...json.data.products.nodes);
    cursor = json.data.products.pageInfo.hasNextPage
      ? json.data.products.pageInfo.endCursor
      : null;
  } while (cursor);

  return products;
}
