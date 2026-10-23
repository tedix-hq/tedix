/** Read-time state uses reports and heartbeat age; silence has no known cause. */

import { localSessionInactive } from "@tedix/api-contract/utils/attention-copy";
import type {
	WorkAgentSessionEffectiveStateSchema,
	WorkAgentSessionStateSchema,
} from "@tedix/api-contract/schemas/work-agent-sessions";
import type * as z from "zod";

type StoredState = z.infer<typeof WorkAgentSessionStateSchema>;
export type WorkAgentSessionEffectiveState = z.infer<
	typeof WorkAgentSessionEffectiveStateSchema
>;

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
	inactiveAfterMs?: number,
): WorkAgentSessionEffectiveState {
	if (session.state === "ended") return "ended";
	if (!Number.isFinite(Date.parse(session.lastEventAt))) return "idle";
	return localSessionInactive(
		session.lastEventAt,
		new Date(now),
		inactiveAfterMs,
	)
		? "idle"
		: session.state;
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
	inactiveAfterMs?: number,
): {
	sessions: Array<
		Omit<T, "state"> & {
			state: WorkAgentSessionEffectiveState;
			effectiveState: WorkAgentSessionEffectiveState;
		}
	>;
	counts: Record<WorkAgentSessionEffectiveState, number>;
} {
	const counts = Object.fromEntries(
		WORK_AGENT_SESSION_BOARD_ORDER.map((state) => [state, 0]),
	) as Record<WorkAgentSessionEffectiveState, number>;
	const rank = new Map<WorkAgentSessionEffectiveState, number>(
		WORK_AGENT_SESSION_BOARD_ORDER.map((state, index) => [state, index]),
	);
	const derived = sessions.map((session) => {
		const effectiveState = deriveWorkAgentSessionEffectiveState(
			session,
			now,
			inactiveAfterMs,
		);
		counts[effectiveState] += 1;
		return { ...session, state: effectiveState, effectiveState };
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

const latest = (a: string, b: string) => (a.localeCompare(b) >= 0 ? a : b);

/** Merge registered reports and observed project heartbeats by session. */
export function buildWorkProjectContributors(
	reports: readonly ContributorReport[],
	attempts: readonly ContributorAttempt[],
	now: string,
	inactiveAfterMs?: number,
): WorkProjectContributor[] {
	const contributors = new Map<string, WorkProjectContributor>();
	const reportedStates = new Map<string, StoredState>();
	for (const report of reports) {
		const sessionKey = `${report.harness}:${report.sessionKey}`;
		const current = contributors.get(sessionKey);
		// Two people cannot share a host session id; keep the newest report.
		if (current && current.lastActivityAt >= report.lastEventAt) continue;
		reportedStates.set(sessionKey, report.state);
		contributors.set(sessionKey, {
			sessionKey,
			harness: report.harness,
			name: report.label || sessionKey,
			state: deriveWorkAgentSessionEffectiveState(report, now, inactiveAfterMs),
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
		if (contributor.state === "ended") continue;
		contributor.state = localSessionInactive(
			contributor.lastActivityAt,
			new Date(now),
			inactiveAfterMs,
		)
			? "idle"
			: (reportedStates.get(contributor.sessionKey) ?? "unknown");
	}
	const settled = new Set(["ended", "unknown"]);
	return [...contributors.values()].sort((a, b) => {
		const bySettled =
			Number(settled.has(a.state)) - Number(settled.has(b.state));
		if (bySettled !== 0) return bySettled;
		return b.lastActivityAt.localeCompare(a.lastActivityAt);
	});
}
