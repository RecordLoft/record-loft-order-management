import {
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  InlineStack,
  Layout,
  Link,
  Page,
  Text,
  TextField,
} from "@shopify/polaris";
import { SearchIcon } from "@shopify/polaris-icons";
import { StatusUpdateModal } from "app/components/StatusUpdateModal";
import {
  filterRecordPlanetOrdersForSearch,
  getRecordPlanetSearchMatch,
  parseProperties,
  recordPlanetOrderWhere,
  type GloboProperties,
} from "app/record-planet.server";
import { useEffect, useMemo, useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useNavigation, useSearchParams } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

type SerializedProduct = {
  id: string;
  title: string;
  properties: GloboProperties | null;
};

type SerializedOrder = {
  id: string;
  orderNumber: number;
  createdAt: string;
  customerId: string | null;
  product: SerializedProduct | null;
  status: { name?: string } | string;
};

type SerializedCustomer = {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
};

type CustomerGroup = {
  customer: SerializedCustomer | null;
  orders: SerializedOrder[];
};

function formatCustomerName(customer: SerializedCustomer | null): string {
  if (!customer) return "Unknown customer";
  const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ");
  return name || customer.email || "Unknown customer";
}

function serializeProduct(
  item: {
    id: bigint;
    title: string;
    properties: unknown;
  } | undefined,
): SerializedProduct | null {
  if (!item) return null;
  return {
    id: item.id.toString(),
    title: item.title,
    properties: parseProperties(item.properties),
  };
}

function groupOrdersByCustomer(
  orders: SerializedOrder[],
  customers: Record<string, SerializedCustomer>,
): CustomerGroup[] {
  const groups = new Map<string, CustomerGroup>();

  for (const order of orders) {
    if (!order.product) continue;

    const key = order.customerId ?? "unknown";
    if (!groups.has(key)) {
      groups.set(key, {
        customer: order.customerId ? customers[key] ?? null : null,
        orders: [],
      });
    }
    groups.get(key)!.orders.push(order);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      orders: [...group.orders].sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    }))
    .sort((a, b) => {
      const nameA = formatCustomerName(a.customer).toLowerCase();
      const nameB = formatCustomerName(b.customer).toLowerCase();
      return nameA.localeCompare(nameB);
    });
}

const PROPERTY_DISPLAY_ORDER = ["Title", "Artist", "Format"] as const;

function ProductDetails({ product }: { product: SerializedProduct }) {
  const { properties } = product;
  const rows: { label: string; value: string }[] = [];

  rows.push({
    label: "Title",
    value: properties?.Title ?? product.title,
  });

  if (properties) {
    for (const key of PROPERTY_DISPLAY_ORDER) {
      if (key === "Title") continue;
      const value = properties[key];
      if (value) rows.push({ label: key, value });
    }

    for (const [key, value] of Object.entries(properties)) {
      if (
        PROPERTY_DISPLAY_ORDER.includes(key as (typeof PROPERTY_DISPLAY_ORDER)[number]) ||
        !value
      ) {
        continue;
      }
      rows.push({ label: key, value });
    }
  }

  return (
    <BlockStack gap="050">
      {rows.map(({ label, value }) => (
        <Text key={label} as="p" variant="bodySm">
          <Text as="span" tone="subdued">
            {label}:{" "}
          </Text>
          {value}
        </Text>
      ))}
    </BlockStack>
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const searchQuery = new URL(request.url).searchParams.get("q")?.trim() ?? "";

  const [orderWhere, searchMatch] = await Promise.all([
    recordPlanetOrderWhere(searchQuery),
    getRecordPlanetSearchMatch(searchQuery),
  ]);

  const ordersRaw = await prisma.order.findMany({
    where: orderWhere,
    include: {
      customer: true,
      lineItems: { take: 1 },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const ordersFiltered = searchMatch
    ? filterRecordPlanetOrdersForSearch(ordersRaw, searchMatch)
    : ordersRaw;

  const ordersWithStatus = await Promise.all(
    ordersFiltered.map(async (order) => {
      try {
        const response = await fetch(
          `https://app.orderstatuspro.com/api/v1/orders/${order.id}`,
          {
            headers: {
              Authorization: `Bearer ${process.env.ORDER_STATUS_PRO_API_KEY}`,
              "Content-Type": "application/json",
            },
          },
        );

        const statusData = response.ok ? await response.json() : null;

        return {
          ...order,
          status: statusData?.status || "Unknown",
        };
      } catch {
        return { ...order, status: "Error" };
      }
    }),
  );

  const serializedOrders: SerializedOrder[] = ordersWithStatus.map((order) => ({
    id: order.id.toString(),
    orderNumber: order.orderNumber,
    createdAt: order.createdAt.toISOString(),
    customerId: order.customerId?.toString() ?? null,
    product: serializeProduct(order.lineItems[0]),
    status: order.status,
  }));

  const customers: Record<string, SerializedCustomer> = {};
  for (const order of ordersWithStatus) {
    if (order.customer) {
      customers[order.customer.id.toString()] = {
        id: order.customer.id.toString(),
        email: order.customer.email,
        phone: order.customer.phone,
        firstName: order.customer.firstName,
        lastName: order.customer.lastName,
      };
    }
  }

  const customerGroups = groupOrdersByCustomer(serializedOrders, customers);
  const totalOrders = customerGroups.reduce((n, g) => n + g.orders.length, 0);

  return {
    searchQuery,
    customerGroups,
    totalOrders,
    shop: session.shop,
  };
};

export default function RecordPlanetOrders() {
  const { searchQuery, customerGroups, totalOrders, shop } =
    useLoaderData<typeof loader>();

  const fetcher = useFetcher();
  const navigation = useNavigation();
  const [, setSearchParams] = useSearchParams();

  const [inputValue, setInputValue] = useState(searchQuery);
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [showStatusModal, setShowStatusModal] = useState(false);
  const [targetIds, setTargetIds] = useState<string[]>([]);

  const isSearching = navigation.state === "loading";

  useEffect(() => {
    setInputValue(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    const next = inputValue.trim();
    if (next === searchQuery) return;

    const timer = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next) params.set("q", next);
          else params.delete("q");
          return params;
        },
        { replace: true },
      );
    }, 300);

    return () => clearTimeout(timer);
  }, [inputValue, searchQuery, setSearchParams]);

  const toggleOrderSelection = (orderId: string) => {
    setSelectedOrderIds((current) =>
      current.includes(orderId)
        ? current.filter((id) => id !== orderId)
        : [...current, orderId],
    );
  };

  const openStatusModal = (ids: string[]) => {
    setTargetIds(ids);
    setShowStatusModal(true);
  };

  const statusName = (status: SerializedOrder["status"]) =>
    typeof status === "string" ? status : status?.name ?? "Unknown";

  const subtitle = useMemo(() => {
    if (isSearching) return "Searching…";
    return `${totalOrders} ${totalOrders === 1 ? "order" : "orders"}`;
  }, [totalOrders, isSearching]);

  return (
    <Page
      title="Record Planet"
      subtitle={subtitle}
      fullWidth
      primaryAction={
        selectedOrderIds.length > 0
          ? {
            content: `Update status (${selectedOrderIds.length})`,
            onAction: () => openStatusModal(selectedOrderIds),
          }
          : undefined
      }
    >
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="200">

              <TextField
                label="Search orders"
                labelHidden
                value={inputValue}
                onChange={setInputValue}
                placeholder="Search…"
                prefix={<SearchIcon />}
                autoComplete="off"
                clearButton
                onClearButtonClick={() => setInputValue("")}
                loading={isSearching}
              />
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          {customerGroups.length === 0 ? (
            <Card>
              <Text as="p" tone="subdued">
                {searchQuery
                  ? "No orders match your search."
                  : "No Record Planet orders yet."}
              </Text>
            </Card>
          ) : (
            <BlockStack gap="400">
              {customerGroups.map((group) => {
                const customerKey = group.customer?.id ?? "unknown";
                const customerName = formatCustomerName(group.customer);

                return (
                  <Card key={customerKey}>
                    <BlockStack gap="400">
                      <BlockStack gap="100">
                        <Text variant="headingMd" as="h2">
                          {customerName}
                        </Text>
                        {(group.customer?.email || group.customer?.phone) && (
                          <Text as="p" variant="bodySm" tone="subdued">
                            {[group.customer.email, group.customer.phone]
                              .filter(Boolean)
                              .join(" · ")}
                          </Text>
                        )}
                        <Text as="p" variant="bodySm" tone="subdued">
                          {group.orders.length}{" "}
                          {group.orders.length === 1 ? "order" : "orders"}
                        </Text>
                      </BlockStack>

                      <Divider />

                      <BlockStack gap="400">
                        {group.orders.map((order) => {
                          if (!order.product) return null;

                          const orderSelected = selectedOrderIds.includes(
                            order.id,
                          );

                          return (
                            <Box
                              key={order.id}
                              padding="300"
                              borderColor="border"
                              borderWidth="025"
                              borderRadius="200"
                            >
                              <BlockStack gap="300">
                                <InlineStack
                                  align="space-between"
                                  blockAlign="start"
                                  wrap={false}
                                >
                                  <InlineStack gap="300" blockAlign="start">
                                    <Checkbox
                                      label={`Select order #${order.orderNumber}`}
                                      labelHidden
                                      checked={orderSelected}
                                      onChange={() =>
                                        toggleOrderSelection(order.id)
                                      }
                                    />
                                    <BlockStack gap="200">
                                      <InlineStack gap="200" blockAlign="center">
                                        <Link
                                          url={`https://${shop}/admin/orders/${order.id}`}
                                          target="_blank"
                                          removeUnderline
                                        >
                                          <Text
                                            variant="bodyMd"
                                            fontWeight="bold"
                                            as="span"
                                          >
                                            #{order.orderNumber}
                                          </Text>
                                        </Link>
                                        <Text
                                          as="span"
                                          variant="bodySm"
                                          tone="subdued"
                                        >
                                          {new Date(
                                            order.createdAt,
                                          ).toLocaleDateString()}
                                        </Text>
                                      </InlineStack>
                                      <ProductDetails product={order.product} />
                                    </BlockStack>
                                  </InlineStack>

                                  <Button
                                    variant="plain"
                                    onClick={() =>
                                      openStatusModal([order.id])
                                    }
                                  >
                                    {statusName(order.status)}
                                  </Button>
                                </InlineStack>
                              </BlockStack>
                            </Box>
                          );
                        })}
                      </BlockStack>
                    </BlockStack>
                  </Card>
                );
              })}
            </BlockStack>
          )}
        </Layout.Section>
      </Layout>

      <StatusUpdateModal
        open={showStatusModal}
        onClose={() => setShowStatusModal(false)}
        selectedIds={targetIds}
        fetcher={fetcher}
      />
    </Page>
  );
}
