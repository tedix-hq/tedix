/**
 * Sample agent sessions (/work/agents) and Office knocks, snoozes and
 * lessons (/work/office).
 */

import { LOCAL_OUTBOUND } from "../outbound-fixture";
import { fid, ORG_ID, RpcError, TEDI_MILES, TEDI_NOVA } from "./core";
import { WORK_ITEMS, workItemId } from "./work";

// --- Local agent session board (/work/agents) ---

type LocalAgentSessionState =
	| "needs_you"
	| "error"
	| "done"
	| "working"
	| "idle"
	| "ended";

/** One session per board state, aged relative to the request so times read live. */
const LOCAL_AGENT_SESSIONS: readonly {
	n: number;
	harness: "claude-code" | "codex";
	label: string;
	state: Exclude<LocalAgentSessionState, "idle">;
	effectiveState: LocalAgentSessionState;
	summary: string;
	minutesAgo: number;
	/** Fixture project number (`fid("76", n)`). */
	project?: number;
	/** Fixture Work Item number (`workItemId(n)`). */
	workItem?: number;
}[] = [
	{
		n: 1,
		harness: "claude-code",
		label: "tedix · agent-status",
		state: "needs_you",
		effectiveState: "needs_you",
		summary:
			"Waiting for approval to run the D1 migration against the local database before continuing with the board.",
		minutesAgo: 3,
		project: 1,
		workItem: 1,
	},
	{
		n: 2,
		harness: "codex",
		label: "acme-books · invoices",
		state: "needs_you",
		effectiveState: "needs_you",
		summary: "Asked which tax regime applies to the imported supplier.",
		minutesAgo: 12,
	},
	{
		n: 3,
		harness: "claude-code",
		label: "tedix · runtime-retry",
		state: "error",
		effectiveState: "error",
		summary: "Type-check failed in apps/tedi-runtime after the retry refactor.",
		minutesAgo: 7,
		project: 1,
	},
	{
		n: 4,
		harness: "codex",
		label: "landing · hero-copy",
		state: "done",
		effectiveState: "done",
		summary: "Rewrote the hero copy and pushed to main.",
		minutesAgo: 18,
		project: 2,
		workItem: 5,
	},
	{
		n: 5,
		harness: "claude-code",
		label: "tedix · mcp-scopes",
		state: "working",
		effectiveState: "working",
		summary: "Running the MCP conformance suite.",
		minutesAgo: 1,
		project: 1,
		workItem: 7,
	},
	{
		n: 6,
		harness: "codex",
		label: "tedix · docs-public",
		state: "working",
		effectiveState: "working",
		summary: "Updating release-status for the new board.",
		minutesAgo: 4,
	},
	{
		n: 7,
		harness: "claude-code",
		label: "cms · theme-parity",
		state: "done",
		effectiveState: "idle",
		summary: "Finished the theme token audit.",
		minutesAgo: 190,
		project: 1,
	},
	{
		n: 8,
		harness: "codex",
		label: "tedix · old-spike",
		state: "ended",
		effectiveState: "ended",
		summary: "Session closed.",
		minutesAgo: 600,
		project: 1,
		workItem: 4,
	},
];

export function localAgentSessions(includeEnded: boolean | undefined) {
	const at = (minutesAgo: number) =>
		new Date(Date.now() - minutesAgo * 60_000).toISOString();
	const sessions = LOCAL_AGENT_SESSIONS.filter(
		(row) => includeEnded || row.effectiveState !== "ended",
	).map((row) => ({
		id: fid("a6", row.n),
		harness: row.harness,
		sessionKey: `local-session-${row.n}`,
		label: row.label,
		state: row.state,
		effectiveState: row.effectiveState,
		summary: row.summary,
		projectId: row.project ? fid("76", row.project) : null,
		workItemId: row.workItem ? workItemId(row.workItem) : null,
		stateSince: at(row.minutesAgo),
		lastEventAt: at(row.minutesAgo),
	}));
	const counts: Record<LocalAgentSessionState, number> = {
		needs_you: 0,
		error: 0,
		done: 0,
		working: 0,
		idle: 0,
		ended: 0,
	};
	for (const row of sessions) counts[row.effectiveState] += 1;
	return { sessions, counts };
}

/** Contributor attempt counts per fixture session; one attempt-only session has no report. */
const LOCAL_CONTRIBUTOR_ATTEMPTS: Readonly<Record<number, number>> = {
	1: 2,
	5: 1,
	8: 3,
};

export function localProjectContributors(projectId: string) {
	const at = (minutesAgo: number) =>
		new Date(Date.now() - minutesAgo * 60_000).toISOString();
	const titleOf = (n: number | undefined) =>
		n
			? (WORK_ITEMS.find((item) => item.id === workItemId(n))?.title ?? null)
			: null;
	const active = new Set(["needs_you", "error", "working"]);
	const reported = LOCAL_AGENT_SESSIONS.filter(
		(row) => row.project && fid("76", row.project) === projectId,
	).map((row) => ({
		sessionKey: `${row.harness}:local-session-${row.n}`,
		harness: row.harness,
		name: row.label,
		state: row.effectiveState as string,
		summary: row.summary,
		lastActivityAt: at(row.minutesAgo),
		workItemId: row.workItem ? workItemId(row.workItem) : null,
		workItemTitle: titleOf(row.workItem),
		attempts: LOCAL_CONTRIBUTOR_ATTEMPTS[row.n] ?? 0,
	}));
	const attemptOnly =
		projectId === fid("76", 1)
			? [
					{
						sessionKey: "codex:local-session-attempt-only",
						harness: "codex",
						name: "codex:local-session-attempt-only",
						state: "unknown",
						summary: "",
						lastActivityAt: at(60 * 30),
						workItemId: workItemId(6),
						workItemTitle: titleOf(6),
						attempts: 1,
					},
				]
			: [];
	const contributors = [...reported, ...attemptOnly].sort(
		(a, b) =>
			Number(active.has(b.state)) - Number(active.has(a.state)) ||
			b.lastActivityAt.localeCompare(a.lastActivityAt),
	);
	return { contributors };
}

// --- Office (/work/office): knocks, auto-sent replies and the notebook ---

/** Agent turns that knocked today, aged relative to the request. */
export const LOCAL_KNOCKS: readonly {
	n: number;
	subject: string;
	host: "claude-code" | "codex";
	repository: string;
	urgency: "now" | "later";
	state: "open" | "resolved";
	minutesAgo: number;
	draft: "auto" | "review" | null;
	drafter: string;
	/** Negative values are already overdue. */
	dueInMinutes?: number;
	outbound?: boolean;
}[] = [
	{
		n: 1,
		subject: "Tests pass. Push the retry fix to main?",
		host: "claude-code",
		repository: "acme/books",
		urgency: "later",
		state: "open",
		minutesAgo: 2,
		draft: "auto",
		drafter: TEDI_NOVA,
	},
	{
		n: 2,
		subject: "The production database migration drops a column. Run it now?",
		host: "codex",
		repository: "acme/books",
		urgency: "now",
		state: "open",
		minutesAgo: 9,
		draft: null,
		drafter: TEDI_NOVA,
	},
	{
		n: 3,
		subject: "Hero copy rewritten in plain English. Ship it?",
		host: "claude-code",
		repository: "acme/landing",
		urgency: "later",
		state: "open",
		minutesAgo: 21,
		draft: "auto",
		drafter: TEDI_MILES,
	},
	{
		n: 4,
		subject: "Which pricing tier should the new plan default to?",
		host: "codex",
		repository: "acme/landing",
		urgency: "later",
		state: "open",
		minutesAgo: 47,
		draft: "review",
		drafter: TEDI_MILES,
		dueInMinutes: -180,
	},
	{
		n: 5,
		subject: "Done with the invoice export. Anything else?",
		host: "claude-code",
		repository: "acme/books",
		urgency: "later",
		state: "resolved",
		minutesAgo: 95,
		draft: null,
		drafter: TEDI_NOVA,
	},
	{
		n: 6,
		subject: "Reply to Dana about the revised delivery date",
		host: "codex",
		repository: "acme/books",
		urgency: "later",
		state: "open",
		minutesAgo: 30 * 60,
		draft: null,
		drafter: TEDI_MILES,
		outbound: true,
	},
];

function localKnockRequest(knock: (typeof LOCAL_KNOCKS)[number]) {
	const at = new Date(Date.now() - knock.minutesAgo * 60_000).toISOString();
	return {
		id: fid("a7", knock.n),
		orgId: ORG_ID,
		workItemId: null,
		caseId: null,
		projectId: null,
		kind: "question" as const,
		subject: knock.subject,
		prompt: knock.subject,
		requestedFromType: "user" as const,
		requestedFromId: "dev-operator",
		creatorType: "user" as const,
		creatorId: "dev-operator",
		creatorSessionId: null,
		state: knock.state,
		requestedAt: at,
		dueAt:
			knock.dueInMinutes === undefined
				? null
				: new Date(Date.now() + knock.dueInMinutes * 60_000).toISOString(),
		expiresAt: null,
		resolvedAt: knock.state === "resolved" ? at : null,
		version: 1,
		metadata: knock.outbound
			? {
					schema: "tedix.outbound.v1",
					outboundStatus: "waiting_on_you",
					outboundWorkItemId: LOCAL_OUTBOUND.workItemId,
				}
			: {
					schema: "tedix.decision-capture.v1",
					host: knock.host,
					sessionId: fid("a8", knock.n),
					repository: knock.repository,
					triage: { urgency: knock.urgency },
				},
	};
}

export const localSnoozes = new Map<string, string>();
// Questions handed to the steward tedi leave the person's inbox.
export const localStewardRoutes = new Set<string>();

export function localKnockRow(knock: (typeof LOCAL_KNOCKS)[number]) {
	return {
		request: localKnockRequest(knock),
		effectiveState: knock.state,
		canRespond: knock.state === "open",
		canCancel: false,
		workItem: null,
		responseCount: knock.state === "resolved" ? 1 : 0,
	};
}

export function localKnockDetail(requestId: string) {
	const knock = LOCAL_KNOCKS.find((row) => fid("a7", row.n) === requestId);
	if (!knock) throw new RpcError("NOT_FOUND", "Interaction not found");
	const row = localKnockRow(knock);
	return {
		request: row.request,
		effectiveState: row.effectiveState,
		canRespond: row.canRespond,
		canCancel: false,
		latestDraft: knock.draft
			? {
					id: fid("a9", knock.n),
					body: "Yes, go ahead.",
					rationale: "Reversible and matches how you answered last time.",
					drafterId: knock.drafter,
					drafterName: null,
					createdAt: row.request.requestedAt,
					turnType: "ship",
					delivery: knock.draft,
				}
			: null,
		responses: { data: [], nextCursor: null, hasMore: false },
	};
}

export const LOCAL_LESSONS = [
	{
		n: 1,
		text: "Answer in plain English and keep it short; no IDs in the reply.",
		addedMinutesAgo: 30,
		replies: 1,
	},
	{
		n: 2,
		text: "Commit and push to main once checks pass; never open a pull request.",
		addedMinutesAgo: 60 * 26,
		replies: 4,
	},
	{
		n: 3,
		text: "Prefer the simple version first; ask before adding a feature flag.",
		addedMinutesAgo: 60 * 24 * 5,
		replies: 0,
	},
] as const;
