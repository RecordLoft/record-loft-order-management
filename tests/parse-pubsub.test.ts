import { describe, expect, it } from "vitest";
import { WebhookFailureHandler } from "../generated/prisma/client";
import { parsePubSubPush } from "../webhooks/parse-pubsub";

function envelope(payload: unknown, attributes: Record<string, string>) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
      attributes,
      messageId: "m-1",
    },
  };
}

describe("parsePubSubPush", () => {
  it("maps orders/create to the order handler", () => {
    const result = parsePubSubPush(
      envelope(
        { id: 99, order_number: 1001 },
        {
          "X-Shopify-Topic": "orders/create",
          "X-Shopify-Shop-Domain": "record-loft.myshopify.com",
        },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.handler).toBe(WebhookFailureHandler.orders_create);
    expect(result.parsed.work.resourceId).toBe(99);
  });

  it("rejects a payload without id", () => {
    const result = parsePubSubPush(
      envelope(
        { title: "no id" },
        {
          "X-Shopify-Topic": "products/update",
          "X-Shopify-Shop-Domain": "record-loft.myshopify.com",
        },
      ),
    );
    expect(result).toEqual({ ok: false, reason: "payload missing id" });
  });
});
