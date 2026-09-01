import type { Config } from "@netlify/functions";
import { fetchAppPath } from "../lib/site-url";

/**
 * Hourly Aiven activity canary. GETs `/api/health` (`Session.count`) so a
 * quiet stretch still counts as continuative activity. Aiven Free can power
 * off idle services after a warning email. Catalog/order work on Cloud Run
 * is the main activity. Two invocations per hour (scheduled job + health).
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
        `[aiven-canary] /api/health status=${response.status} latencyMs=${latencyMs} ${formatHealthFields(health)} body=${body.slice(0, 300)}`,
      );
      return new Response(body, { status: response.status });
    }

    console.log(
      `[aiven-canary] ok latencyMs=${latencyMs} ${formatHealthFields(health)}`,
    );
    return new Response(body, { status: 200 });
  } catch (error) {
    console.error("[aiven-canary] failed:", error);
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
  schedule: "0 * * * *",
};
