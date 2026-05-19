import {
  ordersMatchCachedStatus,
  parseOrderIdsParam,
  subscribeOrderStatusWatch,
} from "../order-status-pro.server";
import { authenticate } from "../shopify.server";
import type { LoaderFunctionArgs } from "react-router";

const POLL_MS = 1_500;
const TIMEOUT_MS = 60_000;

function sseChunk(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** SSE: emits `synced` when webhook cache matches expected status, or `timeout`. */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  const url = new URL(request.url);
  const orderIds = parseOrderIdsParam(url.searchParams.get("ids"));
  const expectedStatusName = url.searchParams.get("status_name")?.trim() ?? "";

  if (orderIds.length === 0 || !expectedStatusName) {
    return new Response("Missing ids or status_name", { status: 400 });
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let pollTimer: ReturnType<typeof setInterval> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const unsubscribes = orderIds.map((orderId) =>
        subscribeOrderStatusWatch(orderId, () => {
          void check();
        }),
      );

      const close = (event: string, data: Record<string, unknown>) => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        unsubscribes.forEach((unsub) => unsub());
        controller.enqueue(encoder.encode(sseChunk(event, data)));
        controller.close();
      };

      const check = async () => {
        if (closed) return;
        try {
          if (await ordersMatchCachedStatus(orderIds, expectedStatusName)) {
            close("synced", {});
          }
        } catch (error) {
          console.error("[order-status-watch] check failed:", error);
        }
      };

      void check();
      pollTimer = setInterval(() => {
        void check();
      }, POLL_MS);

      timeoutTimer = setTimeout(() => {
        close("timeout", {
          error: "Status did not sync from Order Status Pro in time.",
        });
      }, TIMEOUT_MS);

      request.signal.addEventListener("abort", () => {
        close("timeout", { error: "Cancelled" });
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
};
