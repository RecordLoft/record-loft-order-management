import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  IndexTable,
  Layout,
  Link,
  Page,
  Select,
  Text,
} from "@shopify/polaris";
import {
  WebhookFailureHandler,
  WebhookFailureStatus,
} from "../../generated/prisma/client";
import { useEffect, useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  useFetcher,
  useLoaderData,
  useSearchParams,
} from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";
import {
  listWebhookFailures,
  retryWebhookFailure,
  retryWebhookFailuresForShop,
} from "../webhook-queue.server";

const HANDLER_LABELS: Record<WebhookFailureHandler, string> = {
  [WebhookFailureHandler.orders_create]: "Orders create",
  [WebhookFailureHandler.product_description_sync]: "Product description",
};

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
};

function resourceAdminUrl(
  shop: string,
  handler: WebhookFailureHandler,
  resourceId: string,
): string | null {
  if (handler === WebhookFailureHandler.orders_create) {
    return `https://${shop}/admin/orders/${resourceId}`;
  }
  if (handler === WebhookFailureHandler.product_description_sync) {
    return `https://${shop}/admin/products/${resourceId}`;
  }
  return null;
}

function parseStatus(raw: string | null): WebhookFailureStatus | undefined {
  if (
    raw &&
    Object.values(WebhookFailureStatus).includes(raw as WebhookFailureStatus)
  ) {
    return raw as WebhookFailureStatus;
  }
  return undefined;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const status = parseStatus(new URL(request.url).searchParams.get("status"));

  const [jobs, grouped] = await Promise.all([
    listWebhookFailures(session.shop, { status, limit: 100 }),
    prisma.webhookFailure.groupBy({
      by: ["status"],
      where: { shop: session.shop },
      _count: { _all: true },
    }),
  ]);

  const counts = {
    pending: 0,
    processing: 0,
    failed: 0,
  };
  for (const row of grouped) {
    counts[row.status] = row._count._all;
  }
  const total = counts.pending + counts.processing + counts.failed;

  const serialized: SerializedJob[] = jobs.map((job) => ({
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
  }));

  return { shop: session.shop, jobs: serialized, counts, total, status: status ?? "all" };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "retry") {
    const id = String(form.get("id") ?? "");
    const job = await retryWebhookFailure(id, { shop: session.shop });
    if (!job) {
      return { ok: false, message: "Job not found or already processing." };
    }
    if (job.outcome === "failure") {
      return {
        ok: false,
        message: `Retry failed (${job.code}): ${job.message}`,
      };
    }
    return {
      ok: true,
      message: `Job ${job.outcome}${job.detail ? `: ${job.detail}` : ""}`,
    };
  }

  if (intent === "retry_all") {
    const { processed, jobs } = await retryWebhookFailuresForShop(session.shop);
    if (processed === 0) {
      return { ok: true, message: "Nothing to retry." };
    }
    const failed = jobs.filter((job) => job.outcome === "failure").length;
    return {
      ok: failed === 0,
      message: `Retried ${processed}: ${processed - failed} succeeded, ${failed} failed.`,
    };
  }

  return { ok: false, message: "Unknown action." };
};

function statusBadge(status: WebhookFailureStatus) {
  if (status === WebhookFailureStatus.failed) {
    return <Badge tone="critical">Failed</Badge>;
  }
  if (status === WebhookFailureStatus.processing) {
    return <Badge tone="info">Processing</Badge>;
  }
  return <Badge tone="attention">Pending</Badge>;
}

export default function WebhookFailuresPage() {
  const { shop, jobs, counts, total, status } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [banner, setBanner] = useState<{
    tone: "success" | "critical";
    message: string;
  } | null>(null);

  const retryingId =
    fetcher.state !== "idle" ? String(fetcher.formData?.get("id") ?? "") : "";
  const retryingAll =
    fetcher.state !== "idle" && fetcher.formData?.get("intent") === "retry_all";

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data?.message) return;
    setBanner({
      tone: fetcher.data.ok ? "success" : "critical",
      message: fetcher.data.message,
    });
  }, [fetcher.state, fetcher.data]);

  const subtitle = useMemo(() => {
    return `${total} ${total === 1 ? "job" : "jobs"} · ${counts.failed} failed · ${counts.pending} pending`;
  }, [total, counts.failed, counts.pending]);

  const retryableCount = counts.pending + counts.failed;

  return (
    <Page
      title="Webhook failures"
      subtitle={subtitle}
      fullWidth
      primaryAction={
        retryableCount > 0
          ? {
              content: "Retry all",
              loading: retryingAll,
              onAction: () => {
                const form = new FormData();
                form.set("intent", "retry_all");
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
              <Select
                label="Status"
                labelHidden
                options={[
                  { label: `All (${total})`, value: "all" },
                  { label: `Pending (${counts.pending})`, value: "pending" },
                  {
                    label: `Processing (${counts.processing})`,
                    value: "processing",
                  },
                  { label: `Failed (${counts.failed})`, value: "failed" },
                ]}
                value={status}
                onChange={(value) => {
                  const params = new URLSearchParams(searchParams);
                  if (value === "all") params.delete("status");
                  else params.set("status", value);
                  setSearchParams(params);
                }}
              />
            </Card>

            {jobs.length === 0 ? (
              <Card>
                <Text as="p" tone="subdued">
                  {status === "all"
                    ? "No queued or failed webhook jobs."
                    : `No ${status} webhook jobs.`}
                </Text>
              </Card>
            ) : (
              <Card padding="0">
                <IndexTable
                  resourceName={{ singular: "job", plural: "jobs" }}
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
                    const canRetry =
                      job.status !== WebhookFailureStatus.processing;
                    const busy = retryingAll || retryingId === job.id;

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
                        <IndexTable.Cell>{statusBadge(job.status)}</IndexTable.Cell>
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
                          {canRetry ? (
                            <Button
                              size="slim"
                              loading={busy && retryingId === job.id}
                              disabled={busy}
                              onClick={() => {
                                const form = new FormData();
                                form.set("intent", "retry");
                                form.set("id", job.id);
                                fetcher.submit(form, { method: "post" });
                              }}
                            >
                              Retry
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
