import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  Checkbox,
  IndexTable,
  Layout,
  Link,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  useFetcher,
  useLoaderData,
  useRevalidator,
  useSearchParams,
} from "react-router";
import type {
  WebhookFailureHandler,
  WebhookFailureStatus,
} from "../../generated/prisma/client";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  redriveSkipReason,
  republishWebhookFailures,
} from "../webhook-retry-publish.server";
import {
  isProcessingLeaseExpired,
  listWebhookFailures,
  processingLeaseCutoff,
} from "../../webhooks/queue.server";

const VIEW_FILTERS = ["failed", "retrying", "all"] as const;
type ViewFilter = (typeof VIEW_FILTERS)[number];

const RETRYING_STATUSES: WebhookFailureStatus[] = [
  "pending",
  "processing",
];

const HANDLER_LABELS = {
  orders_create: "Orders create",
  product_description_sync: "Product description",
  ack_drop: "Dropped (invalid)",
} as const satisfies Record<WebhookFailureHandler, string>;

const REFRESH_MS = 10_000;

type SerializedJob = {
  id: string;
  handler: WebhookFailureHandler;
  topic: string;
  resourceId: string;
  status: WebhookFailureStatus;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
  leaseExpired: boolean;
};

function resourceAdminUrl(
  shop: string,
  handler: WebhookFailureHandler,
  resourceId: string,
): string | null {
  if (handler === "orders_create") {
    return `https://${shop}/admin/orders/${resourceId}`;
  }
  if (handler === "product_description_sync") {
    return `https://${shop}/admin/products/${resourceId}`;
  }
  return null;
}

function parseView(raw: string | null): ViewFilter {
  if (raw && VIEW_FILTERS.includes(raw as ViewFilter)) {
    return raw as ViewFilter;
  }
  return "failed";
}

function isJobHandler(value: string): value is WebhookFailureHandler {
  return value in HANDLER_LABELS;
}

function listStatuses(view: ViewFilter): WebhookFailureStatus[] | undefined {
  if (view === "failed") return ["failed"];
  if (view === "retrying") return RETRYING_STATUSES;
  return undefined;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const view = parseView(new URL(request.url).searchParams.get("status"));

  const staleBefore = processingLeaseCutoff();
  const [jobs, grouped, staleProcessing] = await Promise.all([
    listWebhookFailures(session.shop, {
      statuses: listStatuses(view),
      limit: 100,
    }),
    prisma.webhookFailure.groupBy({
      by: ["status"],
      where: { shop: session.shop },
      _count: { _all: true },
    }),
    prisma.webhookFailure.count({
      where: {
        shop: session.shop,
        handler: { not: "ack_drop" },
        status: "processing",
        OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lte: staleBefore } }],
      },
    }),
  ]);

  const rawCounts = {
    pending: 0,
    processing: 0,
    failed: 0,
  };
  for (const row of grouped) {
    rawCounts[row.status] = row._count._all;
  }
  const retrying = rawCounts.pending + rawCounts.processing;
  const counts = {
    failed: rawCounts.failed,
    retrying,
    total: rawCounts.failed + retrying,
  };

  const serialized: SerializedJob[] = jobs.flatMap((job) => {
    if (!isJobHandler(job.handler)) return [];
    return [
      {
        id: job.id,
        handler: job.handler,
        topic: job.topic,
        resourceId: job.resourceId.toString(),
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        updatedAt: job.updatedAt.toISOString(),
        leaseExpired: isProcessingLeaseExpired(job.lastAttemptAt),
      },
    ];
  });

  return { shop: session.shop, jobs: serialized, counts, view, staleProcessing };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  try {
    if (intent === "redrive") {
      const id = String(form.get("id") ?? "");
      const { queued } = await republishWebhookFailures(session.shop, {
        ids: [id],
      });
      if (queued === 0) {
        return {
          ok: false,
          message: await redriveSkipReason(session.shop, id),
        };
      }
      return {
        ok: true,
        message: "Redriven to Cloud Run. Refresh in a few seconds.",
      };
    }

    if (intent === "redrive_all") {
      const { queued } = await republishWebhookFailures(session.shop);
      if (queued === 0) {
        return { ok: true, message: "Nothing to redrive." };
      }
      return {
        ok: true,
        message: `Redriven ${queued} ${queued === 1 ? "dead letter" : "dead letters"} to Cloud Run.`,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }

  return { ok: false, message: "Unknown action." };
};

function statusBadge(status: WebhookFailureStatus, leaseExpired: boolean) {
  if (status === "failed") {
    return <Badge tone="critical">Dead letter</Badge>;
  }
  if (status === "processing" && leaseExpired) {
    return <Badge tone="warning">Stuck</Badge>;
  }
  return <Badge tone="attention">Retrying</Badge>;
}

export default function WebhookDeadLettersPage() {
  const { shop, jobs, counts, view, staleProcessing } =
    useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const { revalidate, state: revalidatorState } = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [banner, setBanner] = useState<{
    tone: "success" | "critical";
    message: string;
  } | null>(null);

  const redrivingId =
    fetcher.state !== "idle" ? String(fetcher.formData?.get("id") ?? "") : "";
  const redrivingAll =
    fetcher.state !== "idle" &&
    fetcher.formData?.get("intent") === "redrive_all";
  const refreshBlocked =
    revalidatorState !== "idle" || fetcher.state !== "idle";
  const refreshBlockedRef = useRef(refreshBlocked);
  refreshBlockedRef.current = refreshBlocked;

  useEffect(() => {
    if (!autoRefresh) return;

    const refresh = () => {
      if (document.hidden || refreshBlockedRef.current) return;
      revalidate();
    };

    refresh();
    const interval = window.setInterval(refresh, REFRESH_MS);
    const onVisibility = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [autoRefresh, revalidate]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.message) return;
    setBanner({
      tone: fetcher.data.ok ? "success" : "critical",
      message: fetcher.data.message,
    });
  }, [fetcher.state, fetcher.data]);

  const subtitle = useMemo(() => {
    return `${counts.failed} dead ${counts.failed === 1 ? "letter" : "letters"} · ${counts.retrying} retrying`;
  }, [counts.failed, counts.retrying]);

  return (
    <Page
      title="Webhook dead letters"
      subtitle={subtitle}
      fullWidth
      primaryAction={
        counts.failed + staleProcessing > 0
          ? {
              content: "Redrive all",
              loading: redrivingAll,
              onAction: () => {
                const form = new FormData();
                form.set("intent", "redrive_all");
                fetcher.submit(form, { method: "post" });
              },
            }
          : undefined
      }
    >
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {banner && (
              <Banner
                tone={banner.tone}
                onDismiss={() => setBanner(null)}
              >
                {banner.message}
              </Banner>
            )}

            <Card>
              <BlockStack gap="300">
                <Select
                  label="Status"
                  labelHidden
                  options={[
                    {
                      label: `Dead letters (${counts.failed})`,
                      value: "failed",
                    },
                    {
                      label: `Retrying (${counts.retrying})`,
                      value: "retrying",
                    },
                    { label: `All (${counts.total})`, value: "all" },
                  ]}
                  value={view}
                  onChange={(value) => {
                    const params = new URLSearchParams(searchParams);
                    if (value === "failed") params.delete("status");
                    else params.set("status", value);
                    setSearchParams(params);
                  }}
                />
                <Checkbox
                  label="Auto-refresh every 10 seconds"
                  checked={autoRefresh}
                  onChange={setAutoRefresh}
                />
              </BlockStack>
            </Card>

            {jobs.length === 0 ? (
              <Card>
                <Text as="p" tone="subdued">
                  {view === "retrying"
                    ? "Nothing auto-retrying."
                    : view === "all"
                      ? "No webhook failures."
                      : "No dead letters."}
                </Text>
              </Card>
            ) : (
              <Card padding="0">
                <IndexTable
                  resourceName={{
                    singular: "dead letter",
                    plural: "dead letters",
                  }}
                  itemCount={jobs.length}
                  headings={[
                    { title: "Handler" },
                    { title: "Resource" },
                    { title: "Status" },
                    { title: "Attempts" },
                    { title: "Error" },
                    { title: "Updated" },
                    { title: "Actions" },
                  ]}
                  selectable={false}
                >
                  {jobs.map((job, index) => {
                    const adminUrl = resourceAdminUrl(
                      shop,
                      job.handler,
                      job.resourceId,
                    );
                    const canRedrive =
                      job.handler !== "ack_drop" &&
                      (job.status === "failed" ||
                        (job.status === "processing" && job.leaseExpired));
                    const busy = redrivingAll || redrivingId === job.id;

                    return (
                      <IndexTable.Row
                        id={job.id}
                        key={job.id}
                        position={index}
                      >
                        <IndexTable.Cell>
                          <BlockStack gap="050">
                            <Text as="span" fontWeight="medium">
                              {HANDLER_LABELS[job.handler]}
                            </Text>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {job.topic}
                            </Text>
                          </BlockStack>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {adminUrl ? (
                            <Link url={adminUrl} target="_blank" removeUnderline>
                              {job.resourceId}
                            </Link>
                          ) : (
                            job.resourceId
                          )}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {statusBadge(job.status, job.leaseExpired)}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {job.attempts}/{job.maxAttempts}
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Text as="span" variant="bodySm" breakWord>
                            {job.errorCode
                              ? `${job.errorCode}${job.errorMessage ? `: ${job.errorMessage}` : ""}`
                              : "—"}
                          </Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Text as="span" variant="bodySm" tone="subdued">
                            {new Date(job.updatedAt).toLocaleString()}
                          </Text>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          {canRedrive ? (
                            <Button
                              size="slim"
                              loading={busy && redrivingId === job.id}
                              disabled={busy}
                              onClick={() => {
                                const form = new FormData();
                                form.set("intent", "redrive");
                                form.set("id", job.id);
                                fetcher.submit(form, { method: "post" });
                              }}
                            >
                              Redrive
                            </Button>
                          ) : (
                            <Text as="span" tone="subdued">
                              —
                            </Text>
                          )}
                        </IndexTable.Cell>
                      </IndexTable.Row>
                    );
                  })}
                </IndexTable>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
