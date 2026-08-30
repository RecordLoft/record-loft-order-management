import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ERROR_REPORTING_TYPE,
  TRACE_FIELD,
  cloudTraceResourceName,
  formatCloudLog,
  gcpProjectId,
  log,
  parseCloudTraceHeader,
  runWithLogContext,
  traceHeaderFromRequest,
} from "../webhooks/log.server";

describe("parseCloudTraceHeader", () => {
  it("reads the trace id from X-Cloud-Trace-Context", () => {
    expect(parseCloudTraceHeader("abc123def/1;o=1")).toEqual({
      traceId: "abc123def",
    });
    expect(parseCloudTraceHeader("abc123def")).toEqual({ traceId: "abc123def" });
    expect(parseCloudTraceHeader("")).toBeNull();
    expect(parseCloudTraceHeader(undefined)).toBeNull();
  });
});

describe("traceHeaderFromRequest", () => {
  it("accepts a string or first array value", () => {
    expect(
      traceHeaderFromRequest({
        headers: { "x-cloud-trace-context": "abc/1;o=1" },
      }),
    ).toBe("abc/1;o=1");
    expect(
      traceHeaderFromRequest({
        headers: { "x-cloud-trace-context": ["abc/1;o=1", "other"] },
      }),
    ).toBe("abc/1;o=1");
    expect(traceHeaderFromRequest({ headers: {} })).toBeNull();
  });
});

describe("formatCloudLog", () => {
  it("maps severity, message, and custom fields", () => {
    expect(
      formatCloudLog("INFO", {
        message: "webhook completed",
        component: "pubsub-worker",
        topic: "products/update",
        shop: "record-loft.myshopify.com",
        resourceId: 7n,
        outcome: "completed",
        latencyMs: 12,
      }),
    ).toEqual({
      severity: "INFO",
      message: "webhook completed",
      component: "pubsub-worker",
      topic: "products/update",
      shop: "record-loft.myshopify.com",
      resourceId: "7",
      outcome: "completed",
      latencyMs: 12,
    });
  });

  it("adds stack_trace and Error Reporting type for ERROR Errors", () => {
    const error = new Error("db down");
    const entry = formatCloudLog("ERROR", {
      message: "ack-drop persist failed",
      error,
    });
    expect(entry.severity).toBe("ERROR");
    expect(entry.message).toBe("ack-drop persist failed");
    expect(entry.stack_trace).toEqual(expect.stringContaining("db down"));
    expect(entry["@type"]).toBe(ERROR_REPORTING_TYPE);
    expect(entry).not.toHaveProperty("error");
  });

  it("stringifies non-Error errors without a stack", () => {
    expect(
      formatCloudLog("ERROR", {
        message: "enqueue failed",
        error: "db down",
      }),
    ).toMatchObject({
      severity: "ERROR",
      message: "enqueue failed",
      error: "db down",
    });
  });

  it("sets logging.googleapis.com/trace from the header", () => {
    expect(
      formatCloudLog(
        "INFO",
        { message: "webhook completed" },
        { traceHeader: "abc123def/1;o=1", projectId: "record-loft" },
      )[TRACE_FIELD],
    ).toBe("projects/record-loft/traces/abc123def");
  });

  it("reads the trace header from request context", () => {
    const entry = runWithLogContext({ traceHeader: "ctx-trace/9;o=1" }, () =>
      formatCloudLog(
        "WARNING",
        { message: "ack-drop", reason: "invalid json" },
        { projectId: "record-loft" },
      ),
    );
    expect(entry[TRACE_FIELD]).toBe("projects/record-loft/traces/ctx-trace");
    expect(entry.reason).toBe("invalid json");
  });
});

describe("gcpProjectId", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to record-loft", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    vi.stubEnv("GCP_PROJECT_ID", "");
    expect(gcpProjectId()).toBe("record-loft");
    expect(cloudTraceResourceName("abc")).toBe(
      "projects/record-loft/traces/abc",
    );
  });

  it("prefers GOOGLE_CLOUD_PROJECT", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "from-google");
    vi.stubEnv("GCP_PROJECT_ID", "from-gcp");
    expect(gcpProjectId()).toBe("from-google");
  });
});

describe("log", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes one JSON line", () => {
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    log.info({
      message: "listening",
      component: "pubsub-worker",
      port: 8080,
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toEqual({
      severity: "INFO",
      message: "listening",
      component: "pubsub-worker",
      port: 8080,
    });
  });
});
