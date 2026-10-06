import { exceptionTopology } from "./exception-topology";
import type { FacetBudgetStopReason } from "./conversation-facet";

type RuntimeFailureEvent =
	| "tedi.runtime.websocket_error"
	| "tedi.runtime.repo_commit_drain_failed"
	| "tedi.runtime.codemode_drain_failed"
	| "tedi.runtime.accounting_completion_denied"
	| "tedi.runtime.step_telemetry_failed"
	| "tedi.runtime.chat_error_mirror_failed"
	| "tedi.runtime.failed_turn_mirror_failed"
	| "tedi.runtime.empty_turn_mirror_failed"
	| "tedi.runtime.ledger_mirror_queue_failed"
	| "tedi.runtime.recovery_mirror_failed"
	| "tedi.runtime.alarm_telemetry_failed"
	| "tedi.runtime.recovery_telemetry_failed"
	| "tedi.runtime.workflow_terminal_mirror_failed"
	| "tedi.runtime.mcp_failed_turn_mirror_failed"
	| "tedi.runtime.mcp_ledger_mirror_queue_failed"
	| "tedi.runtime.voice_ledger_mirror_queue_failed"
	| "tedi.runtime.workflow_ledger_mirror_failed"
	| "tedi.runtime.workflow_dispatch_record_failed"
	| "tedi.runtime.workflow_watchdog_schedule_failed"
	| "tedi.runtime.compaction_failed"
	| "tedi.runtime.compaction_ledger_emit_failed"
	| "tedi.runtime.compaction_queue_failed"
	| "tedi.runtime.stream_ledger_mirror_queue_failed"
	| "tedi.runtime.stream_postdone_effects_failed"
	| "tedi.runtime.stream_turn_failed"
	| "tedi.runtime.turn_mirror_failed"
	| "tedi.runtime.failed_turn_ledger_write_failed"
	| "tedi.runtime.email_ledger_mirror_queue_failed"
	| "tedi.facet.judge_turn_failed"
	| "tedi.facet.synthesis_turn_failed"
	| "tedi.facet.conversation_turn_failed"
	| "tedi.facet.sse_turn_failed"
	| "tedi.facet.proxied_tool_failed"
	| "tedi.workstation.repo_clone_failed"
	| "tedi.workstation.git_cli_failed"
	| "tedi.workstation.repo_load_failed"
	| "tedi.codemode.event_projection_failed"
	| "tedi.computer.wake_dispatch_failed"
	| "tedi.codemode.approval_repair_schedule_failed"
	| "tedi.browser.egress_denial_audit_failed";

type RuntimeStateEvent =
	| "tedi.computer.wake_context_unavailable"
	| "tedi.codemode.approval_repair_exhausted";

type RuntimeDiagnosticEvent =
	| "tedi.runtime.turn_mirror_unavailable"
	| "tedi.runtime.failed_turn_mirror_unavailable";

function retryableFlag(error: unknown): boolean | undefined {
	if (!error || typeof error !== "object") return undefined;
	try {
		const value = (error as { retryable?: unknown }).retryable;
		return typeof value === "boolean" ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Log only code-owned event names and bounded exception topology. */
export function logTediRuntimeFailure(
	event: RuntimeFailureEvent,
	error: unknown,
	level: "warn" | "error" = "warn",
): void {
	const retryable =
		event === "tedi.runtime.websocket_error" ? retryableFlag(error) : undefined;
	console[level]({
		component: "tedi-runtime",
		event,
		...(retryable !== undefined ? { retryable } : {}),
		exception: exceptionTopology(error),
	});
}

/** A missing platform client has no exception to project. */
export function logTediRuntimeDiagnostic(
	event: RuntimeDiagnosticEvent,
	level: "warn" | "error" = "warn",
): void {
	console[level](
		JSON.stringify({
			_tr: "mirror_skipped",
			component: "tedi-runtime",
			event,
			reason: "no_platform_client",
		}),
	);
}

/** Analytics dimensions must not take an untrusted Error name. */
export function runtimeFailureType(error: unknown): string {
	return exceptionTopology(error).type;
}

export function logTediFacetBudgetStop(
	surface: "conversation" | "sse",
	reason: FacetBudgetStopReason,
): void {
	console.error({
		component: "tedi-runtime",
		event: "tedi.facet.budget_stopped",
		surface,
		reason,
	});
}

/** Report a fixed failure state with no exception or request identifiers. */
export function logTediRuntimeState(
	event: RuntimeStateEvent,
	level: "warn" | "error" = "warn",
): void {
	console[level]({ component: "tedi-runtime", event });
}
