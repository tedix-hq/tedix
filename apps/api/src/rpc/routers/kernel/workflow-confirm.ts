/**
 * Kernel — workflow confirm→dispatch wiring.
 *
 * When the previous turn in a Home conversation produced a `run_workflow` route
 * (the kernel asked "Want me to start it?"), the operator's next clear affirmative
 * should dispatch the named workflow rather than re-routing through the LLM.
 *
 * TWO pure concerns here:
 *   1. classifyAffirmative(content) — is this a clear "yes, go ahead"?
 *   2. readPendingWorkflowHint(db, …) — does the most recent completed prior run
 *      in this conversation carry a `run_workflow` kernelRoute with a workflowHint?
 *
 * Both are pure over their inputs and carry no side effects — fully unit-testable.
 * The dispatch itself is an injected dep in `KernelTurnWorkDeps`; this module
 * only detects the intent and reads the pending state.
 */

import { stripLocalTerminalContext } from "./context-assembly";

export { readPendingWorkflowHint } from "@tedix/db/queries/kernel-runtime-runs";

// ─── Affirmative detection ────────────────────────────────────────────────────

/**
 * Explicit affirmative set. Conservative by design: only clear, unambiguous
 * confirmations. Partial phrases ("yes but…"), questions ("yes?"), or anything
 * that could be re-routing a new request must fall through. A false negative
 * (fall-through to normal kernel planning) is safe; a false positive (wrong
 * dispatch) is not.
 */
const AFFIRMATIVE_EXACT = new Set([
	"yes",
	"yes please",
	"yep",
	"yup",
	"yeah",
	"yeah please",
	"sure",
	"sure thing",
	"go ahead",
	"go for it",
	"start it",
	"start",
	"do it",
	"run it",
	"yes start it",
	"yes go ahead",
	"yes do it",
	"yes run it",
	"yes please start it",
	"please start it",
	"let's do it",
	"let's go",
	"lets do it",
	"lets go",
	"ok go ahead",
	"okay go ahead",
	"ok do it",
	"okay do it",
	"ok start it",
	"okay start it",
	"confirm",
	"confirmed",
	"proceed",
]);

/**
 * Returns true when `content` is a clear, unambiguous affirmative that should
 * trigger a pending-workflow dispatch. Rejects any message with a question mark
 * (even "yes?" — that's a different intent) or ≥ 8 words (probably a new request,
 * not a bare confirmation).
 */
export function classifyAffirmative(content: string): boolean {
	// The CLI appends a terminal-context block to every message it sends.
	const trimmed = stripLocalTerminalContext(content).trim();
	if (!trimmed) return false;
	if (trimmed.includes("?")) return false;

	// Normalize: drop `!.,` ANYWHERE (so "yes, go ahead" / "yes, start it." match
	// the comma-free exact set) and collapse whitespace. `?` already rejected above.
	const lower = trimmed
		.toLowerCase()
		.replace(/[!.,]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const wordCount = lower.split(/\s+/).filter(Boolean).length;
	if (wordCount >= 8) return false;

	return AFFIRMATIVE_EXACT.has(lower);
}

const APPROVE_EXACT = new Set([
	"approve",
	"approve it",
	"approved",
	"yes approve",
	"yes approve it",
	"ok approve",
	"okay approve",
	"ok approve it",
	"okay approve it",
]);

const REJECT_EXACT = new Set([
	"no",
	"nope",
	"no thanks",
	"reject",
	"reject it",
	"deny",
	"deny it",
	"don't",
	"don't do it",
	"do not do it",
	"cancel it",
]);

/**
 * A bare reply to a pending approval card: "approve"/"yes" approves, "reject"/
 * "no" rejects. Same conservative shape as {@link classifyAffirmative} — any
 * question or longer message is a new request, not a decision.
 */
export function classifyApprovalReply(
	content: string,
): "approve" | "reject" | null {
	if (classifyAffirmative(content)) return "approve";
	const trimmed = stripLocalTerminalContext(content).trim();
	if (!trimmed || trimmed.includes("?")) return null;
	const lower = trimmed
		.toLowerCase()
		.replace(/[!.,]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (APPROVE_EXACT.has(lower)) return "approve";
	if (REJECT_EXACT.has(lower)) return "reject";
	return null;
}

// ─── Prior-run pending-workflow read ─────────────────────────────────────────

/**
 * Read the pending workflow hint from the most recent COMPLETED (non-running,
 * non-pending) prior kernel run in this conversation. Returns the `workflowHint`
 * string when the prior run's `kernelRoute.routeKind === "run_workflow"` and a
 * non-empty `workflowHint` is set. Returns `null` when no such pending state
 * exists, on any read failure (fail-soft), or when the current run IS the
 * most-recent run (excludes `excludeRunId`).
 *
 * Excludes `excludeRunId` (the current turn's run id, which is already inserted
 * persist-first at `running` status) so the check reads the PREVIOUS assistant
 * turn, not the current one.
 */
// ─── Types ───────────────────────────────────────────────────────────────────

export interface WorkflowDispatchInput {
	organizationId: string;
	conversationId: string;
	homeRunId: string;
	workflowSlug: string;
}

export interface WorkflowDispatchResult {
	workflowRunId: string;
	status: "dispatched" | "failed";
	/** Owning tedi, captured with the Home→workflow link for operator controls. */
	workflowTediId?: string;
	error?: string;
}

/** Injected dispatcher — pure over this interface, wired with SKILL_RUNTIME in production. */
export type WorkflowConfirmDispatcher = (
	input: WorkflowDispatchInput,
) => Promise<WorkflowDispatchResult>;
