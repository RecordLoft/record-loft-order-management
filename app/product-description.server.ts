const HIDDEN_MARKER = '<div style="display: none !important;">';

/** Metafields to include in the hidden Shop-channel block (order preserved). */
export const DESCRIPTION_METAFIELDS = [
  { namespace: "vinyl", key: "artist", label: "Artist" },
  { namespace: "shopify", key: "music-genre", label: "Genre" },
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
  referenceDisplayName?: string | null;
  referenceDisplayNames?: string[];
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

function isUnresolvedGid(value: string): boolean {
  return value.startsWith("gid://");
}

/** Prefer resolved metaobject/taxonomy labels over raw GID values. */
export function displayMetafieldValue(node: ProductMetafield): string {
  const fromReferences =
    node.referenceDisplayNames?.filter(isSetMetafieldValue);
  if (fromReferences?.length) return fromReferences.join(", ");

  if (isSetMetafieldValue(node.referenceDisplayName)) {
    return node.referenceDisplayName;
  }

  const parsed = parseMetafieldValue(node.value);
  if (!parsed) return "";

  const parts = parsed
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 0 && parts.every(isUnresolvedGid)) return "";

  const labels = parts.filter((part) => !isUnresolvedGid(part));
  return labels.length > 0 ? labels.join(", ") : parsed;
}

function gidsInMetafieldValue(raw: string): string[] {
  const trimmed = raw.trim();
  const gids: string[] = [];

  if (isUnresolvedGid(trimmed)) {
    gids.push(trimmed);
    return gids;
  }

  if (!trimmed.startsWith("[")) return gids;

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return gids;
    for (const item of parsed) {
      const gid = String(item ?? "").trim();
      if (isUnresolvedGid(gid)) gids.push(gid);
    }
  } catch {
    // ignore
  }

  return gids;
}

export const METAOBJECT_DISPLAY_NAMES_QUERY = `#graphql
  query MetaobjectDisplayNames($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Metaobject {
        id
        displayName
      }
    }
  }
`;

async function resolveMetaobjectDisplayNames(
  graphql: GraphqlRequest,
  gids: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (gids.length === 0) return names;

  const response = await graphql(METAOBJECT_DISPLAY_NAMES_QUERY, {
    variables: { ids: gids },
  });
  const json = (await response.json()) as {
    data?: {
      nodes: ({ id?: string; displayName?: string | null } | null)[];
    };
    errors?: unknown;
  };

  for (const node of json.data?.nodes ?? []) {
    if (node?.id && isSetMetafieldValue(node.displayName)) {
      names.set(node.id, node.displayName);
    }
  }

  return names;
}

async function enrichMetafieldsWithMetaobjectNames(
  graphql: GraphqlRequest,
  metafields: ProductMetafield[],
): Promise<ProductMetafield[]> {
  const gids = [
    ...new Set(
      metafields.flatMap((node) => {
        if (displayMetafieldValue(node)) return [];
        return gidsInMetafieldValue(node.value);
      }),
    ),
  ];

  if (gids.length === 0) return metafields;

  const names = await resolveMetaobjectDisplayNames(graphql, gids);

  return metafields.map((node) => {
    if (displayMetafieldValue(node)) return node;

    const nodeGids = gidsInMetafieldValue(node.value);
    const resolved = nodeGids
      .map((gid) => names.get(gid))
      .filter(isSetMetafieldValue);
    if (resolved.length === 0) return node;

    return { ...node, referenceDisplayNames: resolved };
  });
}

function formatFieldValue(
  field: (typeof DESCRIPTION_METAFIELDS)[number],
  value: string,
): string {
  const suffix = "suffix" in field ? field.suffix : "";
  if (!suffix) return value;

  if (/rpm/i.test(value)) return value;
  return `${value}${suffix}`;
}

/** Index every metafield on the product; only selected keys are returned for rendering. */
export function indexAllMetafields(
  nodes: ProductMetafield[],
): Map<string, string> {
  const index = new Map<string, string>();

  for (const node of nodes) {
    index.set(
      metafieldLookupKey(node.namespace, node.key),
      displayMetafieldValue(node),
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
    const value = index
      .get(metafieldLookupKey(field.namespace, field.key))
      ?.trim();
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
    lines.push(`• ${field.label}: ${formatFieldValue(field, value)}`);
  }

  return lines;
}

function buildHiddenRecordBlock(fields: VinylMetafields): string {
  const lines = recordDetailLines(fields);
  if (lines.length === 0) return "";
  return `${HIDDEN_MARKER}<strong>DETAILS:</strong><br />${lines.join("<br />")}</div>`;
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

const EBAY_TITLE_METAFIELD = {
  namespace: "custom",
  key: "ebay_title",
} as const;

/** SEO page title: custom.ebay_title when set, otherwise the product title. */
export function resolveSeoPageTitle(
  productTitle: string,
  metafields: ProductMetafield[],
): string {
  const index = indexAllMetafields(metafields);
  const ebayTitle = index
    .get(
      metafieldLookupKey(
        EBAY_TITLE_METAFIELD.namespace,
        EBAY_TITLE_METAFIELD.key,
      ),
    )
    ?.trim();
  if (isSetMetafieldValue(ebayTitle)) return ebayTitle;
  return productTitle.trim();
}

export const PRODUCT_METAFIELDS_QUERY = `#graphql
  query ProductMetafieldsPage($id: ID!, $cursor: String) {
    product(id: $id) {
      id
      title
      descriptionHtml
      seo {
        title
      }
      metafields(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          namespace
          key
          value
          reference {
            ... on Metaobject {
              displayName
            }
          }
          references(first: 20) {
            nodes {
              ... on Metaobject {
                displayName
              }
            }
          }
        }
      }
    }
  }
`;

type MetafieldGraphNode = {
  namespace: string;
  key: string;
  value: string;
  reference?: { displayName?: string | null } | null;
  references?: { nodes: { displayName?: string | null }[] };
};

function metafieldFromGraphNode(node: MetafieldGraphNode): ProductMetafield {
  return {
    namespace: node.namespace,
    key: node.key,
    value: node.value,
    referenceDisplayName: node.reference?.displayName ?? null,
    referenceDisplayNames: node.references?.nodes
      .map((ref) => ref.displayName)
      .filter(isSetMetafieldValue),
  };
}

type MetafieldsPage = {
  product: {
    id: string;
    title: string;
    descriptionHtml: string;
    seo: { title: string | null } | null;
    metafields: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: MetafieldGraphNode[];
    };
  } | null;
};

export type FetchedProduct = {
  title: string;
  descriptionHtml: string;
  seoTitle: string | null;
  metafields: ProductMetafield[];
};

export async function fetchProductWithAllMetafields(
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>,
  productGid: string,
): Promise<FetchedProduct | null> {
  const allMetafields: ProductMetafield[] = [];
  let cursor: string | null = null;
  let title = "";
  let descriptionHtml = "";
  let seoTitle: string | null = null;

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
    title = product.title ?? "";
    descriptionHtml = product.descriptionHtml ?? "";
    seoTitle = product.seo?.title ?? null;
    allMetafields.push(...product.metafields.nodes.map(metafieldFromGraphNode));

    cursor = product.metafields.pageInfo.hasNextPage
      ? product.metafields.pageInfo.endCursor
      : null;
  } while (cursor);

  const metafields = await enrichMetafieldsWithMetaobjectNames(
    graphql,
    allMetafields,
  );

  return { title, descriptionHtml, seoTitle, metafields };
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

export type DescriptionSyncResult =
  | { outcome: "updated" }
  | { outcome: "skipped" }
  | { outcome: "error"; message: string; code?: string };

/** Fetch all metafields, rebuild descriptionHtml + SEO title, update when changed. */
export async function syncProductDescription(
  graphql: GraphqlRequest,
  productGid: string,
  options?: { dryRun?: boolean },
): Promise<DescriptionSyncResult> {
  const productData = await fetchProductWithAllMetafields(graphql, productGid);
  if (!productData) {
    return {
      outcome: "error",
      code: "product_not_found",
      message: `Product ${productGid} not found or metafields could not be loaded`,
    };
  }

  const selectedFields = selectedMetafieldsFromAll(productData.metafields);
  const nextDescription = buildProductDescriptionHtml(
    productData.descriptionHtml ?? "",
    selectedFields,
  );

  const nextSeoTitle = resolveSeoPageTitle(
    productData.title,
    productData.metafields,
  );

  const seoTitleNeedsUpdate =
    nextSeoTitle !== (productData.seoTitle ?? "").trim();

  const hasChanges = nextDescription !== null || seoTitleNeedsUpdate;
  if (!hasChanges) {
    return { outcome: "skipped" };
  }

  if (options?.dryRun) return { outcome: "updated" };

  const input: Record<string, unknown> = { id: productGid };
  if (nextDescription !== null) {
    input.descriptionHtml = nextDescription;
  }
  if (seoTitleNeedsUpdate) {
    // Only set title; leave description unset so Shopify defaults to product description.
    input.seo = { title: nextSeoTitle };
  }

  const updateResponse = await graphql(PRODUCT_UPDATE_MUTATION, {
    variables: { input },
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
    return {
      outcome: "error",
      code: "graphql_errors",
      message: JSON.stringify(updateJson.errors),
    };
  }

  const userErrors = updateJson.data?.productUpdate?.userErrors ?? [];
  if (userErrors.length > 0) {
    return {
      outcome: "error",
      code: "user_errors",
      message: userErrors.map((e) => e.message).join("; "),
    };
  }

  return { outcome: "updated" };
}
