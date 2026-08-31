import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebhookFailureHandler,
  WebhookFailureStatus,
} from "../generated/prisma/client";

const {
  prismaMock,
  authenticateAdmin,
  authenticateWebhook,
  republishWebhookFailures,
  redriveSkipReason,
  listWebhookFailures,
} = vi.hoisted(() => ({
  prismaMock: {
    session: { deleteMany: vi.fn(), update: vi.fn() },
    webhookFailure: { groupBy: vi.fn(), count: vi.fn() },
    lineItem: { findMany: vi.fn() },
  },
  authenticateAdmin: vi.fn(),
  authenticateWebhook: vi.fn(),
  republishWebhookFailures: vi.fn(),
  redriveSkipReason: vi.fn(),
  listWebhookFailures: vi.fn(),
}));

vi.mock("../app/db.server", () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: {
    admin: authenticateAdmin,
    webhook: authenticateWebhook,
  },
}));

vi.mock("../app/webhook-retry-publish.server", () => ({
  republishWebhookFailures,
  redriveSkipReason,
}));

vi.mock("../webhooks/queue.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../webhooks/queue.server")>();
  return {
    ...actual,
    listWebhookFailures,
  };
});

import { routeArgs } from "./route-args";
import { loader as appIndexLoader } from "../app/routes/app._index";
import {
  action as webhooksAdminAction,
  loader as webhooksAdminLoader,
} from "../app/routes/app.webhooks-admin";
import { loader as pickListLoader } from "../app/routes/print.pick-list";
import { action as uninstallAction } from "../app/routes/webhooks.app.uninstalled";
import { action as scopesUpdateAction } from "../app/routes/webhooks.app.scopes_update";

const shop = "record-loft.myshopify.com";

describe("app index", () => {
  it("redirects into Record Planet and keeps query params", async () => {
    authenticateAdmin.mockResolvedValue({ session: { shop } });
    const response = await appIndexLoader(routeArgs(new Request("https://app.test/app?embedded=1")));
    expect(response.headers.get("Location")).toBe("/app/record-planet?embedded=1");
  });
});

describe("Webhook DLQ admin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateAdmin.mockResolvedValue({ session: { shop } });
    listWebhookFailures.mockResolvedValue([]);
    prismaMock.webhookFailure.groupBy.mockResolvedValue([
      { status: WebhookFailureStatus.failed, _count: { _all: 2 } },
      { status: WebhookFailureStatus.pending, _count: { _all: 1 } },
    ]);
    prismaMock.webhookFailure.count.mockResolvedValue(0);
  });

  it("serializes failed jobs and counts by default", async () => {
    listWebhookFailures.mockResolvedValue([
      {
        id: "job-1",
        handler: WebhookFailureHandler.orders_create,
        topic: "ORDERS_CREATE",
        resourceId: 99n,
        status: WebhookFailureStatus.failed,
        attempts: 5,
        maxAttempts: 5,
        errorCode: "graphql_errors",
        errorMessage: "blip",
        updatedAt: new Date("2026-01-01T00:00:00Z"),
        lastAttemptAt: new Date("2026-01-01T00:00:00Z"),
      },
    ]);

    const data = await webhooksAdminLoader(routeArgs(new Request("https://app.test/app/webhooks-admin")));

    expect(listWebhookFailures).toHaveBeenCalledWith(shop, {
      statuses: ["failed"],
      limit: 100,
    });
    expect(data.counts).toEqual({ failed: 2, retrying: 1, total: 3 });
    expect(data.jobs[0]).toMatchObject({
      id: "job-1",
      resourceId: "99",
      leaseExpired: true,
    });
    expect(data.view).toBe("failed");
  });

  it("filters the DLQ list by status=retrying and status=all", async () => {
    const retrying = await webhooksAdminLoader(
      routeArgs(new Request("https://app.test/app/webhooks-admin?status=retrying")),
    );
    expect(retrying.view).toBe("retrying");
    expect(listWebhookFailures).toHaveBeenCalledWith(shop, {
      statuses: ["pending", "processing"],
      limit: 100,
    });

    listWebhookFailures.mockClear();
    const all = await webhooksAdminLoader(
      routeArgs(new Request("https://app.test/app/webhooks-admin?status=all")),
    );
    expect(all.view).toBe("all");
    expect(listWebhookFailures).toHaveBeenCalledWith(shop, {
      statuses: undefined,
      limit: 100,
    });

    listWebhookFailures.mockClear();
    const fallback = await webhooksAdminLoader(
      routeArgs(new Request("https://app.test/app/webhooks-admin?status=nope")),
    );
    expect(fallback.view).toBe("failed");
    expect(listWebhookFailures).toHaveBeenCalledWith(shop, {
      statuses: ["failed"],
      limit: 100,
    });
  });

  it("redrives one row, all rows, and reports skip reasons", async () => {
    republishWebhookFailures.mockResolvedValueOnce({ queued: 1, ids: ["job-1"] });
    const redrive = new FormData();
    redrive.set("intent", "redrive");
    redrive.set("id", "job-1");
    await expect(
      webhooksAdminAction(routeArgs(new Request("https://app.test/app/webhooks-admin", {
          method: "POST",
          body: redrive,
        }))),
    ).resolves.toMatchObject({ ok: true, message: expect.stringContaining("Redriven") });

    republishWebhookFailures.mockResolvedValueOnce({ queued: 0, ids: [] });
    redriveSkipReason.mockResolvedValueOnce("Dropped messages cannot be redriven.");
    const skipped = new FormData();
    skipped.set("intent", "redrive");
    skipped.set("id", "drop-1");
    await expect(
      webhooksAdminAction(routeArgs(new Request("https://app.test/app/webhooks-admin", {
          method: "POST",
          body: skipped,
        }))),
    ).resolves.toEqual({
      ok: false,
      message: "Dropped messages cannot be redriven.",
    });

    republishWebhookFailures.mockResolvedValueOnce({ queued: 2, ids: ["a", "b"] });
    const all = new FormData();
    all.set("intent", "redrive_all");
    await expect(
      webhooksAdminAction(routeArgs(new Request("https://app.test/app/webhooks-admin", {
          method: "POST",
          body: all,
        }))),
    ).resolves.toEqual({
      ok: true,
      message: "Redriven 2 dead letters to Cloud Run.",
    });

    const unknown = new FormData();
    unknown.set("intent", "nope");
    await expect(
      webhooksAdminAction(routeArgs(new Request("https://app.test/app/webhooks-admin", {
          method: "POST",
          body: unknown,
        }))),
    ).resolves.toEqual({ ok: false, message: "Unknown action." });
  });
});

describe("pick list print", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateAdmin.mockResolvedValue({ session: { shop } });
  });

  it("loads line items for numeric and GID ids scoped to the shop", async () => {
    prismaMock.lineItem.findMany.mockResolvedValue([
      {
        id: 1n,
        storeSection: "B2",
        sku: "KOB",
        title: "Kind of Blue",
        quantity: 1,
        order: { orderNumber: 101 },
      },
      {
        id: 2n,
        storeSection: "A1",
        sku: null,
        title: "Blue Train",
        quantity: 2,
        order: { orderNumber: 102 },
      },
    ]);

    const data = await pickListLoader(routeArgs(new Request(
        "https://app.test/print/pick-list?ids=gid://shopify/Order/9,10,nope",
      )));

    expect(prismaMock.lineItem.findMany).toHaveBeenCalledWith({
      where: {
        orderId: { in: [9n, 10n] },
        order: { shop },
      },
      include: { order: true },
    });
    expect(data.items.map((item) => item.section)).toEqual(["A1", "B2"]);
    expect(data.items[0]).toMatchObject({
      sku: "N/A",
      orderNumber: 102,
    });
  });
});

describe("HTTPS lifecycle webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes sessions on uninstall only when a session is present", async () => {
    authenticateWebhook.mockResolvedValue({
      shop,
      session: { id: "s1" },
      topic: "APP_UNINSTALLED",
    });
    await uninstallAction(routeArgs(new Request("https://app.test/webhooks/app/uninstalled", {
        method: "POST",
      })));
    expect(prismaMock.session.deleteMany).toHaveBeenCalledWith({
      where: { shop },
    });

    authenticateWebhook.mockResolvedValue({
      shop,
      session: undefined,
      topic: "APP_UNINSTALLED",
    });
    prismaMock.session.deleteMany.mockClear();
    await uninstallAction(routeArgs(new Request("https://app.test/webhooks/app/uninstalled", {
        method: "POST",
      })));
    expect(prismaMock.session.deleteMany).not.toHaveBeenCalled();
  });

  it("writes the current scopes onto the session", async () => {
    authenticateWebhook.mockResolvedValue({
      shop,
      session: { id: "s1" },
      topic: "APP_SCOPES_UPDATE",
      payload: { current: ["read_orders", "write_products"] },
    });
    await scopesUpdateAction(routeArgs(new Request("https://app.test/webhooks/app/scopes_update", {
        method: "POST",
      })));
    expect(prismaMock.session.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: { scope: "read_orders,write_products" },
    });
  });
});
