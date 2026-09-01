import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchAppPath } = vi.hoisted(() => ({
  fetchAppPath: vi.fn(),
}));

vi.mock("../netlify/lib/site-url", () => ({
  fetchAppPath,
}));

import aivenCanary, { config } from "../netlify/functions/aiven-canary";

describe("aiven-canary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the health body on success", async () => {
    fetchAppPath.mockResolvedValue(
      new Response(
        JSON.stringify({ cold: false, dbMs: 4, totalMs: 12, sessions: 2 }),
        { status: 200 },
      ),
    );
    const response = await aivenCanary();
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('"sessions":2');
  });

  it("forwards a non-OK health status", async () => {
    fetchAppPath.mockResolvedValue(new Response("down", { status: 503 }));
    const response = await aivenCanary();
    expect(response.status).toBe(503);
  });

  it("runs hourly", () => {
    expect(config.schedule).toBe("0 * * * *");
  });

  it("returns 500 when the health request throws", async () => {
    fetchAppPath.mockRejectedValue(new Error("network"));
    const response = await aivenCanary();
    expect(response.status).toBe(500);
    await expect(response.text()).resolves.toContain("network");
  });
});
