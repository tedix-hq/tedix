/**
 * Terminal-seal decision for a completed durable facet workflow turn
 * (`runFacetWorkflowTurnImpl`). Pure and dependency-free so it can be unit
 * tested without booting the DO.
 *
 * Background: a cron/systemEvent turn's deliverable is its Code Mode tool
 * work (memory consolidation, disposal, skill induction) plus the durable ledger
 * effects — NOT closing chat prose. Requiring prose would be a false negative that
 * marks every cognitive cron `lastSuccess:false` even though the mechanical
 * work ran, so an empty assistant message on a
 * cron turn is reclassified as SUCCESS.
 *
 * The trap that reclassification opens: Code Mode / MCP tool errors are
 * fail-soft — the facet proxy catches them and hands the model a `{ error }`
 * object, it never throws — so `turnError` (LLM stream/model failures only) is
 * blind to tool-execution failure. A "dark cron" whose consolidation tool failed
 * but whose model then emitted no prose would otherwise seal `lastSuccess:true`,
 * making that failure undetectable. The
 * per-run tool-step buffer is the durable failure signal, so a cron turn that
 * recorded a failed tool proxy call must seal failure rather than success.
 * Assistant prose cannot override that mechanical evidence: an apology or
 * failure summary is not successful cron work.
 */
export interface FacetTurnOutcomeInput {
	/** LLM stream/model error surfaced by the facet turn; null when the stream completed. */
	turnError: string | null;
	/** Trimmed assistant prose the turn produced; "" when the model emitted none. */
	assistantText: string;
	/** Cron/systemEvent-origin turn — deliverable is tool work, not prose. */
	isCronTurn: boolean;
	/** Work wakes share the background lane, not maintenance success semantics. */
	workItemId?: string;
	/** A facet tool proxy call in this run ended in a failure finish reason. */
	hadToolError: boolean;
}

/**
 * AI SDK tool adapters are deliberately fail-soft: transport exceptions become
 * values the model can read instead of crossing the facet RPC boundary. Detect
 * the two canonical failure envelopes so proxy telemetry still records a
 * mechanical failure rather than an ordinary successful return.
 */
export function facetToolResultIndicatesFailure(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const result = value as Record<string, unknown>;
	return result.isError === true || result.ok === false;
}

/**
 * Reason string to throw for Workflow classification (terminal or retryable), or null
 * to commit the turn as success.
 *
 * - Any real LLM/facet `turnError` fails (all origins).
 * - A maintenance tool failure ⇒ `cron_tool_failure`, regardless of prose.
 * - Work Item review/wake outcomes retain their prose and independent evidence verdict.
 * - Otherwise prose ⇒ success.
 * - No prose on a user turn ⇒ `empty_assistant_message` (unchanged soft-fail).
 * - No prose on a maintenance turn ⇒ success when the tool work did not error.
 * - A silent Work Item wake always fails, even on the background cron lane.
 */
export function facetTurnFailureReason(
	input: FacetTurnOutcomeInput,
): string | null {
	if (input.turnError) return input.turnError;
	if (input.isCronTurn && !input.workItemId && input.hadToolError)
		return "cron_tool_failure";
	if (input.assistantText) return null;
	if (!input.isCronTurn || input.workItemId) return "empty_assistant_message";
	return null;
}

/**
 * Tool-round ceiling for a CRON-ORIGIN turn (fix (c) TIMEOUT).
 *
 * A cron cognitive cycle (memory consolidation, disposal, grounding-review Code
 * Mode loop) executes as ONE durable Workflow step, which Cloudflare bounds by a
 * 10-minute wall clock. The interactive step ceiling (then 40) let the heavy
 * cycle iterate long enough to blow that wall (`Execution timed out after
 * 600000ms`, sealing `lastSuccess:false`). Cron turns run under this
 * tighter cap so a single durable step stays under the limit: the deliverable is
 * bounded tool work + durable ledger stamps, not exhaustive iteration (a
 * no-prose cron turn is SUCCESS, so a capped cycle that stopped short of closing
 * prose still seals success). Deliberately generous vs. the failure mode; a
 * cycle that genuinely needs more work should be chunked across fires, not run
 * as one unbounded step.
 */
export const CRON_TURN_MAX_STEPS = 4;

/**
 * Effective per-turn step ceiling for a cron-origin turn: the smaller of the
 * active loop policy's ceiling and {@link CRON_TURN_MAX_STEPS}. `Math.min` so a
 * policy that already stamps a tighter ceiling is never RAISED by the cron cap.
 * A `null` policy (no step-count stop for interactive turns) still gets the
 * cron cap: cron turns are intentionally tiny.
 */
export function cronTurnMaxSteps(policyMaxSteps: number | null): number {
	return Math.min(policyMaxSteps ?? CRON_TURN_MAX_STEPS, CRON_TURN_MAX_STEPS);
}
