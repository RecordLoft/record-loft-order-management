import { describe, expect, it, vi } from "vitest";
import {
  listFulfillmentOrdersForOrder,
  markFulfillmentOrdersInProgress,
} from "../webhooks/shopify-fulfillment.server";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

const orderGid = "gid://shopify/Order/9001";

describe("listFulfillmentOrdersForOrder", () => {
  it("pages through fulfillment orders", async () => {
    const graphql = vi.fn(
      async (
        _query: string,
        options?: { variables?: { after?: string | null } },
      ) => {
        if (!options?.variables?.after) {
          return jsonResponse({
            data: {
              order: {
                fulfillmentOrders: {
                  nodes: [
                    { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" },
                  ],
                  pageInfo: { hasNextPage: true, endCursor: "c1" },
                },
              },
            },
          });
        }
        return jsonResponse({
          data: {
            order: {
              fulfillmentOrders: {
                nodes: [
                  {
                    id: "gid://shopify/FulfillmentOrder/2",
                    status: "IN_PROGRESS",
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      },
    );

    await expect(
      listFulfillmentOrdersForOrder(graphql, orderGid),
    ).resolves.toEqual({
      ok: true,
      fulfillmentOrders: [
        { id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" },
        { id: "gid://shopify/FulfillmentOrder/2", status: "IN_PROGRESS" },
      ],
    });
    expect(graphql).toHaveBeenCalledTimes(2);
    expect(graphql.mock.calls[0]?.[1]).toEqual({
      variables: { orderId: orderGid, first: 50, after: null },
    });
  });

  it("returns a non-retryable GraphQL error", async () => {
    const graphql = vi.fn(async () =>
      jsonResponse({ errors: [{ message: "Access denied" }] }),
    );
    await expect(
      listFulfillmentOrdersForOrder(graphql, orderGid),
    ).resolves.toEqual({
      ok: false,
      retryable: false,
      code: "graphql_errors",
      message: JSON.stringify([{ message: "Access denied" }]),
    });
  });
});

describe("markFulfillmentOrdersInProgress", () => {
  it("retries when no fulfillment orders exist yet", async () => {
    await expect(
      markFulfillmentOrdersInProgress(vi.fn(), []),
    ).resolves.toEqual({
      ok: false,
      retryable: true,
      code: "fulfillment_orders_not_ready",
      message: "No fulfillment orders on order yet",
    });
  });

  it("treats already in-progress orders as success with marked 0", async () => {
    await expect(
      markFulfillmentOrdersInProgress(vi.fn(), [
        {
          id: "gid://shopify/FulfillmentOrder/1",
          status: "IN_PROGRESS",
          supportedActions: [],
        },
      ]),
    ).resolves.toEqual({ ok: true, marked: 0 });
  });

  it("no-ops when nothing is eligible and nothing is in progress", async () => {
    await expect(
      markFulfillmentOrdersInProgress(vi.fn(), [
        {
          id: "gid://shopify/FulfillmentOrder/1",
          status: "CLOSED",
          supportedActions: [{ action: "CREATE_FULFILLMENT" }],
        },
      ]),
    ).resolves.toEqual({ ok: true, marked: 0 });
  });

  it("reports progress for eligible fulfillment orders", async () => {
    const graphql = vi.fn(async () =>
      jsonResponse({
        data: {
          fulfillmentOrderReportProgress: {
            fulfillmentOrder: {
              id: "gid://shopify/FulfillmentOrder/1",
              status: "IN_PROGRESS",
            },
            userErrors: [],
          },
        },
      }),
    );

    await expect(
      markFulfillmentOrdersInProgress(
        graphql,
        [
          {
            id: "gid://shopify/FulfillmentOrder/1",
            status: "OPEN",
            supportedActions: [{ action: "REPORT_PROGRESS" }],
          },
        ],
        { reasonNotes: "Record Planet Shipping order received" },
      ),
    ).resolves.toEqual({ ok: true, marked: 1 });
    expect(graphql).toHaveBeenCalledWith(
      expect.stringContaining("fulfillmentOrderReportProgress"),
      {
        variables: {
          id: "gid://shopify/FulfillmentOrder/1",
          progressReport: {
            reasonNotes: "Record Planet Shipping order received",
          },
        },
      },
    );
  });

  it("stops on GraphQL and user errors", async () => {
    const graphqlErrors = vi.fn(async () =>
      jsonResponse({ errors: [{ message: "Throttled" }] }),
    );
    await expect(
      markFulfillmentOrdersInProgress(graphqlErrors, [
        {
          id: "gid://shopify/FulfillmentOrder/1",
          status: "OPEN",
          supportedActions: [{ action: "REPORT_PROGRESS" }],
        },
      ]),
    ).resolves.toMatchObject({
      ok: false,
      retryable: false,
      code: "graphql_errors",
    });

    const userErrors = vi.fn(async () =>
      jsonResponse({
        data: {
          fulfillmentOrderReportProgress: {
            userErrors: [{ message: "not allowed" }],
          },
        },
      }),
    );
    await expect(
      markFulfillmentOrdersInProgress(userErrors, [
        {
          id: "gid://shopify/FulfillmentOrder/1",
          status: "OPEN",
          supportedActions: [{ action: "REPORT_PROGRESS" }],
        },
      ]),
    ).resolves.toEqual({
      ok: false,
      retryable: false,
      code: "fulfillment_report_progress_failed",
      message: "not allowed",
    });
  });
});
