import { Banner, BlockStack, ChoiceList, Modal } from "@shopify/polaris";
import { useCallback, useEffect, useState } from "react";
import type { FetcherWithComponents } from "react-router";
import type { StatusChoice } from "../order-status-pro.server";

interface StatusUpdateModalProps {
	open: boolean;
	onClose: () => void;
	selectedIds: string[];
	statusChoices: StatusChoice[];
	fetcher: FetcherWithComponents<any>;
	onSuccess?: () => void;
}

export function StatusUpdateModal({
	open,
	onClose,
	selectedIds,
	statusChoices,
	fetcher,
	onSuccess,
}: StatusUpdateModalProps) {
	const [newStatus, setNewStatus] = useState<string[]>([]);

	const isOverLimit = selectedIds.length > 50;

	useEffect(() => {
		if (!open) {
			setNewStatus([]);
		}
	}, [open]);

	const handleAction = useCallback(() => {
		const statusCode = newStatus[0];
		const statusLabel = statusChoices.find((s) => s.value === statusCode)?.label;
		fetcher.submit(
			{
				ids: selectedIds.join(","),
				status_code: statusCode,
				status_name: statusLabel ?? statusCode,
			},
			{ method: "POST", action: "/api/update-status" },
		);
	}, [selectedIds, newStatus, statusChoices, fetcher]);

	useEffect(() => {
		if (fetcher.state === "idle" && fetcher.data?.success) {
			setNewStatus([]);
			onSuccess?.();
			onClose();
		}
	}, [fetcher.state, fetcher.data, onClose, onSuccess]);

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={selectedIds.length > 1 ? `Bulk Update ${selectedIds.length} Orders` : "Update Order Status"}
			primaryAction={{
				content: "Update Status",
				onAction: handleAction,
				disabled: newStatus.length === 0 || isOverLimit || statusChoices.length === 0,
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

							{statusChoices.length === 0 ? (
								<Banner tone="warning">
									<p>No statuses are configured in Order Status Pro.</p>
								</Banner>
							) : (
								<ChoiceList
									title="Select new status"
									choices={statusChoices}
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
