/**
 * Structured lifecycle logs for skill workflow runs.
 *
 * Emits one JSON line per event to console (Workers Logs) with stable keys
 * so downstream queries (Logpush, dashboards) can filter by skillId, tediId,
 * orgId, or status. Costs nothing — uses the platform's existing log pipe.
 *
 * Event keys are intentionally narrow:
 *   - service: "skill-runtime"
 *   - event:   "run.dispatched" | "run.reconciled" | "run.abort_termination_requested" | "run.canceled" | "run.failed"
 *   - runId, workflowInstanceId, skillId, tediId, orgId, status
 *   - durationMs (when terminal), error (when failed)
 */

export type SkillRunEvent =
	| "run.dispatched"
	| "run.reconciled"
	| "run.paused"
	| "run.resumed"
	| "run.restarted"
	| "run.restart_fenced"
	| "run.terminal_submission_pending"
	| "run.abort_termination_requested"
	| "run.canceled"
	| "run.failed"
	| "run.create_failed";

export interface SkillRunLogContext {
	runId: string;
	workflowInstanceId?: string | null;
	skillId?: string;
	tediId?: string;
	orgId?: string;
	status?: string;
	previousStatus?: string;
	durationMs?: number;
	error?: string | null;
	admissionResponseRecovered?: boolean;
	executionEpoch?: number;
}

export function logRunEvent(
	event: SkillRunEvent,
	ctx: SkillRunLogContext,
): void {
	const payload = {
		service: "skill-runtime",
		event,
		ts: new Date().toISOString(),
		...ctx,
	};
	// One JSON line per event — predictable shape for Logpush parsers.
	console.log(JSON.stringify(payload));
}
