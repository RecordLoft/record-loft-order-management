import { describe, expect, it } from "vitest";
import { WebhookFailureHandler } from "../generated/prisma/client";
import {
  ackDropContext,
  handlerForTopic,
  isAdminRetry,
  normalizeTopic,
  parsePubSubPush,
  unwrapShopifyPayload,
} from "../webhooks/parse-pubsub";

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

  it("maps product topics and underscore aliases to description sync", () => {
    for (const topic of ["products/create", "products/update", "PRODUCTS_UPDATE"]) {
      const result = parsePubSubPush(
        envelope(
          { id: 7 },
          {
            "X-Shopify-Topic": topic,
            "X-Shopify-Shop-Domain": "record-loft.myshopify.com",
            "X-Shopify-Webhook-Id": "wh-1",
          },
        ),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.parsed.handler).toBe(
        WebhookFailureHandler.product_description_sync,
      );
      expect(result.parsed.work.resourceGid).toBe("gid://shopify/Product/7");
      expect(result.parsed.webhookId).toBe("wh-1");
    }
  });

  it("unwraps a nested Shopify payload and accepts a numeric string id", () => {
    const result = parsePubSubPush(
      envelope(
        { payload: { id: "88", topic: "orders/create" } },
        {
          "x-shopify-topic": "orders/create",
          "x-shopify-shop-domain": "record-loft.myshopify.com",
        },
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.work.resourceId).toBe(88);
    expect(result.parsed.messageId).toBe("m-1");
  });

  it("reads message_id when messageId is absent", () => {
    const result = parsePubSubPush({
      message: {
        data: Buffer.from(JSON.stringify({ id: 1 }), "utf8").toString("base64"),
        attributes: {
          "X-Shopify-Topic": "products/update",
          "X-Shopify-Shop-Domain": "record-loft.myshopify.com",
        },
        message_id: "legacy-id",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.messageId).toBe("legacy-id");
  });

  it("rejects missing data, invalid JSON, missing headers, and unknown topics", () => {
    expect(parsePubSubPush({})).toEqual({
      ok: false,
      reason: "missing message.data",
    });
    expect(
      parsePubSubPush({ message: { data: Buffer.from("not-json").toString("base64") } }),
    ).toEqual({ ok: false, reason: "message.data is not JSON" });
    expect(
      parsePubSubPush(
        envelope({ id: 1 }, { "X-Shopify-Shop-Domain": "record-loft.myshopify.com" }),
      ),
    ).toEqual({ ok: false, reason: "missing X-Shopify-Topic" });
    expect(
      parsePubSubPush(envelope({ id: 1 }, { "X-Shopify-Topic": "products/update" })),
    ).toEqual({ ok: false, reason: "missing X-Shopify-Shop-Domain" });
    expect(
      parsePubSubPush(
        envelope(
          { id: 1 },
          {
            "X-Shopify-Topic": "app/uninstalled",
            "X-Shopify-Shop-Domain": "record-loft.myshopify.com",
          },
        ),
      ),
    ).toEqual({ ok: false, reason: "unsupported topic app/uninstalled" });
    expect(
      parsePubSubPush(
        envelope(
          { id: "abc" },
          {
            "X-Shopify-Topic": "products/update",
            "X-Shopify-Shop-Domain": "record-loft.myshopify.com",
          },
        ),
      ),
    ).toEqual({ ok: false, reason: "payload.id is not a number" });
  });
});

describe("parse-pubsub helpers", () => {
  it("normalizes topics and resolves handlers", () => {
    expect(normalizeTopic(" PRODUCTS_UPDATE ")).toBe("products/update");
    expect(handlerForTopic("orders/create")).toBe(
      WebhookFailureHandler.orders_create,
    );
    expect(handlerForTopic("customers/update")).toBeUndefined();
  });

  it("unwraps nested payloads only when they have an id", () => {
    expect(unwrapShopifyPayload(null)).toBeNull();
    expect(unwrapShopifyPayload({ payload: { id: 3 }, id: 9 })).toEqual({ id: 3 });
    expect(unwrapShopifyPayload({ payload: { title: "x" }, id: 9 })).toEqual({
      payload: { title: "x" },
      id: 9,
    });
  });

  it("detects admin retry from case-insensitive attributes", () => {
    expect(isAdminRetry({ "x-retry-source": "admin" })).toBe(true);
    expect(isAdminRetry({ "X-Retry-Source": "shopify" })).toBe(false);
    expect(isAdminRetry(undefined)).toBe(false);
  });

  it("extracts best-effort ack-drop context", () => {
    expect(ackDropContext({})).toEqual({ shop: undefined, topic: undefined });
    expect(
      ackDropContext(
        envelope(
          { id: "55", title: "Kind of Blue" },
          {
            "X-Shopify-Topic": "products/update",
            "X-Shopify-Shop-Domain": "record-loft.myshopify.com",
          },
        ),
      ),
    ).toMatchObject({
      shop: "record-loft.myshopify.com",
      topic: "products/update",
      resourceId: 55,
    });
    expect(
      ackDropContext({
        message: {
          data: "%%%",
          attributes: { "X-Shopify-Topic": "products/update" },
        },
      }),
    ).toEqual({ shop: undefined, topic: "products/update" });
  });
});
