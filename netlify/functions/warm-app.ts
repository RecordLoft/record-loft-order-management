import type { Config } from "@netlify/functions";
import { fetchAppPath } from "../lib/site-url";

/**
 * Keep-warm: every 5 minutes GET `/api/health` so the React Router function
 * already has `shopify.server` and a live Aiven connection. Two invocations
 * per run (this job + health).
 */
export default async () => {
  const started = Date.now();

  try {
    const response = await fetchAppPath("/api/health", { method: "GET" });
    const body = await response.text();
    const latencyMs = Date.now() - started;

    const health = parseHealthBody(body);

    if (!response.ok) {
      console.error(
        `[warm-app] /api/health status=${response.status} latencyMs=${latencyMs} ${formatHealthFields(health)} body=${body.slice(0, 300)}`,
      );
      return new Response(body, { status: response.status });
    }

    console.log(
      `[warm-app] ok latencyMs=${latencyMs} ${formatHealthFields(health)}`,
    );
    return new Response(body, { status: 200 });
  } catch (error) {
    console.error("[warm-app] failed:", error);
    return new Response(String(error), { status: 500 });
  }
};

type HealthBody = {
  cold?: boolean;
  dbMs?: number;
  totalMs?: number;
  sessions?: number;
};

function parseHealthBody(body: string): HealthBody | null {
  try {
    const parsed = JSON.parse(body) as HealthBody;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function formatHealthFields(health: HealthBody | null): string {
  if (!health) return "cold=? dbMs=? totalMs=? sessions=?";
  return `cold=${health.cold ?? "?"} dbMs=${health.dbMs ?? "?"} totalMs=${health.totalMs ?? "?"} sessions=${health.sessions ?? "?"}`;
}

export const config: Config = {
  schedule: "*/5 * * * *",
};
