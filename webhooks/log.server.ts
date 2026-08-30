/**
 * Structured JSON lines for Cloud Run → Log Explorer.
 * One object per line on stdout/stderr; the agent maps reserved fields.
 * https://cloud.google.com/run/docs/logging
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const TRACE_FIELD = "logging.googleapis.com/trace";
export const ERROR_REPORTING_TYPE =
  "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent";

export type CloudLogSeverity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export type CloudLogFields = {
  message: string;
  component?: string;
  error?: unknown;
} & Record<string, unknown>;

type LogContext = {
  traceHeader?: string | null;
};

const logContext = new AsyncLocalStorage<LogContext>();

function nonEmptyEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function gcpProjectId(): string {
  return (
    nonEmptyEnv(process.env.GOOGLE_CLOUD_PROJECT) ??
    nonEmptyEnv(process.env.GCP_PROJECT_ID) ??
    "record-loft"
  );
}

export function parseCloudTraceHeader(
  header: string | null | undefined,
): { traceId: string } | null {
  if (!header) return null;
  const [traceAndSpan] = header.trim().split(";");
  const [traceId] = traceAndSpan.split("/");
  if (!traceId) return null;
  return { traceId };
}

export function cloudTraceResourceName(
  traceId: string,
  projectId = gcpProjectId(),
): string {
  return `projects/${projectId}/traces/${traceId}`;
}

export function traceHeaderFromRequest(req: {
  headers: { [key: string]: string | string[] | undefined };
}): string | null {
  const raw = req.headers["x-cloud-trace-context"];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

export function runWithLogContext<T>(ctx: LogContext, fn: () => T): T {
  return logContext.run(ctx, fn);
}

function jsonValue(key: string, value: unknown): unknown {
  if (typeof value === "bigint" || key === "resourceId") return String(value);
  return value;
}

export function formatCloudLog(
  severity: CloudLogSeverity,
  fields: CloudLogFields,
  options?: { traceHeader?: string | null; projectId?: string },
): Record<string, unknown> {
  const { message, component, error, ...rest } = fields;
  const entry: Record<string, unknown> = { severity, message };
  if (component) entry.component = component;

  for (const [key, value] of Object.entries(rest)) {
    if (value === undefined) continue;
    entry[key] = jsonValue(key, value);
  }

  const header = options?.traceHeader ?? logContext.getStore()?.traceHeader;
  const parsed = parseCloudTraceHeader(
    Array.isArray(header) ? header[0] : header,
  );
  if (parsed) {
    entry[TRACE_FIELD] = cloudTraceResourceName(
      parsed.traceId,
      options?.projectId ?? gcpProjectId(),
    );
  }

  if (error instanceof Error) {
    entry.stack_trace = error.stack ?? error.message;
    if (severity === "ERROR") {
      entry["@type"] = ERROR_REPORTING_TYPE;
    }
  } else if (error !== undefined) {
    entry.error = String(error);
  }

  return entry;
}

function write(severity: CloudLogSeverity, fields: CloudLogFields): void {
  const line = JSON.stringify(formatCloudLog(severity, fields));
  if (severity === "ERROR") {
    console.error(line);
    return;
  }
  if (severity === "WARNING") {
    console.warn(line);
    return;
  }
  console.log(line);
}

export const log = {
  debug(fields: CloudLogFields) {
    write("DEBUG", fields);
  },
  info(fields: CloudLogFields) {
    write("INFO", fields);
  },
  warn(fields: CloudLogFields) {
    write("WARNING", fields);
  },
  error(fields: CloudLogFields) {
    write("ERROR", fields);
  },
};
