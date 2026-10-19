import { interactionCardKind } from "@/lib/interaction-card-kind";
import { workRefreshOptions } from "@/lib/work-refresh";
import { cardIsDue, cardScheduleDates } from "@/lib/card-schedule";
import { useCardSchedule } from "@/lib/use-card-schedule";
import {
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect } from "react";
import {
	classifyDeckCard,
	type DecisionDeckConfig,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { osQuery, pendingApprovalsQueryOptions } from "@/lib/os-query-options";
import {
	isOpenRequestForYou,
	isDecidableWorkApproval,
} from "@/components/work-needs-you-count";
import { decisionEnvelope, decisionIsDue } from "@/lib/decision-deck";
import { useFactoryCardCount } from "@/lib/use-factory-card-count";
import { useDeckRoutingAudit } from "@/lib/use-deck-routing-audit";
import { osApi } from "@/lib/api";

/** The header and Deck use the same recipient checks, project scope and bounded pages. */
export function useDecisionInbox(config?: DecisionDeckConfig) {
	const { now, timeZone } = useCardSchedule();
	const client = useQueryClient();
	const learning = useQuery({
		...osQuery.learningFeedback.model.queryOptions({ input: {} }),
		enabled: Boolean(config),
	});
	const enabled = Boolean(config);
	const projectId = config?.projectId;
	useEffect(() => {
		if (!enabled) return;
		let active = true;
		const refresh = async () => {
			try {
				const result = await osApi.workInteractions.refreshDecisionSources({
					projectId,
				});
				if (active && result.created)
					await client.invalidateQueries({
						queryKey: osQuery.workInteractions.listInbox.key(),
					});
			} catch {
				/* A source failure must not discard the existing inbox. */
			}
		};
		void refresh();
		const timer = setInterval(() => void refresh(), 120000);
		return () => {
			active = false;
			clearInterval(timer);
		};
	}, [enabled, projectId, client]);

	const factories = useFactoryCardCount(
		config?.factorySources ?? [],
		config?.routing,
		learning.data,
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
	].filter(
		(row) =>
			isOpenRequestForYou(row) &&
			decisionIsDue(row.request, now, timeZone) &&
			row.canRespond,
	);
	const routedRequests = candidates.map((row) => {
		const decision = decisionEnvelope(row.request.metadata);
		const kind = decision?.kind ?? interactionCardKind(row.request);
		const classId =
			decision?.classId ??
			String(row.request.metadata.decisionClass ?? row.request.kind);
		const learnedUsefulness = learning.data?.config.enabled
			? learning.data.weights.usefulness.find(
					(weight) => weight.key === `class:${classId}`,
				)
			: undefined;
		return {
			id: row.request.id,
			row,
			...classifyDeckCard(
				{
					kind,
					classId,
					learnedUsefulness,
					action: decision
						? undefined
						: String(
								row.request.metadata.approvalOperation ??
									`${row.request.subject ?? ""}\n${row.request.prompt}`,
							),
					risk:
						typeof row.request.metadata.riskLevel === "string"
							? row.request.metadata.riskLevel
							: undefined,
					protectedEffects:
						decision?.protectedEffects ??
						(kind === "outbound"
							? ["message"]
							: row.request.metadata.localImport
								? ["consent"]
								: []),
					tasteOrStrategy: decision?.tasteOrStrategy,
					needsPerson: true,
					dueAt: row.request.dueAt,
				},
				config?.routing,
				now,
			),
		};
	});
	const routedWork = (workApprovals.data?.data ?? [])
		.filter(
			(row) =>
				isDecidableWorkApproval(row) && cardIsDue(row.proposal, now, timeZone),
		)
		.map((row) => ({
			id: `work-approval:${row.proposal.id}`,
			row,
			...classifyDeckCard(
				{
					kind: "approval",
					classId: `approval.${row.proposal.authorityKey}`,
					action: row.proposal.authorityKey,
					risk: row.workItem.riskLevel,
					needsPerson: true,
				},
				config?.routing,
				now,
			),
		}));
	const routedRuntime = (!config?.projectId ? (approvals.data?.data ?? []) : [])
		.filter((row) => row.status === "pending" && cardIsDue(row, now, timeZone))
		.map((row) => ({
			id: `approval:${row.id}`,
			row,
			...classifyDeckCard(
				{
					kind: "approval",
					classId: `approval.${row.actionType}`,
					action: `${row.actionType} ${String(row.payload.toolName ?? row.payload.toolId ?? "")}`,
					risk:
						typeof row.payload.riskLevel === "string"
							? row.payload.riskLevel
							: undefined,
					needsPerson: true,
					protectedEffects:
						row.review.intent === "browser_takeover" ? ["consent"] : [],
				},
				config?.routing,
				now,
			),
		}));
	useDeckRoutingAudit([...routedRequests, ...routedWork, ...routedRuntime]);
	const requests = routedRequests
		.filter((item) => item.destination === "deck")
		.map((item) => item.row);
	const work = routedWork
		.filter((item) => item.destination === "deck")
		.map((item) => item.row);
	const runtime = routedRuntime
		.filter((item) => item.destination === "deck")
		.map((item) => item.row);
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
		criticalIds: new Set(
			[...routedRequests, ...routedWork, ...routedRuntime]
				.filter((row) => row.reason === "critical")
				.map((row) => row.id),
		),
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
