/** Polling cadence constants and run-activity helpers for the chat thread. */
import { isHomeRouteRetryable } from "@tedix/api-contract/utils/home-route-retry";
import { useQuery } from "@tanstack/react-query";
import type { HomeRunSet } from "@tedix/api-contract/schemas/kernel-runtime";
import { provisionalSendMessageId } from "@/lib/provisional-send";
import { homeRunSetQueryOptions } from "@/lib/os-query-options";
import {
	ACTIVE_PROJECTION_RECONCILE_MS,
	IDLE_PROJECTION_RECONCILE_MS,
	canonicalProjectionInterval,
} from "@tedix/chat-transport/canonical-projection";

/** Fast convergence cadence while a local send is pending or realtime is
 * degraded. */
export const RUN_POLL_INTERVAL_MS = 4000;

/** Canonical reconciliation backstop for mutable run-set state that can change
 * without a parent-run stream frame (for example child orphan settlement). */
export const RUN_SET_RECONCILE_INTERVAL_MS = ACTIVE_PROJECTION_RECONCILE_MS;

export const MESSAGES_PAGE_LIMIT = 50;

export function runSetPollInterval(input: {
	active: boolean;
	forceActive: boolean;
	realtimeDegraded: boolean;
}): number | false {
	return canonicalProjectionInterval({
		active: input.active,
		urgent: input.forceActive || (input.active && input.realtimeDegraded),
		activeMs:
			input.forceActive || input.realtimeDegraded
				? RUN_POLL_INTERVAL_MS
				: RUN_SET_RECONCILE_INTERVAL_MS,
		idleMs: IDLE_PROJECTION_RECONCILE_MS,
	});
}

export type FirstSendInFlight = {
	/** The id this thread minted; the server creates the conversation under it. */
	conversationId: string;
	idempotencyKey: string;
};

/** Fast enough to read as immediate, bounded to a few reads per new thread. */
export const FIRST_SEND_CONFIRM_POLL_MS = 1000;

/**
 * A new thread has no stream until its enqueue answers, and that answer waits
 * for the turn (up to the server's 25 s soft deadline). The kernel persists the
 * user row before it runs, so reading the transcript under the minted id shows
 * the turn as sent within a poll or two. Polling stops once the row is there;
 * the conversation id is attached when the enqueue answers.
 */
export function firstSendConfirmPollMs(
	firstSend: FirstSendInFlight | null,
	messages: ReadonlyArray<{ id: string }> | undefined,
): number | false {
	if (firstSend === null) return false;
	const durableId = provisionalSendMessageId(firstSend.idempotencyKey);
	return messages?.some((message) => message.id === durableId)
		? false
		: FIRST_SEND_CONFIRM_POLL_MS;
}

export function shouldPollTranscript(input: {
	isActive: boolean;
	pendingRun: boolean;
	realtimeDegraded: boolean;
}): boolean {
	return input.isActive && (input.pendingRun || input.realtimeDegraded);
}

/**
 * The in-flight AFFORDANCE. While work is running the thread must show either
 * streamed assistant text or the running indicator — never nothing. Exported
 * (rather than left inline in the JSX) because the condition is exactly what
 * broke during a delegation: the dispatch ack's overlay was immortal (its
 * durable row is dropped by the server's narration collapse, so the
 * swap-on-durable rule never fired — see `overlay-state.ts`), and a nonzero
 * overlay count suppressed the indicator for the whole minutes-long gap
 * between the ack and the delegated result. The overlay
 * fix is what makes this term honest; the rule itself is unchanged.
 */
export function shouldShowRunningIndicator(input: {
	showRunning: boolean;
	overlayCount: number;
}): boolean {
	return input.showRunning && input.overlayCount === 0;
}

/**
 * The run the Stop/Retry controls act on: this tab's own send, or else the
 * newest active run, so a reloaded or second tab can still stop a turn.
 */
export function controllableRun(
	runSet: Pick<HomeRunSet, "runs" | "activeRunIds"> | undefined,
	pendingRunId: string | null,
): HomeRunSet["runs"][number] | undefined {
	if (!runSet) return undefined;
	const own = runSet.runs.find((run) => run.id === pendingRunId);
	if (own) return own;
	const active = new Set(runSet.activeRunIds);
	const newest = [...runSet.runs].sort(
		(a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
	);
	return (
		newest.find((run) => active.has(run.id)) ??
		(newest[0] && isHomeRouteRetryable(newest[0]) ? newest[0] : undefined)
	);
}

export function useIsRunActive(
	conversationId: string | null,
	forceActive = false,
	realtimeDegraded = false,
): {
	isActive: boolean;
	activeRunIds: string[];
	runSet: HomeRunSet | undefined;
} {
	const query = useQuery({
		...homeRunSetQueryOptions(conversationId ?? ""),
		enabled: conversationId !== null,
		refetchInterval: (current) => {
			const active = (current.state.data?.runSet.activeRunIds.length ?? 0) > 0;
			return runSetPollInterval({ active, forceActive, realtimeDegraded });
		},
	});
	const activeRunIds = query.data?.runSet.activeRunIds ?? [];
	return {
		isActive: forceActive || activeRunIds.length > 0,
		activeRunIds,
		runSet: query.data?.runSet,
	};
}
