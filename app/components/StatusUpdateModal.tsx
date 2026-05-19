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

const SYNC_POLL_MS = 2_000;
const SYNC_TIMEOUT_MS = 60_000;

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
	const [isWaitingForWebhook, setIsWaitingForWebhook] = useState(false);
	const [syncError, setSyncError] = useState<string | null>(null);
	const choicesFetchedForOrder = useRef<string | null>(null);
	const pendingSyncRef = useRef<{ ids: string[]; statusName: string } | null>(
		null,
	);
	const pollGenerationRef = useRef(0);
	const wasSubmittingRef = useRef(false);
	const onSuccessRef = useRef(onSuccess);
	const onCloseRef = useRef(onClose);

	onSuccessRef.current = onSuccess;
	onCloseRef.current = onClose;

	const isOverLimit = selectedIds.length > 50;
	const representativeOrderId = selectedIds[0] ?? null;

	const stopPolling = useCallback(() => {
		pollGenerationRef.current += 1;
	}, []);

	useEffect(() => {
		if (!open) {
			setNewStatus([]);
			setIsWaitingForWebhook(false);
			setSyncError(null);
			pendingSyncRef.current = null;
			wasSubmittingRef.current = false;
			choicesFetchedForOrder.current = null;
			stopPolling();
			return;
		}

		if (!representativeOrderId || isOverLimit) return;
		if (choicesFetchedForOrder.current === representativeOrderId) return;

		choicesFetchedForOrder.current = representativeOrderId;
		setIsLoadingChoices(true);
		setChoicesError(null);

		fetch(
			`/api/viable-statuses?id=${encodeURIComponent(representativeOrderId)}`,
		)
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
				choicesFetchedForOrder.current = null;
				setChoicesError(
					error instanceof Error ? error.message : "Could not load statuses",
				);
			})
			.finally(() => setIsLoadingChoices(false));
	}, [open, isOverLimit, representativeOrderId, stopPolling]);

	const handleAction = useCallback(() => {
		const statusCode = newStatus[0];
		const statusLabel = statusChoices.find((s) => s.value === statusCode)?.label;
		stopPolling();
		pendingSyncRef.current = {
			ids: selectedIds,
			statusName: statusLabel ?? statusCode,
		};
		setSyncError(null);
		wasSubmittingRef.current = true;
		fetcher.submit(
			{
				ids: selectedIds.join(","),
				status_code: statusCode,
			},
			{ method: "POST", action: "/api/update-status" },
		);
	}, [selectedIds, newStatus, statusChoices, fetcher, stopPolling]);

	useEffect(() => {
		if (fetcher.state === "submitting" || fetcher.state === "loading") {
			wasSubmittingRef.current = true;
			return;
		}
		if (fetcher.state !== "idle" || !wasSubmittingRef.current) return;
		wasSubmittingRef.current = false;

		const pending = pendingSyncRef.current;
		const syncedAfter =
			typeof fetcher.data?.syncedAfter === "string"
				? fetcher.data.syncedAfter
				: null;

		if (!fetcher.data?.success || !pending || !syncedAfter) return;

		const generation = ++pollGenerationRef.current;
		setIsWaitingForWebhook(true);

		const params = new URLSearchParams({
			ids: pending.ids.join(","),
			since: syncedAfter,
			status_name: pending.statusName,
		});
		const startedAt = Date.now();

		const finish = (error?: string) => {
			if (pollGenerationRef.current !== generation) return;
			stopPolling();
			pendingSyncRef.current = null;
			setIsWaitingForWebhook(false);
			if (error) {
				setSyncError(error);
				return;
			}
			setNewStatus([]);
			onSuccessRef.current?.();
			onCloseRef.current();
		};

		const poll = async () => {
			if (pollGenerationRef.current !== generation) return;

			if (Date.now() - startedAt > SYNC_TIMEOUT_MS) {
				finish("Status did not sync from Order Status Pro in time.");
				return;
			}

			try {
				const res = await fetch(`/api/order-status-sync?${params}`);
				const data = (await res.json()) as { synced?: boolean; error?: string };

				if (res.status === 429) {
					finish(
						data.error ??
							"Too many requests while checking status. Refresh the page in a few seconds.",
					);
					return;
				}

				if (res.ok && data.synced) {
					finish();
					return;
				}
			} catch {
				// keep polling
			}

			if (pollGenerationRef.current === generation) {
				setTimeout(() => {
					void poll();
				}, SYNC_POLL_MS);
			}
		};

		void poll();
	}, [fetcher.state, fetcher.data, stopPolling]);

	const handleClose = useCallback(() => {
		if (isWaitingForWebhook) return;
		onClose();
	}, [isWaitingForWebhook, onClose]);

	const choicesReady = statusChoices.length > 0;
	const isBusy = fetcher.state !== "idle" || isWaitingForWebhook;

	return (
		<Modal
			open={open}
			onClose={handleClose}
			title={selectedIds.length > 1 ? `Bulk Update ${selectedIds.length} Orders` : "Update Order Status"}
			primaryAction={{
				content: "Update Status",
				onAction: handleAction,
				disabled:
					newStatus.length === 0 ||
					isOverLimit ||
					isLoadingChoices ||
					!choicesReady ||
					isWaitingForWebhook,
				loading: isBusy,
			}}
			secondaryActions={[
				{
					content: "Cancel",
					onAction: handleClose,
					disabled: isWaitingForWebhook,
				},
			]}
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

							{isWaitingForWebhook && (
								<Banner tone="info">
									<p>Waiting for Order Status Pro to confirm the new status…</p>
								</Banner>
							)}

							{fetcher.data?.error && (
								<Banner tone="critical">
									<p>{fetcher.data.error}</p>
								</Banner>
							)}

							{syncError && (
								<Banner tone="critical">
									<p>{syncError}</p>
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
										disabled={isWaitingForWebhook}
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
