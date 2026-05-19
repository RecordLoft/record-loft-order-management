import {
	Banner,
	BlockStack,
	Box,
	ChoiceList,
	Modal,
	SkeletonBodyText,
} from "@shopify/polaris";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FetcherWithComponents } from "react-router";
import type { StatusChoice } from "../order-status-pro.server";

interface StatusUpdateModalProps {
	open: boolean;
	onClose: () => void;
	selectedIds: string[];
	fetcher: FetcherWithComponents<any>;
	onSuccess?: () => void;
}

export function StatusUpdateModal({
	open,
	onClose,
	selectedIds,
	fetcher,
	onSuccess,
}: StatusUpdateModalProps) {
	const [newStatus, setNewStatus] = useState<string[]>([]);
	const [statusChoices, setStatusChoices] = useState<StatusChoice[]>([]);
	const [isLoadingChoices, setIsLoadingChoices] = useState(false);
	const [choicesError, setChoicesError] = useState<string | null>(null);
	const choicesFetched = useRef(false);

	const isOverLimit = selectedIds.length > 50;

	useEffect(() => {
		if (!open) {
			setNewStatus([]);
			return;
		}

		if (choicesFetched.current || isOverLimit) return;

		choicesFetched.current = true;
		setIsLoadingChoices(true);
		setChoicesError(null);

		fetch("/api/viable-statuses")
			.then(async (res) => {
				const data = await res.json();
				if (!res.ok) {
					throw new Error(
						typeof data?.error === "string" ? data.error : "Could not load statuses",
					);
				}
				if (!Array.isArray(data)) {
					throw new Error("Unexpected response from status API");
				}
				setStatusChoices(data);
			})
			.catch((error: unknown) => {
				choicesFetched.current = false;
				setChoicesError(
					error instanceof Error ? error.message : "Could not load statuses",
				);
			})
			.finally(() => setIsLoadingChoices(false));
	}, [open, isOverLimit]);

	const handleAction = useCallback(() => {
		fetcher.submit(
			{
				ids: selectedIds.join(","),
				status_code: newStatus[0],
			},
			{ method: "POST", action: "/api/update-status" },
		);
	}, [selectedIds, newStatus, fetcher]);

	useEffect(() => {
		if (fetcher.state === "idle" && fetcher.data?.success) {
			setNewStatus([]);
			onSuccess?.();
			onClose();
		}
	}, [fetcher.state, fetcher.data, onClose, onSuccess]);

	const choicesReady = statusChoices.length > 0;

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={selectedIds.length > 1 ? `Bulk Update ${selectedIds.length} Orders` : "Update Order Status"}
			primaryAction={{
				content: "Update Status",
				onAction: handleAction,
				disabled:
					newStatus.length === 0 ||
					isOverLimit ||
					isLoadingChoices ||
					!choicesReady,
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

							{choicesError && (
								<Banner tone="critical">
									<p>{choicesError}</p>
								</Banner>
							)}

							{isLoadingChoices ? (
								<Box paddingBlockStart="200">
									<SkeletonBodyText lines={3} />
								</Box>
							) : !choicesError && !choicesReady ? (
								<Banner tone="warning">
									<p>No statuses are configured in Order Status Pro.</p>
								</Banner>
							) : (
								choicesReady && (
									<ChoiceList
										title="Select new status"
										choices={statusChoices}
										selected={newStatus}
										onChange={(value) => setNewStatus(value)}
									/>
								)
							)}
						</>
					)}
				</BlockStack>
			</Modal.Section>
		</Modal>
	);
}
