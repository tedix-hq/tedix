import { DecisionDeckConfigSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { useWorkApps } from "@/lib/use-work-apps";
import { useDeckCount } from "@/lib/use-deck-count";
import {
	isDecidableWorkApproval,
	WORK_COUNT_DEFINITIONS,
} from "@/lib/work-counts";
import { Badge } from "@/components/kumo/badge";

/** Shared Needs-you row predicates; the sidebar reads the canonical Deck count. */

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
	const metadata = row.request.metadata as
		| { schema?: string; outboundStatus?: string }
		| undefined;
	const reviewing =
		metadata?.schema === "tedix.outbound.v1" &&
		["reviewing", "feedback"].includes(metadata.outboundStatus ?? "");
	return (
		row.effectiveState === "open" &&
		!reviewing &&
		!isStatusUpdate(row.request.metadata)
	);
}

/** A request from your own agent session that waits on you. */
export function isRequestWaitingOnYou(row: {
	status: string;
	evidence?: string | null;
}): boolean {
	return (
		row.status === "waiting_on_user" &&
		!row.evidence?.startsWith("/work/interactions/")
	);
}

export function isPendingRuntimeApproval(row: { status: string }): boolean {
	return row.status === "pending";
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
	const { apps } = useWorkApps();
	const deck = apps.find((app) => app.role === "deck");
	const config = DecisionDeckConfigSchema.safeParse(deck?.manifest.config);
	const queue = useDeckCount(
		config.success ? config.data : undefined,
		deck?.gadget.workspaceId,
	);
	const count = queue.count;
	if (!config.success || queue.pending || queue.failed) return null;
	if (count === 0) return null;
	return (
		<Badge
			variant="warning"
			className="ml-auto tabular-nums group-data-[state=collapsed]/sidebar:hidden"
			aria-label={`Decisions waiting: ${count}${queue.more ? "+" : ""}`}
			title={WORK_COUNT_DEFINITIONS.decisions}
		>
			{count > 99 ? "99+" : `${count}${queue.more ? "+" : ""}`}
		</Badge>
	);
}
