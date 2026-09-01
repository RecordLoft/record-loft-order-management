/// <reference types="node" />

/** Site URL for scheduled functions that HTTP-call the RR app (keep-warm). */
export function getSiteUrl(): string {
  const raw =
    process.env.URL ||
    process.env.DEPLOY_URL ||
    process.env.SHOPIFY_APP_URL ||
    "";
  const trimmed = raw.trim().replace(/\/$/, "");
  if (!trimmed) {
    throw new Error(
      "No site URL: set URL, DEPLOY_URL, or SHOPIFY_APP_URL for scheduled functions",
    );
  }
  return trimmed;
}

export async function fetchAppPath(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    throw new Error("CRON_SECRET is not configured");
  }

  const url = `${getSiteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${secret}`);

  return fetch(url, { ...init, headers });
}
