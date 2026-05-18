export type WebhookHandlerResult =
  | { outcome: "completed"; detail: string }
  | { outcome: "skipped"; detail: string }
  | { outcome: "error"; code: string; message: string };
