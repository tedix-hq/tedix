/** Durable admission-to-start supervision for ChatTurnWorkflow. */

export const WORKFLOW_START_WATCHDOG_DELAY_SECONDS = 60;
export const WORKFLOW_START_WATCHDOG_MAX_RESTARTS = 2;

export interface WorkflowDispatchContext {
	runId: string;
	workItemId?: string;
	/** Cross-layer request trace retained through terminal workflow callbacks. */
	traceId?: string;
	sessionKey: string;
	userText: string;
	userTs: number;
	admittedAt: number;
	startedAt?: number;
	restartCount: number;
	/**
	 * Bounded count of transient-reset RE-DRIVES applied at the terminal settle
	 * path (fix (b)). Distinct from `restartCount` (the pre-start admission
	 * watchdog's budget) so a deploy-window DO reset after the turn started does
	 * not consume the start-stall budget, and vice versa.
	 */
	redriveCount?: number;
	/** Latest attempt-scoped Agents SDK error callback, retained until native settlement. */
	latestAttemptError?: string;
	/** Number of attempt-scoped error callbacks observed for this native instance. */
	errorCallbackCount?: number;
	/**
	 * Bounded count of computer-release retries spent by workflow cleanup. Each
	 * retry destroys the container, so this budget is what keeps a release that
	 * can never succeed from destroying a live workstation forever.
	 */
	computerCleanupAttempts?: number;
	/**
	 * Present only for cron-fired turns: the identity of the execution stamp
	 * `onCronFire` opened (`running`) in the durable cron-execution ledger, so
	 * the terminal hooks (`onWorkflowComplete` / failure mirror) can seal the
	 * SAME row success/failure.
	 */
	cron?: {
		name: string;
		fireKey: string;
		startedAtIso: string;
	};
}

export type WorkflowStartWatchdogDecision =
	| { action: "ignore" }
	| { action: "restart"; nextRestartCount: number }
	| { action: "fail"; reason: string };

/**
 * Decide how to reconcile a workflow that was durably admitted but has not
 * called back from its first checkpoint. The decision is intentionally pure so
 * retry bounds and terminal handling stay reviewable and unit-testable.
 */
export function decideWorkflowStartReconciliation(input: {
	context: WorkflowDispatchContext;
	status?: string;
}): WorkflowStartWatchdogDecision {
	if (input.context.startedAt) return { action: "ignore" };
	const status = input.status ?? "unknown";
	if (status === "complete") {
		return {
			action: "fail",
			reason:
				"workflow settled complete before confirming its first checkpoint",
		};
	}
	if (status === "errored" || status === "terminated") {
		return {
			action: "fail",
			reason: `workflow settled ${status} before confirming its first checkpoint`,
		};
	}
	if (input.context.restartCount >= WORKFLOW_START_WATCHDOG_MAX_RESTARTS) {
		return {
			action: "fail",
			reason: `workflow did not confirm its first checkpoint after ${input.context.restartCount} bounded restarts (last status: ${status})`,
		};
	}
	return {
		action: "restart",
		nextRestartCount: input.context.restartCount + 1,
	};
}
