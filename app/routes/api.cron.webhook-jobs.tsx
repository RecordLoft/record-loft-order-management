import { authorizeCronRequest } from "../cron.server";
import { runWebhookQueueCron } from "../webhook-queue.server";
import type { Route } from "./+types/api.cron.webhook-jobs";

/** Drain pending webhook jobs (process-webhook-jobs every 6h, or this path manually). */
async function handleCron(request: Request) {
  authorizeCronRequest(request);

  // Logging happens inside runWebhookQueueCron (idle vs work summary).
  const result = await runWebhookQueueCron();
  return Response.json(result);
}

export const loader = async ({ request }: Route.LoaderArgs) => handleCron(request);

export const action = async ({ request }: Route.ActionArgs) => handleCron(request);
