import { BlockStack, Box, Card, Divider, Text } from "@shopify/polaris";
import { prisma } from "../db.server";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
export const loader = async ({ request }: LoaderFunctionArgs) => {
	const url = new URL(request.url);
	const ids = url.searchParams.get("ids")?.split(",").map(Number) || [];

	// Fetch all individual line items
	const lineItems = await prisma.lineItem.findMany({
		where: { orderId: { in: ids } },
		include: { order: true },
	});

	// Just format the data and sort by Store Section
	const items = lineItems
		.map((item) => ({
			id: item.id,
			section: item.storeSection || "Unassigned",
			sku: item.sku || "N/A",
			title: item.title,
			quantity: item.quantity,
			orderNumber: item.order?.orderNumber || "Unknown",
		}))
		.sort((a, b) => a.section.localeCompare(b.section));

	return { items };
};

export default function BulkPickList() {
	const { items } = useLoaderData<typeof loader>();

	if (!items?.length) {
		return <Box padding="400"><Text as="p">No items found for selected orders.</Text></Box>;
	}
	const sections = items.reduce((acc: any, item: any) => {
		if (!acc[item.section]) acc[item.section] = [];
		acc[item.section].push(item);
		return acc;
	}, {});

	return (
		<div style={{ padding: '10px', backgroundColor: 'white' }}>
			<BlockStack gap="400">
				<Box paddingBlockEnd="200">
					<Text variant="headingLg" as="h1">Pick List</Text>
				</Box>

				{Object.entries(sections).map(([sectionName, sectionItems]: [string, any]) => (
					<Card key={sectionName}>
						<Box padding="400">
							<BlockStack gap="300">
								<Text variant="headingMd" as="h2" tone="brand">Section: {sectionName}</Text>
								<Divider />
								<table style={{ width: '100%', borderCollapse: 'collapse' }}>
									<thead>
										<tr style={{ textAlign: 'left', borderBottom: '1px solid black' }}>
											<th style={{ width: '40px', padding: '8px 0' }}><Text as="span" variant="bodySm" tone="subdued">[ ]</Text></th>
											<th style={{ width: '100px' }}><Text as="span" variant="bodySm" tone="subdued">Order</Text></th>
											<th style={{ width: '150px' }}><Text as="span" variant="bodySm" tone="subdued">SKU</Text></th>
											<th><Text as="span" variant="bodySm" tone="subdued">Product</Text></th>
											<th style={{ width: '50px', textAlign: 'right' }}><Text as="span" variant="bodySm" tone="subdued">Qty</Text></th>
										</tr>
									</thead>
									<tbody>
										{sectionItems.map((item: any) => (
											<tr key={item.id} style={{ borderBottom: '1px solid #eee' }}>
												<td style={{ padding: '12px 0' }}>
													<div style={{ width: '18px', height: '18px', border: '2px solid black' }} />
												</td>
												<td>
													<Text as="span" variant="bodyMd" fontWeight="bold">#{item.orderNumber}</Text>
												</td>
												<td style={{ fontFamily: 'monospace' }}>
													<Text as="span" variant="bodyMd">{item.sku}</Text>
												</td>
												<td style={{ padding: '8px 0' }}>
													<Text as="span" variant="bodyMd">{item.title}</Text>
												</td>
												<td style={{ textAlign: 'right' }}>
													<Text as="span" variant="bodyMd">{item.quantity}</Text>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</BlockStack>
						</Box>
					</Card>
				))}
			</BlockStack>

			<style dangerouslySetInnerHTML={{
				__html: `
			@media print {
			  .Polaris-Card { break-inside: avoid; margin-bottom: 10px; }
			  body { -webkit-print-color-adjust: exact; }
			}
		  `}} />
		</div>
	);
}