import { BlockStack, Box, Card, Divider, Page, Text } from "@shopify/polaris";
import { prisma } from "app/db.server";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
	const url = new URL(request.url);
	const ids = url.searchParams.get("ids")?.split(",").map(Number) || [];

	const orders = await prisma.order.findMany({
		where: { id: { in: ids } },
		include: {
			lineItems: {
				orderBy: {
					storeSection: 'asc',
				}
			},
			customer: true,
		},
		orderBy: { orderNumber: 'asc' }
	});

	return { orders };
};

export default function PerOrderPickList() {
	const { orders } = useLoaderData<typeof loader>();

	return (
		<Page
			title=""
			primaryAction={{ content: "Print", onAction: () => window.print() }}
		>
			<style dangerouslySetInnerHTML={{
				__html: `
				/* 1. SCREEN ONLY STYLES (What you see in the app) */
				@media screen {
				.printable-order-card {
					margin-bottom: 16px;
				}
				}

				/* 2. PRINT ONLY STYLES (What the printer sees) */
				@media print {
				/* Kill the Shopify layout height restrictions */
				html, body {
					height: auto !important;
					overflow: visible !important;
					background: white !important;
				}

				/* Hide UI elements */
				button, nav, header, .p-d-none-print, .Polaris-Page-Header, .Polaris-Backdrop { 
					display: none !important; 
				}

				/* Force the container to be full width and un-restricted */
				.Polaris-Page, .Polaris-Page__Content, .Polaris-Layout {
					max-width: none !important;
					width: 100% !important;
					padding: 0 !important;
					margin: 0 !important;
				}

				/* Each order gets its own physical page */
				.printable-order-card {
					display: block !important;
					page-break-after: always !important;
					break-after: page !important;
					padding-top: 20px; /* Give some breathing room at the top of the sheet */
				}

				/* Clean up the Card for black and white printing */
				.Polaris-Card {
					box-shadow: none !important;
					border: 1px solid #000 !important;
				}

				/* Prevent the very last sheet from being blank */
				.printable-order-card:last-child {
					page-break-after: auto !important;
					break-after: auto !important;
				}
				}
				* {
        -webkit-print-color-adjust: exact !important;
        print-color-adjust: exact !important;
      }

      .printable-order-card {
        display: block !important;
        page-break-after: always !important;
        break-after: page !important;
      }

      /* Ensure the box has a heavy enough border to be seen by the printer */
      .checkbox-square {
        width: 18px !important;
        height: 18px !important;
        border: 2px solid #000 !important; /* Thick black border */
        background-color: #fff !important;
        display: inline-block !important;
      }
    }
			`
			}} />

			<BlockStack gap="600">
				{orders.map((order) => (
					<div key={order.id} className="printable-order-card">
						<Card>
							<Box padding="400">
								<BlockStack gap="300">
									<div style={{ display: 'flex', justifyContent: 'space-between' }}>
										<Text variant="headingLg" as="h2">Order #{order.orderNumber}</Text>
										<Text variant="bodyMd" as="span">
											{new Date(order.createdAt).toLocaleDateString()}
										</Text>
									</div>

									<Text variant="bodySm" tone="subdued" as="p">
										Customer: {order.customer?.firstName} {order.customer?.lastName}
									</Text>

									<Divider />



									<table style={{ width: '100%', borderCollapse: 'collapse' }}>
										<thead>
											<tr style={{ textAlign: 'left', borderBottom: '1px solid black' }}>
												<th style={{ padding: '8px 0', width: '40px' }}><Text as="span" variant="bodySm">[ ]</Text></th>
												<th style={{ padding: '8px 0', width: '50px' }}><Text as="span" variant="bodySm">Qty</Text></th>
												<th style={{ padding: '8px 0', width: '100px' }}><Text as="span" variant="bodySm">Section</Text></th>
												<th style={{ padding: '8px 0', width: '150px' }}><Text as="span" variant="bodySm">SKU</Text></th> {/* New SKU Column */}
												<th style={{ padding: '8px 0' }}><Text as="span" variant="bodySm">Product</Text></th>
											</tr>
										</thead>
										<tbody>
											{order.lineItems.map((item) => (
												<tr key={item.id} style={{ borderBottom: '0.5px solid #eee' }}>
													<td style={{ padding: '12px 0' }}>
														<div className="checkbox-square" />
													</td>
													<td style={{ padding: '12px 0' }}>
														<Text variant="bodyLg" fontWeight="bold" as="span">{item.quantity}</Text>
													</td>

													<td style={{ padding: '12px 0' }}>
														<Text variant="bodyMd" as="span">
															{item.storeSection || "—"}
														</Text>
													</td>

													<td style={{ padding: '12px 0' }}>
														<Text variant="bodyMd" as="span" fontWeight="medium">
															<span style={{ fontFamily: 'monospace' }}>{item.sku || "—"}</span>
														</Text>
													</td>

													<td style={{ padding: '12px 0' }}>
														<Text as="span" variant="bodyMd">{item.title}</Text>
													</td>
												</tr>
											))}
										</tbody>
									</table>
								</BlockStack>
							</Box>
						</Card>
					</div>
				))}
			</BlockStack>
		</Page>
	);
}