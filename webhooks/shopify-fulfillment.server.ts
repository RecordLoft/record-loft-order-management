import type { GraphqlRequest } from "./product-description.server";

export type FulfillmentOrderForProgress = {
  id: string;
  status: string;
  deliveryMethod?: { methodType?: string | null } | null;
  supportedActions?: { action: string }[];
};

const REPORT_PROGRESS_MUTATION = `#graphql
  mutation FulfillmentOrderReportProgress(
    $id: ID!
    $progressReport: FulfillmentOrderReportProgressInput
  ) {
    fulfillmentOrderReportProgress(id: $id, progressReport: $progressReport) {
      fulfillmentOrder {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const FULFILLMENT_ORDERS_PAGE_SIZE = 50;

const FULFILLMENT_ORDERS_QUERY = `#graphql
  query OrderFulfillmentOrders($orderId: ID!, $first: Int!, $after: String) {
    order(id: $orderId) {
      fulfillmentOrders(first: $first, after: $after) {
        nodes {
          id
          status
          deliveryMethod {
            methodType
          }
          supportedActions {
            action
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

export async function listFulfillmentOrdersForOrder(
  graphql: GraphqlRequest,
  orderGid: string,
): Promise<
  | { ok: true; fulfillmentOrders: FulfillmentOrderForProgress[] }
  | { ok: false; retryable: boolean; code: string; message: string }
> {
  const fulfillmentOrders: FulfillmentOrderForProgress[] = [];
  let after: string | null = null;

  for (;;) {
    const response = await graphql(FULFILLMENT_ORDERS_QUERY, {
      variables: {
        orderId: orderGid,
        first: FULFILLMENT_ORDERS_PAGE_SIZE,
        after,
      },
    });
    const json = (await response.json()) as {
      data?: {
        order?: {
          fulfillmentOrders?: {
            nodes: FulfillmentOrderForProgress[];
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
          };
        };
      };
      errors?: unknown;
    };
    if (json.errors) {
      return {
        ok: false,
        retryable: false,
        code: "graphql_errors",
        message: JSON.stringify(json.errors),
      };
    }
    const connection = json.data?.order?.fulfillmentOrders;
    fulfillmentOrders.push(...(connection?.nodes ?? []));
    if (!connection?.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) {
      break;
    }
    after = connection.pageInfo.endCursor;
  }

  return { ok: true, fulfillmentOrders };
}

function supportsReportProgress(fo: FulfillmentOrderForProgress): boolean {
  return (
    fo.supportedActions?.some((a) => a.action === "REPORT_PROGRESS") ?? false
  );
}

export type MarkInProgressResult =
  | { ok: true; marked: number }
  | { ok: false; retryable: boolean; code: string; message: string };

/**
 * Marks merchant-managed fulfillment orders as in progress via REPORT_PROGRESS.
 */
export async function markFulfillmentOrdersInProgress(
  graphql: GraphqlRequest,
  fulfillmentOrders: FulfillmentOrderForProgress[],
  options?: { reasonNotes?: string; logPrefix?: string },
): Promise<MarkInProgressResult> {
  const log = (msg: string) =>
    console.log(options?.logPrefix ? `[${options.logPrefix}] ${msg}` : msg);

  if (fulfillmentOrders.length === 0) {
    return {
      ok: false,
      retryable: true,
      code: "fulfillment_orders_not_ready",
      message: "No fulfillment orders on order yet",
    };
  }

  const eligible = fulfillmentOrders.filter(supportsReportProgress);
  const alreadyInProgress = fulfillmentOrders.filter(
    (fo) => fo.status === "IN_PROGRESS",
  );

  if (eligible.length === 0) {
    if (alreadyInProgress.length > 0) {
      log(
        `Fulfillment already in progress (${alreadyInProgress.length} order(s))`,
      );
      return { ok: true, marked: 0 };
    }
    log(
      `No fulfillment orders eligible for REPORT_PROGRESS (statuses: ${fulfillmentOrders.map((fo) => fo.status).join(", ")})`,
    );
    return { ok: true, marked: 0 };
  }

  let marked = 0;
  const progressReport = options?.reasonNotes
    ? { reasonNotes: options.reasonNotes }
    : undefined;

  for (const fo of eligible) {
    const response = await graphql(REPORT_PROGRESS_MUTATION, {
      variables: { id: fo.id, progressReport },
    });

    const json = (await response.json()) as {
      data?: {
        fulfillmentOrderReportProgress?: {
          fulfillmentOrder?: { id: string; status: string } | null;
          userErrors: { field?: string[] | null; message: string }[];
        };
      };
      errors?: unknown;
    };

    if (json.errors) {
      return {
        ok: false,
        retryable: false,
        code: "graphql_errors",
        message: JSON.stringify(json.errors),
      };
    }

    const payload = json.data?.fulfillmentOrderReportProgress;
    const userErrors = payload?.userErrors ?? [];
    if (userErrors.length > 0) {
      return {
        ok: false,
        retryable: false,
        code: "fulfillment_report_progress_failed",
        message: userErrors.map((e) => e.message).join("; "),
      };
    }

    marked += 1;
    log(
      `Marked fulfillment order ${fo.id} in progress (status: ${payload?.fulfillmentOrder?.status ?? "unknown"})`,
    );
  }

  return { ok: true, marked };
}
