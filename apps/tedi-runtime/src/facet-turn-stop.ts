import { finalStepToolChoice } from "./turn-model-selection";

/**
 * Step-ceiling and forced-final-report mechanics shared by the conversation
 * facet and its native Pi provider-round admission policy.
 *
 * Two rules live here:
 *
 * 1. **A step ceiling is opt-in.** `null` means "no provider-round stop": the
 *    turn is bounded only by wall clock and the daily budget. A ceiling exists
 *    only when governance (an explicit per-tedi `maxIterationsPerTask` or
 *    the cron/wake caps) stamps a positive integer.
 * 2. **Every early stop ends with a tools-off final report.** When a turn is
 *    stopped by any budget reason, the runtime runs exactly one more model
 *    call with tools disabled and a synthetic instruction, so a turn that
 *    burned its rounds on tool calls still settles with salvageable text
 *    (what was done, what remains, the next step) instead of a bare
 *    "[Turn stopped early]" marker. That call runs outside every ceiling that
 *    triggered it.
 */

/** A stamped positive integer is a ceiling; anything else is "no step stop". */
export function resolveFacetStepCeiling(
	stamped: number | null | undefined,
): number | null {
	return typeof stamped === "number" && Number.isInteger(stamped) && stamped > 0
		? stamped
		: null;
}

/** Durable accounting policy fragment: no `maxSteps` key when unbounded. */
export function accountingStepPolicy(ceiling: number | null): {
	maxSteps?: number;
} {
	return ceiling === null ? {} : { maxSteps: ceiling };
}

export function stepCeilingReached(
	stepCount: number,
	ceiling: number | null,
): ceiling is number {
	return ceiling !== null && stepCount >= ceiling;
}

/**
 * Reserve the final permitted provider round for a tool-free synthesis when a
 * ceiling exists. Without a ceiling there is no last round to reserve.
 */
export function reservedFinalStepConfig(
	ordinal: number,
	ceiling: number | null,
): { toolChoice: "none" } | undefined {
	return ceiling === null ? undefined : finalStepToolChoice(ordinal, ceiling);
}

/**
 * Why the turn needs the tools-off final report, if it does. Besides an early
 * stop, a loop that ends with no prose gets one: models sometimes finish
 * `stop` with empty text right after a large tool result, and failing the
 * whole turn then throws away every completed tool effect.
 */
export function finalReportReason(input: {
	stopReason: string | null;
	assistantText: string;
}): string | null {
	if (input.stopReason) return input.stopReason;
	return input.assistantText.trim()
		? null
		: "your last response contained no written answer";
}

/**
 * A loop whose last model step ended in a provider error has no answer, and a
 * tools-off report would only repeat the same failed call. Surface the provider
 * text so the durable step can classify it (deterministic faults seal, transient
 * ones retry) instead of hiding it behind `empty_assistant_message`.
 */
export function emptyTurnModelError(input: {
	assistantText: string;
	lastModelError: string | null | undefined;
}): string | null {
	if (input.assistantText.trim()) return null;
	return input.lastModelError?.trim() || null;
}

/** The synthetic instruction that drives the forced final report. */
export function finalReportInstruction(reason: string): string {
	return (
		`The turn is ending because ${reason}. Do not call tools. ` +
		"Write: what you accomplished (with exact files/commands/ids), " +
		"what remains, and the single next step."
	);
}

/** Model-free notice appended after every early stop. */
export function stoppedTurnNotice(reason: string): string {
	return `[Turn stopped early: ${reason}. Partial results above; remaining work was not attempted.]`;
}

/**
 * Final assistant text of a stopped turn: the loop's own text, then the forced
 * final report, then the notice. Empty segments are dropped so a turn that
 * produced nothing still settles with the report and the notice.
 */
export function composeStoppedTurnText(input: {
	assistantText: string;
	finalReport: string;
	notice: string;
}): string {
	return [input.assistantText, input.finalReport, input.notice]
		.map((segment) => segment.trim())
		.filter(Boolean)
		.join("\n\n");
}
