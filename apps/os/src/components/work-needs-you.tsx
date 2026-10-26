import { isDecidableWorkApproval } from "@/lib/work-counts";
import type { FactoryScoreboardEntry } from "@tedix/api-contract/contracts/projects";
import type { ApprovalRequest } from "@tedix/api-contract/contracts/tedi-approvals";
import type { WorkFleetControlTower } from "@tedix/api-contract/schemas/work-fleet";
import {
	isBlockedWorkYouOwn,
	isBrokenFactory,
	isOpenRequestForYou,
	isPendingRuntimeApproval,
	isRequestWaitingOnYou,
} from "@/components/work-needs-you-count";
import {
	type SessionRequest,
	sessionRequestSource,
} from "@/components/work-session-requests";
import { officeAsk } from "@/lib/work-interaction-display";
import { factoryHref } from "@/lib/work-display";
import { normalizeD1Timestamp } from "@/lib/time";

type InboxRow = {
	request: {
		id: string;
		version: number;
		kind: "question" | "input" | "handoff" | "coordination";
		subject: string;
		prompt?: string;
		metadata?: unknown;
		requestedAt: string;
	};
	effectiveState: string;
	canRespond: boolean;
	workItem: { id?: string; title: string } | null;
	askedBy?: string;
	references?: ReadonlyArray<{ shortId: string; title: string }>;
};

type WorkApprovalRow = {
	proposal: { id: string; requestedAt: string; requestRationale: string };
	effectiveStatus: string;
	canDecide: boolean;
	workItem: { id: string; title: string };
};

type RuntimeApprovalRow = Pick<
	ApprovalRequest,
	"id" | "description" | "createdAt" | "status"
> & {
	review: { decisionMode: string; operatorQuestion?: string | null };
};

type ReadinessRow = {
	workItem: {
		id: string;
		title: string;
		accountableOwnerType: string | null;
		accountableOwnerId: string | null;
		updatedAt: string | null;
		createdAt: string;
	};
	readiness: { state: string; reasons: Array<{ detail: string }> };
};

type FactoryRow = Pick<
	FactoryScoreboardEntry,
	"kind" | "id" | "name" | "verdict" | "verdictReason" | "lastRunAt"
>;

type FleetAttention = Pick<WorkFleetControlTower, "attention">["attention"];

export type NeedsYouAction =
	| { type: "link"; label: string; href: string }
	| { type: "approve"; approvalId: string }
	| { type: "handoff"; requestId: string; version: number }
	| { type: "lane"; requestId: string; version: number };

export type NeedsYouKind =
	| "Outbound"
	| "Approval"
	| "Question"
	| "Proposal"
	| "Request"
	| "Blocked"
	| "Factory"
	| "Organization";

export type NeedsYouItem = {
	key: string;
	kind: NeedsYouKind;
	label: string;
	href: string;
	/** Who asked, in plain words. */
	askedBy?: string;
	/** One line on why it needs you. */
	detail?: string;
	/** What the row's buttons do. */
	hint?: string;
	at?: string;
	count?: number;
	action: NeedsYouAction;
};

/**
 * Organization pressure that has no personal row of its own. Pending
 * decisions and open requests are left out: the ones addressed to you are
 * already rows, and the organization-wide queues stay under More.
 */
const ORGANIZATION_COPY: Partial<
	Record<
		FleetAttention["actions"][number]["key"],
		{ label: string; detail: string; href?: string }
	>
> = {
	exhausted_budgets: {
		label: "Budgets used up",
		detail: "Check the affected work before changing a limit.",
		href: "/work/capacity?view=budgets&exhausted=true",
	},
	saturated_resources: {
		label: "Resources in use",
		detail: "Check who holds them before starting overlapping work.",
		href: "/work/capacity?saturated=true",
	},
	stale_attempt_leases: {
		label: "Work with missed updates",
		detail: "These runs stopped renewing their reservations.",
		href: "/work/attempts?view=active",
	},
	rejected_admissions: {
		label: "Work that could not start",
		detail: "Check the recorded reason before trying again.",
	},
	overdue_interactions: {
		label: "Overdue requests",
		detail: "Open requests past their due date. Check who can respond.",
		href: "/work/interactions?view=audit&state=open",
	},
};

const newestFirst = (a: NeedsYouItem, b: NeedsYouItem) =>
	(b.at ?? "").localeCompare(a.at ?? "");

function metadataOf(request: { metadata?: unknown }): Record<string, unknown> {
	return typeof request.metadata === "object" && request.metadata !== null
		? (request.metadata as Record<string, unknown>)
		: {};
}

function laneHandoffOf(request: { metadata?: unknown }) {
	const metadata = metadataOf(request);
	const follow = metadata.followThrough;
	const lane =
		metadata.laneHandoff ??
		(follow && typeof follow === "object" && "laneHandoff" in follow
			? follow.laneHandoff
			: undefined);
	return lane && typeof lane === "object"
		? (lane as Record<string, unknown>)
		: null;
}

/** Shows quoted Work Item short ids as their titles. */
function withTitles(text: string, row: InboxRow): string {
	const titles = new Map(
		(row.references ?? []).map((ref) => [ref.shortId, ref.title]),
	);
	return text.replace(/\b[0-9a-f]{8}\b/gi, (shortId) => {
		const id = shortId.toLowerCase();
		const title =
			titles.get(id) ??
			(row.workItem?.id?.startsWith(id) ? row.workItem.title : undefined);
		return title ? `“${title}”` : shortId;
	});
}

/** Why the request needs you: its stated reason, else its Work Item. */
function interactionWhy(row: InboxRow, label: string): string | undefined {
	const lane = laneHandoffOf(row.request);
	if (typeof lane?.summary === "string") return lane.summary;
	const metadata = metadataOf(row.request);
	if (typeof metadata.reason === "string" && metadata.reason.trim())
		return metadata.reason.trim();
	const lines = (row.request.prompt ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const why = lines.find((line) => /^Why:\s/.test(line));
	if (why) return why.replace(/^Why:\s*/, "");
	if (row.workItem) return `For Work item “${row.workItem.title}”`;
	const first = lines[0];
	return first && first !== label ? first : undefined;
}

const PROPOSAL_ACCEPT: Record<string, string> = {
	delegate: "Accept: a tedi starts on it; nothing is sent without you.",
	doc: "Accept: a tedi drafts it in your space; nothing is sent without you.",
	factory: "Accept: Tedix plans a factory; it runs only once you switch it on.",
};

/** "A tedi" → "the tedi", "Codex session" → "the Codex session". */
function toWhom(askedBy: string): string {
	if (/^an? /i.test(askedBy)) return askedBy.replace(/^an? /i, "the ");
	return /session$/.test(askedBy) ? `the ${askedBy}` : askedBy;
}

/** "You" → "you", "An agent session" → "an agent session"; names stay. */

function interactionHint(row: InboxRow, kind: NeedsYouKind): string {
	if (!row.canRespond) return "Open: see the request.";
	if (row.request.kind === "handoff") {
		const proposal = metadataOf(row.request).proposal as
			| { start?: { kind?: string } }
			| undefined;
		if (!proposal)
			return "Accept: you take this over. Decline: it goes back to the sender.";
		const accept =
			PROPOSAL_ACCEPT[proposal.start?.kind ?? ""] ??
			"Accept: it becomes a Work item; nothing starts yet.";
		return `${accept} Decline: nothing starts, and it is not proposed again.`;
	}
	if (kind === "Question")
		return row.askedBy && row.askedBy !== "You"
			? `Answer: write a reply; it goes back to ${toWhom(row.askedBy)}.`
			: "Answer: write a reply; it is saved on the request.";
	return "Open: read the request and reply there.";
}

function interactionItem(row: InboxRow): NeedsYouItem | null {
	// A captured status update asks nothing of you; the Office shows it.
	if (!isOpenRequestForYou(row)) return null;
	const { request } = row;
	if (metadataOf(request).schema === "tedix.outbound.v1")
		return {
			key: `interaction:${request.id}`,
			kind: "Outbound",
			label: request.subject,
			href: `/work/interactions/${request.id}`,
			askedBy: row.askedBy,
			hint: "Review the draft and your tedi's notes, then approve or give feedback.",
			at: request.requestedAt,
			action: {
				type: "link",
				label: "Review",
				href: `/work/interactions/${request.id}`,
			},
		};
	const href = `/work/interactions/${request.id}`;
	const kind: NeedsYouKind =
		request.kind === "handoff"
			? "Proposal"
			: request.kind === "coordination"
				? "Request"
				: "Question";
	const lane = laneHandoffOf(request);
	const action: NeedsYouAction =
		lane && row.canRespond
			? { type: "lane", requestId: request.id, version: request.version }
			: request.kind === "handoff" && row.canRespond
				? { type: "handoff", requestId: request.id, version: request.version }
				: {
						type: "link",
						label: row.canRespond && kind === "Question" ? "Answer" : "Open",
						href,
					};
	const label = withTitles(officeAsk(request), row);
	const why = interactionWhy(row, label);
	return {
		key: `interaction:${request.id}`,
		kind,
		label,
		href,
		askedBy: row.askedBy,
		detail: why ? withTitles(why, row) : undefined,
		hint:
			typeof lane?.nextClick === "string"
				? `Next click: ${lane.nextClick}`
				: interactionHint(row, kind),
		at: request.requestedAt,
		action,
	};
}

/**
 * Everything that waits for the viewer, in one list: approvals, requests
 * addressed to them (onboarding proposals included), failing factories, Work
 * they own that is blocked, then organization pressure. Each row carries its
 * one primary action.
 */
export function needsYouItems(input: {
	interactions?: readonly InboxRow[];
	workApprovals?: readonly WorkApprovalRow[];
	runtimeApprovals?: readonly RuntimeApprovalRow[];
	factories?: readonly FactoryRow[];
	readiness?: readonly ReadinessRow[];
	viewerId?: string | null;
	attention?: FleetAttention | null;
	sessionRequests?: readonly SessionRequest[];
}): NeedsYouItem[] {
	const approvals: NeedsYouItem[] = [
		...(input.runtimeApprovals ?? [])
			.filter(isPendingRuntimeApproval)
			.map((row): NeedsYouItem => ({
				key: `runtime-approval:${row.id}`,
				kind: "Approval",
				label: row.description,
				href: "/work/approvals",
				askedBy: "A tedi",
				detail: row.review.operatorQuestion ?? undefined,
				hint:
					row.review.decisionMode === "approve_or_reject"
						? "Approve: the paused tedi run goes ahead. To reject, open Approvals."
						: "Review: see what the tedi wants to do, then decide on Approvals.",
				at: row.createdAt,
				action:
					row.review.decisionMode === "approve_or_reject"
						? { type: "approve", approvalId: row.id }
						: { type: "link", label: "Review", href: "/work/approvals" },
			})),
		...(input.workApprovals ?? [])
			.filter(isDecidableWorkApproval)
			.map((row): NeedsYouItem => ({
				key: `work-approval:${row.proposal.id}`,
				kind: "Approval",
				label: row.workItem.title,
				href: `/work/items/${row.workItem.id}`,
				askedBy: "Tedix",
				detail: row.proposal.requestRationale,
				hint: "Approve: opens Approvals, where you approve or reject it with a short reason.",
				at: row.proposal.requestedAt,
				// Deciding Work needs a written rationale, which the Approvals page takes.
				action: { type: "link", label: "Approve", href: "/work/approvals" },
			})),
	].sort(newestFirst);
	const requests = [
		...(input.interactions ?? [])
			.map(interactionItem)
			.filter((item): item is NeedsYouItem => item !== null),
		...(input.sessionRequests ?? [])
			.filter(isRequestWaitingOnYou)
			.map((row): NeedsYouItem => ({
				key: `session-request:${row.id}`,
				kind: "Request",
				label: row.text,
				href: "#your-requests",
				askedBy: "An agent session",
				detail: [sessionRequestSource(row), row.evidence]
					.filter(Boolean)
					.join(" · "),
				hint: "Reply in that session; it moves on once you answer.",
				at: row.statusChangedAt,
				action: { type: "link", label: "Open", href: "#your-requests" },
			})),
	].sort(newestFirst);
	const factories = (input.factories ?? [])
		.filter(isBrokenFactory)
		.map((row): NeedsYouItem => ({
			key: `factory:${row.kind}:${row.id}`,
			kind: "Factory",
			label: `${row.name} ${row.verdict === "failing" ? "is failing" : "is not firing"}`,
			href: factoryHref(row),
			askedBy: "Tedix",
			detail: row.verdictReason ?? undefined,
			hint: "Open: see the factory's recent runs.",
			at: row.lastRunAt ? normalizeD1Timestamp(row.lastRunAt) : undefined,
			action: { type: "link", label: "Open", href: factoryHref(row) },
		}));
	const blocked = (input.readiness ?? [])
		.filter((row) => isBlockedWorkYouOwn(row, input.viewerId))
		.map(({ workItem, readiness }): NeedsYouItem => ({
			key: `blocked:${workItem.id}`,
			kind: "Blocked",
			label: workItem.title,
			href: `/work/items/${workItem.id}`,
			askedBy: "Tedix",
			detail: readiness.reasons[0]?.detail,
			hint: "Open: see what blocks this Work you own.",
			at: workItem.updatedAt ?? workItem.createdAt,
			action: {
				type: "link",
				label: "Open",
				href: `/work/items/${workItem.id}`,
			},
		}));
	const organization = (input.attention?.actions ?? []).flatMap(
		(action): NeedsYouItem[] => {
			const copy = ORGANIZATION_COPY[action.key];
			if (!copy) return [];
			const href = copy.href ?? action.href;
			return [
				{
					key: `organization:${action.key}`,
					kind: "Organization",
					label: copy.label,
					href,
					askedBy: "Tedix",
					detail: copy.detail,
					hint: "Open: see the affected Work.",
					count: action.count,
					action: { type: "link", label: "Open", href },
				},
			];
		},
	);
	return [...approvals, ...requests, ...blocked, ...factories, ...organization];
}

/** Rows that are yours to act on; organization pressure is not counted. */
export function needsYouCount(items: readonly NeedsYouItem[]): number {
	return items.filter((item) => item.kind !== "Organization").length;
}
