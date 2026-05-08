import { Banner, BlockStack, Box, ChoiceList, Modal, SkeletonBodyText } from "@shopify/polaris";
import { useCallback, useEffect, useState } from "react";
import type { FetcherWithComponents } from "react-router";

interface StatusUpdateModalProps {
	open: boolean;
	onClose: () => void;
	selectedIds: string[];
	fetcher: FetcherWithComponents<any>;
}

export function StatusUpdateModal({ open, onClose, selectedIds, fetcher }: StatusUpdateModalProps) {
	const [newStatus, setNewStatus] = useState<string[]>([]);
	const [viableStatuses, setViableStatuses] = useState<{ label: string; value: string }[]>([]);
	const [isLoading, setIsLoading] = useState(false);

	const isOverLimit = selectedIds.length > 50;

	useEffect(() => {
		if (open && selectedIds.length > 0 && !isOverLimit) {
			setIsLoading(true);
			const targetId = selectedIds[0].split("/").pop();

			fetch(`/api/viable-statuses?id=${targetId}`)
				.then((res) => res.json())
				.then((data) => {
					setViableStatuses(data);
					setIsLoading(false);
				})
				.catch(() => setIsLoading(false));
		}
	}, [open, selectedIds, isOverLimit]);

	const handleAction = useCallback(() => {
		fetcher.submit(
			{
				ids: selectedIds.join(','),
				status_code: newStatus[0], // Updated key to match API
			},
			{ method: "POST", action: "/api/update-status" }
		);
	}, [selectedIds, newStatus, fetcher]);

	useEffect(() => {
		if (fetcher.state === "idle" && fetcher.data?.success) {
			setNewStatus([]);
			onClose();
		}
	}, [fetcher.state, fetcher.data, onClose]);

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={selectedIds.length > 1 ? `Bulk Update ${selectedIds.length} Orders` : "Update Order Status"}
			primaryAction={{
				content: "Update Status",
				onAction: handleAction,
				disabled: newStatus.length === 0 || isLoading || isOverLimit,
				loading: fetcher.state !== "idle",
			}}
			secondaryActions={[{ content: "Cancel", onAction: onClose }]}
		>
			<Modal.Section>
				<BlockStack gap="400">
					{isOverLimit ? (
						<Banner tone="critical">
							<p>You can only update up to 50 orders at a time.</p>
						</Banner>
					) : (
						<>
							{selectedIds.length > 1 && (
								<Banner tone="info">
									<p>Updating {selectedIds.length} orders simultaneously.</p>
								</Banner>
							)}

							{fetcher.data?.error && (
								<Banner tone="critical">
									<p>{fetcher.data.error}</p>
								</Banner>
							)}

							{isLoading ? (
								<Box paddingBlockStart="200">
									<SkeletonBodyText lines={3} />
								</Box>
							) : (
								<ChoiceList
									title="Select new status"
									choices={viableStatuses}
									selected={newStatus}
									onChange={(value) => setNewStatus(value)}
								/>
							)}
						</>
					)}
				</BlockStack>
			</Modal.Section>
		</Modal>
	);
}