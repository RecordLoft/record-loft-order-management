import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, authenticateAdmin } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
    order: { findMany: vi.fn() },
  },
  authenticateAdmin: vi.fn(),
}));

vi.mock("../app/db.server", () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
}));

import {
  filterRecordPlanetOrdersForSearch,
  getRecordPlanetSearchMatch,
  isVisiblePropertyKey,
  matchingOrderIds,
  parseProperties,
  recordPlanetOrderWhere,
  toIlikePattern,
} from "../app/record-planet.server";
import { loader } from "../app/routes/app.record-planet";
import { routeArgs } from "./route-args";

const shop = "record-loft.myshopify.com";

describe("Record Planet property helpers", () => {
  it("hides internal and terms properties", () => {
    expect(isVisiblePropertyKey("Artist")).toBe(true);
    expect(isVisiblePropertyKey("_internal")).toBe(false);
    expect(isVisiblePropertyKey("Terms and Conditions")).toBe(false);
  });

  it("parses visible non-empty properties", () => {
    expect(parseProperties(null)).toBeNull();
    expect(parseProperties(["Artist"])).toBeNull();
    expect(
      parseProperties({
        Artist: "Miles",
        _hidden: "x",
        "Terms and Conditions": "yes",
        Title: "  ",
      }),
    ).toEqual({ Artist: "Miles" });
    expect(parseProperties({ _hidden: "x" })).toBeNull();
  });

  it("escapes ILIKE wildcards", () => {
    expect(toIlikePattern("50% off")).toBe("%50\\% off%");
    expect(toIlikePattern("a_b")).toBe("%a\\_b%");
    expect(toIlikePattern("a\\b")).toBe("%a\\\\b%");
  });
});

describe("filterRecordPlanetOrdersForSearch", () => {
  const match = {
    orderIds: [1n, 2n, 3n],
    lineItemIds: [10n],
    customerMatchedOrderIds: new Set(["1"]),
    orderNumberMatchedOrderIds: new Set(["2"]),
    matchingLineItemIds: new Set(["10"]),
  };

  it("keeps customer/order-number matches that still have a product", () => {
    expect(
      filterRecordPlanetOrdersForSearch(
        [
          { id: 1n, lineItems: [{ id: 99n }] },
          { id: 1n, lineItems: [] },
          { id: 2n, lineItems: [{ id: 88n }] },
        ],
        match,
      ),
    ).toEqual([
      { id: 1n, lineItems: [{ id: 99n }] },
      { id: 2n, lineItems: [{ id: 88n }] },
    ]);
  });

  it("keeps line-item matches only when the first product matches", () => {
    expect(
      filterRecordPlanetOrdersForSearch(
        [
          { id: 3n, lineItems: [{ id: 10n }] },
          { id: 4n, lineItems: [{ id: 11n }] },
        ],
        match,
      ),
    ).toEqual([{ id: 3n, lineItems: [{ id: 10n }] }]);
  });
});

describe("recordPlanetOrderWhere and search aggregation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateAdmin.mockResolvedValue({ session: { shop } });
  });

  it("returns the shop + recordPlanet filter when search is empty", async () => {
    await expect(recordPlanetOrderWhere(shop, "  ")).resolves.toEqual({
      shop,
      deliveryMethod: "recordPlanet",
    });
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });

  it("uses a sentinel id when search matches nothing", async () => {
    prismaMock.$queryRaw.mockResolvedValue([]);
    await expect(recordPlanetOrderWhere(shop, "zzz")).resolves.toEqual({
      shop,
      deliveryMethod: "recordPlanet",
      id: { in: [BigInt(-1)] },
    });
  });

  it("dedupes matching order ids across customer, number, and line item", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ id: 1n }, { id: 2n }])
      .mockResolvedValueOnce([{ id: 2n }])
      .mockResolvedValueOnce([{ id: 3n }]);

    await expect(matchingOrderIds(shop, "miles")).resolves.toEqual([
      1n,
      2n,
      3n,
    ]);
  });

  it("returns null search match for an empty query", async () => {
    await expect(getRecordPlanetSearchMatch(shop, "   ")).resolves.toBeNull();
  });
});

describe("Record Planet loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateAdmin.mockResolvedValue({ session: { shop } });
    prismaMock.$queryRaw.mockResolvedValue([]);
  });

  it("groups orders by customer and skips items without a product", async () => {
    prismaMock.order.findMany.mockResolvedValue([
      {
        id: 2n,
        orderNumber: 102,
        createdAt: new Date("2026-01-02T00:00:00Z"),
        customerId: 9n,
        ospStatusName: "Ready",
        customer: {
          id: 9n,
          email: "ada@example.com",
          phone: "555",
          firstName: "Ada",
          lastName: "Lovelace",
        },
        lineItems: [
          {
            id: 20n,
            title: "Kind of Blue",
            properties: { Artist: "Miles", _hidden: "x" },
          },
        ],
      },
      {
        id: 1n,
        orderNumber: 101,
        createdAt: new Date("2026-01-03T00:00:00Z"),
        customerId: 9n,
        ospStatusName: null,
        customer: {
          id: 9n,
          email: "ada@example.com",
          phone: "555",
          firstName: "Ada",
          lastName: "Lovelace",
        },
        lineItems: [{ id: 10n, title: "Blue Train", properties: null }],
      },
      {
        id: 3n,
        orderNumber: 103,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        customerId: null,
        ospStatusName: null,
        customer: null,
        lineItems: [],
      },
    ]);

    const result = await loader(routeArgs(new Request("https://app.test/app/record-planet")));

    expect(result.totalOrders).toBe(2);
    expect(result.customerGroups).toHaveLength(1);
    expect(result.customerGroups[0]?.customer?.firstName).toBe("Ada");
    expect(result.customerGroups[0]?.orders.map((order) => order.orderNumber)).toEqual([
      101,
      102,
    ]);
    expect(result.customerGroups[0]?.orders[1]?.product).toEqual({
      id: "20",
      title: "Kind of Blue",
      properties: { Artist: "Miles" },
    });
    expect(result.customerGroups[0]?.orders[0]?.status).toBe("Unknown");
    expect(result.customerGroups[0]?.orders[1]?.status).toEqual({ name: "Ready" });
  });
});
