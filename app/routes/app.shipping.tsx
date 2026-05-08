import {
  BlockStack,
  Card,
  IndexTable,
  Layout,
  Link,
  Page,
  Text,
  useIndexResourceState
} from "@shopify/polaris";
import { StatusUpdateModal } from "app/components/StatusUpdateModal";
import { useState } from "react";
import type {
  LoaderFunctionArgs
} from "react-router";
import { useFetcher, useLoaderData, useNavigate } from "react-router";
import prisma from "../db.server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {

  const { session } = await authenticate.admin(request);

  const orders = await prisma.order.findMany({
    where: {
      shop: session.shop,
      deliveryMethod: "shipping",
    },
    include: {
      customer: true,
      lineItems: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  const ordersWithStatus = await Promise.all(
    orders.map(async (order) => {
      try {
        const response = await fetch(`https://app.orderstatuspro.com/api/v1/orders/${order.id}`, {
          headers: {
            "Authorization": `Bearer ${process.env.ORDER_STATUS_PRO_API_KEY}`,
            "Content-Type": "application/json",
          },
        });

        const statusData = response.ok ? await response.json() : null;

        return {
          ...order,
          status: statusData?.status || "Unknown",
        };
      } catch (error) {
        return { ...order, status: "Error" };
      }
    })
  );

  const serializedOrders = ordersWithStatus.map((order) => ({
    ...order,
    id: order.id.toString(),
    customerId: order.customerId?.toString(),
    totalPrice: order.totalPrice.toString(),
    lineItems: order.lineItems.map((item) => ({
      ...item,
      id: item.id.toString(),
      orderId: item.orderId.toString(),
      price: item.price.toString(),
    })),
  }));

  return { orders: serializedOrders, shop: session.shop };
};

export default function ShippingOrders() {
  const { orders, shop } = useLoaderData<typeof loader>();

  const fetcher = useFetcher();
  const navigate = useNavigate();

  const [showStatusModal, setShowStatusModal] = useState(false);
  const [targetIds, setTargetIds] = useState<string[]>([]);

  const resourceName = {
    singular: "order",
    plural: "orders",
  };

  const { selectedResources, allResourcesSelected, handleSelectionChange } =
    useIndexResourceState(orders);

  const openStatusModal = (ids: string[]) => {
    setTargetIds(ids);
    setShowStatusModal(true);
  };

  const rowMarkup = orders.map(
    ({ id, orderNumber, customer, createdAt, totalPrice, currency, lineItems, status }, index) => (
      <IndexTable.Row
        id={id}
        key={id}
        selected={selectedResources.includes(id)}
        position={index}
      >
        <IndexTable.Cell>
          <Link
            url={`https://${shop}/admin/orders/${id.split("/").pop()}`}
            target="_blank"
            removeUnderline
          >
            <Text variant="bodyMd" fontWeight="bold" as="span">#{orderNumber}</Text>
          </Link>
        </IndexTable.Cell>
        <IndexTable.Cell>{new Date(createdAt).toLocaleDateString()}</IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack gap="050">
            <Text as="span" variant="bodySm" fontWeight="medium">
              {customer?.firstName} {customer?.lastName || "No Name"}
            </Text>
            <Text as="span" variant="bodyXs" tone="subdued">{customer?.email}</Text>
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <BlockStack gap="100">
            {lineItems.map((item) => (
              <Text key={item.id} as="p" variant="bodyXs">
                {item.quantity} × {item.title}
              </Text>
            ))}
          </BlockStack>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Text as="span" fontWeight="bold">
            {new Intl.NumberFormat("en-US", {
              style: "currency",
              currency: currency,
            }).format(Number(totalPrice))}
          </Text>
        </IndexTable.Cell>

        <IndexTable.Cell>
          <span onClick={(e) => { e.stopPropagation(); openStatusModal([id]) }}>
            {status?.name}
          </span>
        </IndexTable.Cell>
      </IndexTable.Row>
    ),
  );

  return (
    <Page title="Shipping" fullWidth>
      <Layout>
        <Layout.Section>
          <Card padding="0">
            <IndexTable
              resourceName={resourceName}
              itemCount={orders.length}
              selectedItemsCount={allResourcesSelected ? "All" : selectedResources.length}
              onSelectionChange={handleSelectionChange}
              headings={[
                { title: "Order" },
                { title: "Date" },
                { title: "Customer" },
                { title: "Items" },
                { title: "Total" },
                { title: "Status" },
              ]}
              bulkActions={[
                {
                  content: "Change Status", // Bulk update trigger
                  onAction: () => openStatusModal(selectedResources),
                },
                {
                  content: "Generate Pick List",
                  onAction: () => {
                    const ids = selectedResources.join(",");
                    navigate(`/app/pick-list?ids=${ids}`);
                  },
                },
              ]}
            >
              {rowMarkup}
            </IndexTable>
          </Card>
        </Layout.Section>
      </Layout>

      {/* 3. Pass the state and fetcher to the Modal */}
      <StatusUpdateModal
        open={showStatusModal}
        onClose={() => setShowStatusModal(false)}
        selectedIds={targetIds}
        fetcher={fetcher}
      />
    </Page>
  );
}