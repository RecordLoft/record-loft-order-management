import { Prisma } from "../generated/prisma/client";
import prisma from "./db.server";

export type GloboProperties = {
  Title?: string;
  Artist?: string;
  Format?: string;
  [key: string]: string | undefined;
};

const HIDDEN_PROPERTY_KEYS = new Set(["Terms and Conditions"]);

/** Globo line-item properties safe to show in the admin UI. */
export function isVisiblePropertyKey(key: string): boolean {
  return !key.startsWith("_") && !HIDDEN_PROPERTY_KEYS.has(key);
}

export function parseProperties(raw: unknown): GloboProperties | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([key, value]) =>
      isVisiblePropertyKey(key) &&
      value != null &&
      String(value).trim() !== "",
  );
  return entries.length > 0
    ? Object.fromEntries(entries.map(([k, v]) => [k, String(v)]))
    : null;
}

/** Escape `%` and `_` for safe use inside ILIKE patterns. */
export function toIlikePattern(query: string): string {
  const escaped = query
    .replace(/\\/g, "\\\\")
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  return `%${escaped}%`;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** ILIKE pattern using only digits (for phone substring search). */
function toPhoneDigitPattern(query: string): string | null {
  const digits = digitsOnly(query);
  if (digits.length < 3) return null;
  return `%${digits}%`;
}

const CUSTOMER_MATCH_SQL = (pattern: string, phoneDigitPattern: string | null) => {
  const phoneDigitClause = phoneDigitPattern
    ? Prisma.sql`OR regexp_replace(COALESCE(c.phone, ''), '[^0-9]', '', 'g') ILIKE ${phoneDigitPattern}`
  : Prisma.empty;

  return Prisma.sql`
    COALESCE(c.email, '') ILIKE ${pattern}
    OR COALESCE(c.phone, '') ILIKE ${pattern}
    OR COALESCE(c."firstName", '') ILIKE ${pattern}
    OR COALESCE(c."lastName", '') ILIKE ${pattern}
    OR trim(COALESCE(c."firstName", '') || ' ' || COALESCE(c."lastName", '')) ILIKE ${pattern}
    OR trim(COALESCE(c."lastName", '') || ' ' || COALESCE(c."firstName", '')) ILIKE ${pattern}
    ${phoneDigitClause}
  `;
};

export async function matchingLineItemIds(
  shop: string,
  search: string,
): Promise<bigint[]> {
  const pattern = toIlikePattern(search);
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT li.id
    FROM "LineItem" li
    INNER JOIN "Order" o ON li."orderId" = o.id
    WHERE o.shop = ${shop}
      AND o."deliveryMethod" = 'recordPlanet'
      AND (
        li.title ILIKE ${pattern}
        OR COALESCE(li.properties::text, '') ILIKE ${pattern}
      )
  `;
  return rows.map((row) => row.id);
}

export async function matchingOrderIdsByCustomer(
  shop: string,
  search: string,
): Promise<bigint[]> {
  const pattern = toIlikePattern(search);
  const phoneDigitPattern = toPhoneDigitPattern(search);
  const customerMatch = CUSTOMER_MATCH_SQL(pattern, phoneDigitPattern);

  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT DISTINCT o.id
    FROM "Order" o
    INNER JOIN "Customer" c ON o."customerId" = c.id
    WHERE o.shop = ${shop}
      AND o."deliveryMethod" = 'recordPlanet'
      AND (${customerMatch})
  `;
  return rows.map((row) => row.id);
}

export async function matchingOrderIdsByOrderNumber(
  shop: string,
  search: string,
): Promise<bigint[]> {
  const pattern = toIlikePattern(search);
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT o.id
    FROM "Order" o
    WHERE o.shop = ${shop}
      AND o."deliveryMethod" = 'recordPlanet'
      AND o."orderNumber"::text ILIKE ${pattern}
  `;
  return rows.map((row) => row.id);
}

export async function matchingOrderIdsByLineItem(
  shop: string,
  search: string,
): Promise<bigint[]> {
  const pattern = toIlikePattern(search);
  const rows = await prisma.$queryRaw<{ id: bigint }[]>`
    SELECT DISTINCT o.id
    FROM "Order" o
    INNER JOIN "LineItem" li ON li."orderId" = o.id
    WHERE o.shop = ${shop}
      AND o."deliveryMethod" = 'recordPlanet'
      AND (
        li.title ILIKE ${pattern}
        OR COALESCE(li.properties::text, '') ILIKE ${pattern}
      )
  `;
  return rows.map((row) => row.id);
}

export async function matchingOrderIds(
  shop: string,
  search: string,
): Promise<bigint[]> {
  const [byCustomer, byOrderNumber, byLineItem] = await Promise.all([
    matchingOrderIdsByCustomer(shop, search),
    matchingOrderIdsByOrderNumber(shop, search),
    matchingOrderIdsByLineItem(shop, search),
  ]);

  return [
    ...new Set([...byCustomer, ...byOrderNumber, ...byLineItem].map((id) => id.toString())),
  ].map((id) => BigInt(id));
}

export type RecordPlanetSearchMatch = {
  orderIds: bigint[];
  lineItemIds: bigint[];
  customerMatchedOrderIds: Set<string>;
  orderNumberMatchedOrderIds: Set<string>;
  matchingLineItemIds: Set<string>;
};

export async function getRecordPlanetSearchMatch(
  shop: string,
  search: string,
): Promise<RecordPlanetSearchMatch | null> {
  const q = search.trim();
  if (!q) return null;

  const [
    orderIds,
    lineItemIds,
    customerOrderIds,
    orderNumberOrderIds,
  ] = await Promise.all([
    matchingOrderIds(shop, q),
    matchingLineItemIds(shop, q),
    matchingOrderIdsByCustomer(shop, q),
    matchingOrderIdsByOrderNumber(shop, q),
  ]);

  return {
    orderIds,
    lineItemIds,
    customerMatchedOrderIds: new Set(customerOrderIds.map((id) => id.toString())),
    orderNumberMatchedOrderIds: new Set(
      orderNumberOrderIds.map((id) => id.toString()),
    ),
    matchingLineItemIds: new Set(lineItemIds.map((id) => id.toString())),
  };
}

export async function recordPlanetOrderWhere(
  shop: string,
  search: string,
): Promise<Prisma.OrderWhereInput> {
  const base: Prisma.OrderWhereInput = {
    shop,
    deliveryMethod: "recordPlanet",
  };
  const q = search.trim();
  if (!q) return base;

  const ids = await matchingOrderIds(shop, q);
  if (ids.length === 0) {
    return { ...base, id: { in: [BigInt(-1)] } };
  }
  return { ...base, id: { in: ids } };
}

type OrderWithLineItems = {
  id: bigint;
  lineItems: { id: bigint }[];
};

/** Each order has one product; exclude orders that do not match the active search. */
export function filterRecordPlanetOrdersForSearch<T extends OrderWithLineItems>(
  orders: T[],
  match: RecordPlanetSearchMatch,
): T[] {
  return orders.filter((order) => {
    const orderId = order.id.toString();
    if (
      match.customerMatchedOrderIds.has(orderId) ||
      match.orderNumberMatchedOrderIds.has(orderId)
    ) {
      return order.lineItems.length > 0;
    }

    const product = order.lineItems[0];
    return (
      product != null &&
      match.matchingLineItemIds.has(product.id.toString())
    );
  });
}
