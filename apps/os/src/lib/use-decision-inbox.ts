import { workRefreshOptions } from "@/lib/work-refresh";
import { cardIsDue, cardScheduleDates } from "@/lib/card-schedule";
import { useCardSchedule } from "@/lib/use-card-schedule";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import {
	decisionNeedsPerson,
	type DecisionDeckConfig,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { osQuery, pendingApprovalsQueryOptions } from "@/lib/os-query-options";
import {
	isOpenRequestForYou,
	isDecidableWorkApproval,
} from "@/components/work-needs-you-count";
import { decisionEnvelope, decisionIsDue } from "@/lib/decision-deck";
import { useFactoryCardCount } from "@/lib/use-factory-card-count";

/** The header and Deck use the same recipient checks, project scope and bounded pages. */
export function useDecisionInbox(config?: DecisionDeckConfig) {
	const { now, timeZone } = useCardSchedule();
	const factories = useFactoryCardCount(config?.factorySources ?? []);
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
	const requests = [
		...new Map(
			[
				...(inbox.data?.data ?? []),
				...(earlierEnabled
					? (earlier.data?.pages.flatMap((page) => page.data) ?? [])
					: []),
				...(approvalRequests.data?.data ?? []),
			].map((row) => [row.request.id, row]),
		).values(),
	].filter((row) => {
		const decision = decisionEnvelope(row.request.metadata);
		return (
			isOpenRequestForYou(row) &&
			decisionIsDue(row.request, now, timeZone) &&
			row.canRespond &&
			(!decision || decisionNeedsPerson(decision))
		);
	});
	const work = (workApprovals.data?.data ?? []).filter(
		(row) =>
			isDecidableWorkApproval(row) && cardIsDue(row.proposal, now, timeZone),
	);
	const runtime = !config?.projectId
		? (approvals.data?.data ?? []).filter(
				(row) => row.status === "pending" && cardIsDue(row, now, timeZone),
			)
		: [];
	return {
		inbox,
		refetch: () =>
			Promise.all([
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
		scheduledIds: new Set(
			requests
				.filter((row) => cardScheduleDates(row.request).length > 0)
				.map((row) => row.request.id),
		),
		work,
		factoryPending: factories.pending,
		factoryCards: factories.cards,
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
			inbox.isPending ||
			earlierPending ||
			approvalRequests.isPending ||
			workApprovals.isPending ||
			(!config?.projectId && approvals.isPending),
		failed:
			factories.failed ||
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
