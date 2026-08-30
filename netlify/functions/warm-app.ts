import type { Config } from "@netlify/functions";
import { fetchAppPath } from "../lib/site-url";

/**
 * Keeps the React Router System function warm for the embedded admin.
 * Shopify product/order webhooks go to Pub/Sub → Cloud Run, not here.
 * Complements hourly db-ping (DB canary), which does not warm System.
 */
export default async () => {
  const started = Date.now();

  try {
    const response = await fetchAppPath("/api/health", { method: "GET" });
    const body = await response.text();
    const latencyMs = Date.now() - started;

    if (!response.ok) {
      console.error(
        `[warm-app] /api/health status=${response.status} latencyMs=${latencyMs} body=${body.slice(0, 300)}`,
      );
      return new Response(body, { status: response.status });
    }

    console.log(`[warm-app] ok latencyMs=${latencyMs} body=${body}`);
    return new Response(body, { status: 200 });
  } catch (error) {
    console.error("[warm-app] failed:", error);
    return new Response(String(error), { status: 500 });
  }
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
