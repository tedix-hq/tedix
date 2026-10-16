import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/kumo/badge";
import {
	agentSessionRequestsQueryOptions,
	factoryScoreboardQueryOptions,
	pendingApprovalsQueryOptions,
	userProfileQueryOptions,
	workNeedsYouInteractionsQueryOptions,
	workPendingApprovalsQueryOptions,
	workReadinessProjectionQueryOptions,
} from "@/lib/os-query-options";

/*
 * What belongs in Work › Needs you, kept apart from the page so the sidebar
 * count loads without the Work page modules. The page builds its rows from
 * these same predicates, so the count and the list cannot disagree.
 */

const DECISION_CAPTURE_SCHEMA = "tedix.decision-capture.v1";

const BLOCKED_STATES = new Set([
	"purpose_blocked",
	"dependencies_blocked",
	"capability_blocked",
	"approval_blocked",
	"budget_blocked",
	"resource_blocked",
]);

/** A captured status update (`attention.kind` fyi) asks nothing of you. */
function isStatusUpdate(metadata: unknown): boolean {
	if (typeof metadata !== "object" || metadata === null) return false;
	const value = metadata as {
		schema?: unknown;
		attention?: { kind?: unknown } | null;
	};
	return (
		value.schema === DECISION_CAPTURE_SCHEMA && value.attention?.kind === "fyi"
	);
}

export function isOpenRequestForYou(row: {
	effectiveState: string;
	request: { metadata?: unknown };
}): boolean {
	return row.effectiveState === "open" && !isStatusUpdate(row.request.metadata);
}

/** A request from your own agent session that waits on you. */
export function isRequestWaitingOnYou(row: { status: string }): boolean {
	return row.status === "waiting_on_user";
}

export function isPendingRuntimeApproval(row: { status: string }): boolean {
	return row.status === "pending";
}

export function isDecidableWorkApproval(row: {
	effectiveStatus: string;
	canDecide: boolean;
}): boolean {
	return row.effectiveStatus === "pending" && row.canDecide;
}

export function isBrokenFactory(row: { verdict: string | null }): boolean {
	return row.verdict === "failing" || row.verdict === "not_firing";
}

export function isBlockedWorkYouOwn(
	row: {
		workItem: {
			accountableOwnerType: string | null;
			accountableOwnerId: string | null;
		};
		readiness: { state: string };
	},
	viewerId: string | null | undefined,
): boolean {
	return (
		Boolean(viewerId) &&
		BLOCKED_STATES.has(row.readiness.state) &&
		row.workItem.accountableOwnerType === "user" &&
		row.workItem.accountableOwnerId === viewerId
	);
}

/**
 * The personal sources of Needs you. Every read is a contract-derived key the
 * source pages share, so a decision made anywhere refreshes the list and the
 * count together.
 */
export function useNeedsYouSources() {
	const interactions = useQuery(workNeedsYouInteractionsQueryOptions());
	const workApprovals = useQuery({
		...workPendingApprovalsQueryOptions(),
		retry: false,
	});
	const runtimeApprovals = useQuery(pendingApprovalsQueryOptions());
	const factories = useQuery(factoryScoreboardQueryOptions());
	const readiness = useQuery(workReadinessProjectionQueryOptions());
	const profile = useQuery(userProfileQueryOptions());
	const sessionRequests = useQuery({
		...agentSessionRequestsQueryOptions(),
		retry: false,
	});
	return {
		interactions,
		workApprovals,
		runtimeApprovals,
		factories,
		readiness,
		profile,
		sessionRequests,
	};
}

export type NeedsYouSources = ReturnType<typeof useNeedsYouSources>;

/** How many rows of Needs you are yours to act on. */
export function needsYouSourceCount(sources: {
	interactions?: readonly Parameters<typeof isOpenRequestForYou>[0][];
	workApprovals?: readonly Parameters<typeof isDecidableWorkApproval>[0][];
	runtimeApprovals?: readonly Parameters<typeof isPendingRuntimeApproval>[0][];
	factories?: readonly Parameters<typeof isBrokenFactory>[0][];
	readiness?: readonly Parameters<typeof isBlockedWorkYouOwn>[0][];
	viewerId?: string | null;
	sessionRequests?: readonly Parameters<typeof isRequestWaitingOnYou>[0][];
}): number {
	return (
		(sources.sessionRequests ?? []).filter(isRequestWaitingOnYou).length +
		(sources.interactions ?? []).filter(isOpenRequestForYou).length +
		(sources.workApprovals ?? []).filter(isDecidableWorkApproval).length +
		(sources.runtimeApprovals ?? []).filter(isPendingRuntimeApproval).length +
		(sources.factories ?? []).filter(isBrokenFactory).length +
		(sources.readiness ?? []).filter((row) =>
			isBlockedWorkYouOwn(row, sources.viewerId),
		).length
	);
}

/** The sidebar badge next to Work. */
export function WorkNeedsYouCount() {
	const sources = useNeedsYouSources();
	const count = needsYouSourceCount({
		interactions: sources.interactions.data?.data,
		workApprovals: sources.workApprovals.data?.data,
		runtimeApprovals: sources.runtimeApprovals.data?.data,
		factories: sources.factories.data?.data,
		readiness: sources.readiness.data?.data,
		viewerId: sources.profile.data?.id,
		sessionRequests: sources.sessionRequests.data?.data,
	});
	if (count === 0) return null;
	return (
		<Badge
			variant="warning"
			className="ml-auto tabular-nums group-data-[state=collapsed]/sidebar:hidden"
			aria-label={`Needs you: ${count}`}
			title="Needs you"
		>
			{count > 99 ? "99+" : count}
		</Badge>
	);
}
