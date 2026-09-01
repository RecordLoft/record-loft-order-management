import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    session: { count: vi.fn() },
  },
}));

vi.mock("../app/db.server", () => ({
  prisma: prismaMock,
  default: prismaMock,
}));

vi.mock("../app/shopify.server", () => ({
  authenticate: { admin: vi.fn(), webhook: vi.fn() },
}));

import { authorizeCronRequest } from "../app/cron.server";
import {
  consumeColdStartFlag,
  msSince,
} from "../app/request-timing.server";
import { prismaSessionStorageRetryOptions } from "../app/session-storage-retry.server";
import { loader as healthLoader } from "../app/routes/api.health";
import { fetchAppPath, getSiteUrl } from "../netlify/lib/site-url";

describe("authorizeCronRequest", () => {
  const previous = process.env.CRON_SECRET;

  afterEach(() => {
    process.env.CRON_SECRET = previous;
  });

  it("rejects when the secret is missing or wrong", async () => {
    delete process.env.CRON_SECRET;
    await expect(async () => {
      try {
        authorizeCronRequest(new Request("https://app.test/api/health"));
      } catch (error) {
        expect(error).toBeInstanceOf(Response);
        expect((error as Response).status).toBe(503);
        throw error;
      }
    }).rejects.toBeInstanceOf(Response);

    process.env.CRON_SECRET = "cron-secret";
    await expect(async () => {
      try {
        authorizeCronRequest(new Request("https://app.test/api/health"));
      } catch (error) {
        expect((error as Response).status).toBe(401);
        throw error;
      }
    }).rejects.toBeInstanceOf(Response);
  });

  it("accepts Bearer and x-cron-secret", () => {
    process.env.CRON_SECRET = "cron-secret";
    expect(() =>
      authorizeCronRequest(
        new Request("https://app.test/api/health", {
          headers: { authorization: "Bearer cron-secret" },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      authorizeCronRequest(
        new Request("https://app.test/api/health", {
          headers: { "x-cron-secret": "cron-secret" },
        }),
      ),
    ).not.toThrow();
  });
});

describe("request timing", () => {
  it("reports a cold start only once per process", () => {
    globalThis.__recordLoftInstanceWarmed = undefined;
    expect(consumeColdStartFlag()).toBe(true);
    expect(consumeColdStartFlag()).toBe(false);
  });

  it("rounds elapsed milliseconds", () => {
    expect(msSince(performance.now())).toBeGreaterThanOrEqual(0);
  });
});

describe("api.health", () => {
  const previous = process.env.CRON_SECRET;

  beforeEach(() => {
    process.env.CRON_SECRET = "cron-secret";
    prismaMock.session.count.mockResolvedValue(3);
    globalThis.__recordLoftInstanceWarmed = undefined;
  });

  afterEach(() => {
    process.env.CRON_SECRET = previous;
  });

  it("returns timing and session count", async () => {
    const response = await healthLoader({
      request: new Request("https://app.test/api/health", {
        headers: { authorization: "Bearer cron-secret" },
      }),
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      cold: true,
      sessions: 3,
    });
  });
});

describe("Netlify site URL helpers", () => {
  const previous = {
    URL: process.env.URL,
    DEPLOY_URL: process.env.DEPLOY_URL,
    SHOPIFY_APP_URL: process.env.SHOPIFY_APP_URL,
    CRON_SECRET: process.env.CRON_SECRET,
  };

  afterEach(() => {
    process.env.URL = previous.URL;
    process.env.DEPLOY_URL = previous.DEPLOY_URL;
    process.env.SHOPIFY_APP_URL = previous.SHOPIFY_APP_URL;
    process.env.CRON_SECRET = previous.CRON_SECRET;
    vi.unstubAllGlobals();
  });

  it("prefers URL and strips a trailing slash", () => {
    process.env.URL = "https://record-loft-order-management.netlify.app/";
    expect(getSiteUrl()).toBe("https://record-loft-order-management.netlify.app");
  });

  it("throws without a site URL or cron secret", async () => {
    delete process.env.URL;
    delete process.env.DEPLOY_URL;
    delete process.env.SHOPIFY_APP_URL;
    expect(() => getSiteUrl()).toThrow("No site URL");

    process.env.URL = "https://example.netlify.app";
    delete process.env.CRON_SECRET;
    await expect(fetchAppPath("/api/health")).rejects.toThrow(
      "CRON_SECRET is not configured",
    );
  });

  it("calls the app path with a Bearer secret", async () => {
    process.env.URL = "https://example.netlify.app";
    process.env.CRON_SECRET = "cron-secret";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));

    await fetchAppPath("api/health", { method: "GET" });
    expect(fetch).toHaveBeenCalledWith(
      "https://example.netlify.app/api/health",
      expect.objectContaining({
        method: "GET",
        headers: expect.any(Headers),
      }),
    );
    const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer cron-secret");
  });
});

describe("prismaSessionStorageRetryOptions", () => {
  it("uses a short probe on Cloud Run and the long Aiven probe elsewhere", () => {
    expect(prismaSessionStorageRetryOptions({ K_SERVICE: "shopify-webhooks" })).toEqual(
      { connectionRetries: 2, connectionRetryIntervalMs: 200 },
    );
    expect(prismaSessionStorageRetryOptions({})).toEqual({
      connectionRetries: 4,
      connectionRetryIntervalMs: 3000,
    });
  });
});
