/** Shared secret for scheduled / manual cron invocations (Netlify, curl, etc.). */
export function authorizeCronRequest(request: Request): void {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    throw new Response("CRON_SECRET is not configured", { status: 503 });
  }

  const auth = request.headers.get("authorization");
  if (auth === `Bearer ${secret}`) return;

  const headerSecret = request.headers.get("x-cron-secret");
  if (headerSecret === secret) return;

  throw new Response("Unauthorized", { status: 401 });
}
