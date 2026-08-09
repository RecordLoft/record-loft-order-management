import { authorizeCronRequest } from "../cron.server";
import { runWebhookQueueCron } from "../webhook-queue.server";
import type { Route } from "./+types/api.cron.webhook-jobs";

/** Manual backlog drain (1 invocation). Webhooks do not use this on the happy path. */
async function handleCron(request: Request) {
  authorizeCronRequest(request);

  // Logging happens inside runWebhookQueueCron (idle vs work summary).
  const result = await runWebhookQueueCron();
  return Response.json(result);
}

export const loader = async ({ request }: Route.LoaderArgs) => handleCron(request);

export const action = async ({ request }: Route.ActionArgs) => handleCron(request);
