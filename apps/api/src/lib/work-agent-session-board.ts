/**
 * Read-time derivation for the local agent session status board.
 *
 * Stored state is whatever the plugin last reported. A report can go stale
 * (the machine slept, the host crashed), so the board ages it into `idle`
 * instead of letting a forgotten "working" or "done" sit at the top forever,
 * and a session silent for 12 hours reads as `ended`: it stopped without a
 * final status.
 */

import type {
	WorkAgentSessionEffectiveStateSchema,
	WorkAgentSessionStateSchema,
} from "@tedix/api-contract/schemas/work-agent-sessions";
import type * as z from "zod";

type StoredState = z.infer<typeof WorkAgentSessionStateSchema>;
export type WorkAgentSessionEffectiveState = z.infer<
	typeof WorkAgentSessionEffectiveStateSchema
>;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** How long a reported state stays meaningful before it reads as `idle`. */
const STALE_AFTER_MS: Partial<Record<StoredState, number>> = {
	working: 30 * MINUTE_MS,
	done: 2 * HOUR_MS,
	needs_you: 24 * HOUR_MS,
	error: 24 * HOUR_MS,
};

/** A session with no update for this long has ended. */
const ENDED_AFTER_MS = 12 * HOUR_MS;

/** Board order, most urgent first. */
export const WORK_AGENT_SESSION_BOARD_ORDER = [
	"needs_you",
	"error",
	"done",
	"working",
	"idle",
	"ended",
] as const satisfies readonly WorkAgentSessionEffectiveState[];

export function deriveWorkAgentSessionEffectiveState(
	session: { state: StoredState; lastEventAt: string },
	now: string,
): WorkAgentSessionEffectiveState {
	const staleAfter = STALE_AFTER_MS[session.state];
	if (staleAfter === undefined) return session.state;
	const age = Date.parse(now) - Date.parse(session.lastEventAt);
	if (age > ENDED_AFTER_MS) return "ended";
	return age > staleAfter ? "idle" : session.state;
}

export interface WorkAgentSessionBoardEntry {
	state: StoredState;
	stateSince: string;
	lastEventAt: string;
}

/**
 * Attach `effectiveState`, sort by urgency, and count every board state.
 * `needs_you` waits longest first; every other group shows the newest first.
 */
export function buildWorkAgentSessionBoard<
	T extends WorkAgentSessionBoardEntry,
>(
	sessions: readonly T[],
	now: string,
): {
	sessions: Array<T & { effectiveState: WorkAgentSessionEffectiveState }>;
	counts: Record<WorkAgentSessionEffectiveState, number>;
} {
	const counts = Object.fromEntries(
		WORK_AGENT_SESSION_BOARD_ORDER.map((state) => [state, 0]),
	) as Record<WorkAgentSessionEffectiveState, number>;
	const rank = new Map<WorkAgentSessionEffectiveState, number>(
		WORK_AGENT_SESSION_BOARD_ORDER.map((state, index) => [state, index]),
	);
	const derived = sessions.map((session) => {
		const effectiveState = deriveWorkAgentSessionEffectiveState(session, now);
		counts[effectiveState] += 1;
		return { ...session, effectiveState };
	});
	derived.sort((a, b) => {
		const byRank =
			(rank.get(a.effectiveState) ?? 0) - (rank.get(b.effectiveState) ?? 0);
		if (byRank !== 0) return byRank;
		if (a.effectiveState === "needs_you") {
			return a.stateSince.localeCompare(b.stateSince);
		}
		return b.lastEventAt.localeCompare(a.lastEventAt);
	});
	return { sessions: derived, counts };
}

/** C0/C1 controls plus the Unicode line and paragraph separators. */
const CONTROL_CHARACTERS = new RegExp(
	`[${"\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029"}]`,
	"g",
);

/**
 * Plain one-line text: control characters become spaces and whitespace runs
 * collapse, so a hook cannot inject layout or terminal escapes into the board.
 */
export function sanitizeWorkAgentSessionText(
	value: string,
	maxLength: number,
): string {
	return value
		.replace(CONTROL_CHARACTERS, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, maxLength)
		.trim();
}

export interface WorkProjectContributor {
	sessionKey: string;
	harness: string;
	name: string;
	state: WorkAgentSessionEffectiveState | "unknown";
	summary: string;
	lastActivityAt: string;
	workItemId: string | null;
	workItemTitle: string | null;
	attempts: number;
}

interface ContributorReport {
	harness: string;
	sessionKey: string;
	label: string;
	state: StoredState;
	summary: string;
	workItemId: string | null;
	workItemTitle: string | null;
	lastEventAt: string;
}

interface ContributorAttempt {
	externalSessionKey: string;
	workItemId: string;
	workItemTitle: string;
	heartbeatAt: string;
}

/** A contributor silent this long has ended, whatever it last reported. */
const CONTRIBUTOR_ENDED_AFTER_MS = 24 * HOUR_MS;

const latest = (a: string, b: string) => (a.localeCompare(b) >= 0 ? a : b);

/**
 * One row per session that worked on a project, keyed `<harness>:<id>` like
 * Work Attempts. A session report supplies name, state and current item; a
 * session known only from Attempts reads `unknown` with its latest Attempt's
 * item. A live Attempt keeps heartbeating, so a session with no report or
 * heartbeat for 24 hours reads `ended` even if it last said `idle` or was
 * only ever seen through Attempts. Sessions that may still be active come
 * first, then newest activity.
 */
export function buildWorkProjectContributors(
	reports: readonly ContributorReport[],
	attempts: readonly ContributorAttempt[],
	now: string,
): WorkProjectContributor[] {
	const contributors = new Map<string, WorkProjectContributor>();
	for (const report of reports) {
		const sessionKey = `${report.harness}:${report.sessionKey}`;
		const current = contributors.get(sessionKey);
		// Two people cannot share a host session id; keep the newest report.
		if (current && current.lastActivityAt >= report.lastEventAt) continue;
		contributors.set(sessionKey, {
			sessionKey,
			harness: report.harness,
			name: report.label || sessionKey,
			state: deriveWorkAgentSessionEffectiveState(report, now),
			summary: report.summary,
			lastActivityAt: report.lastEventAt,
			workItemId: report.workItemId,
			workItemTitle: report.workItemTitle,
			attempts: 0,
		});
	}
	// Attempts arrive newest heartbeat first.
	for (const attempt of attempts) {
		const sessionKey = attempt.externalSessionKey;
		const current = contributors.get(sessionKey);
		if (current) {
			current.attempts += 1;
			current.lastActivityAt = latest(
				current.lastActivityAt,
				attempt.heartbeatAt,
			);
			if (!current.workItemId) {
				current.workItemId = attempt.workItemId;
				current.workItemTitle = attempt.workItemTitle;
			}
			continue;
		}
		contributors.set(sessionKey, {
			sessionKey,
			harness: sessionKey.split(":")[0] ?? "",
			name: sessionKey,
			state: "unknown",
			summary: "",
			lastActivityAt: attempt.heartbeatAt,
			workItemId: attempt.workItemId,
			workItemTitle: attempt.workItemTitle,
			attempts: 1,
		});
	}
	for (const contributor of contributors.values()) {
		if (
			Date.parse(now) - Date.parse(contributor.lastActivityAt) >
			CONTRIBUTOR_ENDED_AFTER_MS
		) {
			contributor.state = "ended";
		}
	}
	const settled = new Set(["ended", "unknown"]);
	return [...contributors.values()].sort((a, b) => {
		const bySettled =
			Number(settled.has(a.state)) - Number(settled.has(b.state));
		if (bySettled !== 0) return bySettled;
		return b.lastActivityAt.localeCompare(a.lastActivityAt);
	});
}
