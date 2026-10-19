import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { DecisionDeckConfig } from "@tedix/api-contract/schemas/os-decision-deck";
import { interactionCardKind } from "@/lib/interaction-card-kind";
import { useDecisionInbox } from "@/lib/use-decision-inbox";
import { osQuery, userProfileQueryOptions } from "@/lib/os-query-options";
import { deckBatchKey, useSavedDeckBatch } from "@/lib/use-deck-batch";
import { attentionMetrics, deckBatchWindow } from "@/lib/deck-attention";

export function useDeckCount(
	config?: DecisionDeckConfig,
	workspaceId?: string,
) {
	const inbox = useDecisionInbox(config);
	const profile = useQuery(userProfileQueryOptions());
	const learning = useQuery({
		...osQuery.learningFeedback.listInteractions.queryOptions({
			input: { scopeKind: "personal", limit: 200 },
		}),
		enabled: Boolean(config),
	});
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = setInterval(() => setNow(new Date()), 30_000);
		return () => clearInterval(timer);
	}, []);
	const window = deckBatchWindow(config?.batchTimesUtc ?? ["00:00"], now);
	const batch = useSavedDeckBatch(
		deckBatchKey(workspaceId, profile.data?.id, config?.projectId, window.key),
	);
	const ids = new Set([
		...inbox.requests.map((row) => row.request.id),
		...inbox.factoryCards.map((card) => `factory:${card.key}`),
		...inbox.work.map((row) => `work-approval:${row.proposal.id}`),
		...(!config?.projectId ? (inbox.approvals.data?.data ?? []) : [])
			.filter((row) => row.status === "pending")
			.map((row) => `approval:${row.id}`),
	]);
	const capacity = Math.max(
		0,
		(config?.dailyAttentionBudget ?? 0) -
			attentionMetrics(learning.data?.events ?? [], now).cardsToday,
	);
	const protectedIds = new Set([
		...inbox.scheduledIds,
		...inbox.requests
			.filter((row) => interactionCardKind(row.request) === "approval")
			.map((row) => row.request.id),
		...inbox.work.map((row) => `work-approval:${row.proposal.id}`),
		...(!config?.projectId ? (inbox.approvals.data?.data ?? []) : [])
			.filter((row) => row.status === "pending")
			.map((row) => `approval:${row.id}`),
	]);
	const count = batch
		? [...ids].filter(
				(id) =>
					!batch.dismissed.includes(id) &&
					(protectedIds.has(id) || batch.ids.includes(id)),
			).length
		: new Set([...ids].slice(0, capacity).concat([...protectedIds])).size;
	return {
		...inbox,
		count,
		pending: inbox.pending || profile.isPending || learning.isPending,
		failed: inbox.failed || profile.isError || learning.isError,
	};
}
