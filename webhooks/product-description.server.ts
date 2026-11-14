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

export const PRODUCT_METAFIELDS_QUERY = `#graphql
  query ProductMetafieldsPage($id: ID!, $cursor: String) {
    product(id: $id) {
      id
      title
      handle
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
    handle?: string;
    descriptionHtml: string;
    metafields: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: MetafieldGraphNode[];
    };
  } | null;
};

export type FetchedProduct = {
  title: string;
  handle: string;
  descriptionHtml: string;
  metafields: ProductMetafield[];
};

export type FetchProductResult =
  | { ok: true; product: FetchedProduct }
  | { ok: false; code: "product_not_found" | "graphql_errors"; message: string };

export async function fetchProductWithAllMetafields(
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>,
  productGid: string,
): Promise<FetchProductResult> {
  const allMetafields: ProductMetafield[] = [];
  let cursor: string | null = null;
  let title = "";
  let handle = "";
  let descriptionHtml = "";

  do {
    const response = await graphql(PRODUCT_METAFIELDS_QUERY, {
      variables: { id: productGid, cursor },
    });
    const json = (await response.json()) as {
      data?: MetafieldsPage;
      errors?: unknown;
    };

    if (json.errors) {
      return {
        ok: false,
        code: "graphql_errors",
        message: JSON.stringify(json.errors),
      };
    }
    if (!json.data?.product) {
      return {
        ok: false,
        code: "product_not_found",
        message: `Product ${productGid} not found`,
      };
    }

    const product = json.data.product;
    title = product.title ?? "";
    handle = product.handle ?? "";
    descriptionHtml = product.descriptionHtml ?? "";
    allMetafields.push(...product.metafields.nodes.map(metafieldFromGraphNode));

    cursor = product.metafields.pageInfo.hasNextPage
      ? product.metafields.pageInfo.endCursor
      : null;
  } while (cursor);

  const metafields = await enrichMetafieldsWithMetaobjectNames(
    graphql,
    allMetafields,
  );

  return { ok: true, product: { title, handle, descriptionHtml, metafields } };
}

/** Product URL handles are capped here (matches the former Ablestar rule). */
export const MAX_HANDLE_LENGTH = 150;
/** How many `-N` suffixes to try when the desired handle is taken. */
const MAX_HANDLE_SUFFIX = 20;

/** Lowercase, hyphen-separated, ASCII-only URL handle, capped in length. */
export function handleizeForUrl(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_HANDLE_LENGTH)
    .replace(/-+$/g, "");
}

/**
 * The URL always follows the eBay title (`custom.ebay_title`), falling back to
 * the product title when it is blank. Returns "" when neither yields a handle.
 */
export function desiredHandleBase(
  productTitle: string,
  metafields: ProductMetafield[],
): string {
  const ebayTitle = indexAllMetafields(metafields)
    .get(metafieldLookupKey("custom", "ebay_title"))
    ?.trim();
  const fromEbay = isSetMetafieldValue(ebayTitle)
    ? handleizeForUrl(ebayTitle)
    : "";
  return fromEbay || handleizeForUrl(productTitle);
}

export const PRODUCT_BY_HANDLE_QUERY = `#graphql
  query ProductIdByHandle($handle: String!) {
    productByIdentifier(identifier: { handle: $handle }) {
      id
    }
  }
`;

export type HandleResolution =
  | { ok: true; handle: string | null }
  | { ok: false; message: string };

/**
 * Pick the handle this product should have: `base`, else `base-1`, `base-2`…
 * Another product keeping a handle (including sold, unpublished ones) pushes
 * this one to the next free suffix. Returns `handle: null` when nothing in
 * range is free, so the caller leaves the URL alone.
 */
export async function resolveAvailableHandle(
  graphql: GraphqlRequest,
  productGid: string,
  base: string,
  currentHandle: string,
): Promise<HandleResolution> {
  for (let n = 0; n <= MAX_HANDLE_SUFFIX; n += 1) {
    const candidate = n === 0 ? base : `${base}-${n}`;
    if (candidate === currentHandle) return { ok: true, handle: candidate };

    const response = await graphql(PRODUCT_BY_HANDLE_QUERY, {
      variables: { handle: candidate },
    });
    const json = (await response.json()) as {
      data?: { productByIdentifier?: { id: string } | null };
      errors?: unknown;
    };
    if (json.errors) {
      return { ok: false, message: JSON.stringify(json.errors) };
    }
    const owner = json.data?.productByIdentifier?.id;
    if (!owner || owner === productGid) return { ok: true, handle: candidate };
  }
  return { ok: true, handle: null };
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

/**
 * Fetch all metafields, then rebuild descriptionHtml and the URL handle
 * (from the eBay title, else the product title), writing one productUpdate
 * only when something changed. Handle changes leave a redirect from the old URL.
 */
export async function syncProductDescription(
  graphql: GraphqlRequest,
  productGid: string,
  options?: { dryRun?: boolean },
): Promise<DescriptionSyncResult> {
  const fetched = await fetchProductWithAllMetafields(graphql, productGid);
  if (!fetched.ok) {
    return {
      outcome: "error",
      code: fetched.code,
      message: fetched.message,
    };
  }
  const productData = fetched.product;

  const selectedFields = selectedMetafieldsFromAll(productData.metafields);
  const nextDescription = buildProductDescriptionHtml(
    productData.descriptionHtml ?? "",
    selectedFields,
  );

  let nextHandle: string | null = null;
  const handleBase = desiredHandleBase(
    productData.title,
    productData.metafields,
  );
  if (handleBase) {
    const resolution = await resolveAvailableHandle(
      graphql,
      productGid,
      handleBase,
      productData.handle,
    );
    if (!resolution.ok) {
      return {
        outcome: "error",
        code: "graphql_errors",
        message: resolution.message,
      };
    }
    if (resolution.handle && resolution.handle !== productData.handle) {
      nextHandle = resolution.handle;
    }
  }

  if (nextDescription === null && nextHandle === null) {
    return { outcome: "skipped" };
  }

  if (options?.dryRun) return { outcome: "updated" };

  const input: Record<string, unknown> = { id: productGid };
  if (nextDescription !== null) input.descriptionHtml = nextDescription;
  if (nextHandle !== null) {
    input.handle = nextHandle;
    input.redirectNewHandle = true;
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
