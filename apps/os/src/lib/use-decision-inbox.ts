import { workRefreshOptions } from "@/lib/work-refresh";
import { cardScheduleDates } from "@tedix/api-contract/utils/card-schedule";
import { useCardSchedule } from "@/lib/use-card-schedule";
import {
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import type { DecisionDeckConfig } from "@tedix/api-contract/schemas/os-decision-deck";
import { osQuery, pendingApprovalsQueryOptions } from "@/lib/os-query-options";
import {
	projectDeckCards,
	type DeckRoutingReceipt,
} from "@tedix/api-contract/utils/deck-projection";
import { useFactoryCardCount } from "@/lib/use-factory-card-count";
import { useDeckRoutingAudit } from "@/lib/use-deck-routing-audit";
import { subscribeDecisionSourceRefresh } from "@/lib/decision-source-refresh";

/** The header and Deck use the same recipient checks, project scope and bounded pages. */
export function useDecisionInbox(
	config?: DecisionDeckConfig,
	destination: "deck" | "all" = "deck",
) {
	const { now, timeZone } = useCardSchedule();
	const client = useQueryClient();
	const learning = useQuery({
		...osQuery.learningFeedback.model.queryOptions({ input: {} }),
		enabled: Boolean(config),
		...workRefreshOptions,
	});
	const enabled = Boolean(config);
	useEffect(() => {
		if (enabled) return subscribeDecisionSourceRefresh(client);
	}, [enabled, client]);

	const factories = useFactoryCardCount(
		config?.factorySources ?? [],
		config?.routing,
		learning.data,
		config?.classPolicies,
	);
	const inbox = useQuery({
		...osQuery.workInteractions.listInbox.queryOptions({
			input: {
				projectId: config?.projectId,
				limit: config?.limit ?? 50,
				states: ["open"],
			},
		}),
		enabled: Boolean(config),
		...workRefreshOptions,
	});
	// A scheduled reminder can be older than the newest inbox page.
	const earlierEnabled = Boolean(config && inbox.data?.nextCursor);
	const earlier = useInfiniteQuery({
		...osQuery.workInteractions.listInbox.infiniteOptions({
			input: (cursor: { at: string; id: string } | undefined) => ({
				projectId: config?.projectId,
				limit: config?.limit ?? 50,
				states: ["open"],
				cursor,
			}),
			initialPageParam: inbox.data?.nextCursor ?? undefined,
			getNextPageParam: (page) => page.nextCursor ?? undefined,
		}),
		enabled: earlierEnabled,
		...workRefreshOptions,
	});
	useEffect(() => {
		if (
			earlierEnabled &&
			earlier.hasNextPage &&
			!earlier.isFetching &&
			!earlier.isError
		)
			void earlier.fetchNextPage();
	}, [
		earlierEnabled,
		earlier.hasNextPage,
		earlier.isFetching,
		earlier.isError,
		earlier.fetchNextPage,
	]);
	const earlierPending =
		earlierEnabled && (earlier.isPending || earlier.hasNextPage);
	const earlierFailed = earlierEnabled && earlier.isError;
	const approvalRequests = useQuery({
		...osQuery.workInteractions.listInbox.queryOptions({
			input: {
				projectId: config?.projectId,
				limit: config?.limit ?? 50,
				states: ["open"],
				decisionKind: "approval",
			},
		}),
		enabled: Boolean(config),
		...workRefreshOptions,
	});
	const approvals = useQuery({
		...pendingApprovalsQueryOptions(),
		enabled: Boolean(config) && !config?.projectId,
		...workRefreshOptions,
	});
	const workApprovals = useQuery({
		...osQuery.workApprovals.listInbox.queryOptions({
			input: {
				projectId: config?.projectId,
				limit: config?.limit ?? 50,
				statuses: ["pending"],
			},
		}),
		enabled: Boolean(config),
		...workRefreshOptions,
	});
	const candidates = [
		...new Map(
			[
				...(inbox.data?.data ?? []),
				...(earlierEnabled
					? (earlier.data?.pages.flatMap((page) => page.data) ?? [])
					: []),
				...(approvalRequests.data?.data ?? []),
			].map((row) => [row.request.id, row]),
		).values(),
	];
	const routes: DeckRoutingReceipt[] = [];
	const projected = projectDeckCards({
		requests: candidates,
		work: workApprovals.data?.data ?? [],
		runtime: config?.projectId ? [] : (approvals.data?.data ?? []),
		model: learning.data,
		now,
		timeZone,
		routing: config?.routing,
		destination,
		onRoute: (route) => routes.push(route),
	});
	useDeckRoutingAudit(routes);
	const requests = projected.flatMap((card) =>
		card.interaction ? [card.interaction] : [],
	);
	const work = projected.flatMap((card) =>
		card.workApproval ? [card.workApproval] : [],
	);
	const runtime = projected.flatMap((card) =>
		card.runtimeApproval ? [card.runtimeApproval] : [],
	);
	return {
		inbox,
		refetch: () =>
			Promise.all([
				learning.refetch(),
				inbox.refetch(),
				...(earlierEnabled ? [earlier.refetch()] : []),
				approvalRequests.refetch(),
				workApprovals.refetch(),
				...(!config?.projectId ? [approvals.refetch()] : []),
				factories.refetch(),
			]),
		approvalRequests,
		approvals: {
			...approvals,
			data: approvals.data ? { ...approvals.data, data: runtime } : undefined,
		},
		workApprovals,
		requests,
		criticalIds: new Set(
			routes.filter((row) => row.reason === "critical").map((row) => row.id),
		),
		scheduledIds: new Set(
			requests
				.filter((row) => cardScheduleDates(row.request).length > 0)
				.map((row) => row.request.id),
		),
		work,
		factoryPending: factories.pending,
		factoryCards: factories.cards,
		factoryWaiting: factories.waiting,
		factoryCount: factories.count,
		count: requests.length + work.length + runtime.length + factories.count,
		queuePending:
			inbox.isPending ||
			earlierPending ||
			approvalRequests.isPending ||
			workApprovals.isPending ||
			(!config?.projectId && approvals.isPending),
		queueFailed:
			inbox.isError ||
			earlierFailed ||
			approvalRequests.isError ||
			workApprovals.isError ||
			(!config?.projectId && approvals.isError),
		pending:
			factories.pending ||
			learning.isPending ||
			inbox.isPending ||
			earlierPending ||
			approvalRequests.isPending ||
			workApprovals.isPending ||
			(!config?.projectId && approvals.isPending),
		failed:
			factories.failed ||
			learning.isError ||
			inbox.isError ||
			earlierFailed ||
			approvalRequests.isError ||
			workApprovals.isError ||
			(!config?.projectId && approvals.isError),
		more: Boolean(
			factories.more ||
			(earlierEnabled && (earlier.isPending || earlier.hasNextPage)) ||
			approvalRequests.data?.hasMore ||
			workApprovals.data?.hasMore ||
			(!config?.projectId && approvals.data?.pagination.hasMore),
		),
	};
}
