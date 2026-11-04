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
 * 2. **Every early stop ends with a tools-off final report.** A step-ceiling
 *    stop reuses an owned, completed tools-off answer when its receipt proves
 *    it already exists. Otherwise the runtime runs one more model call with
 *    tools disabled and a synthetic instruction, so a turn that burned its
 *    rounds on tool calls still settles with salvageable text. This extra
 *    call runs outside the triggering ceiling. The stop notice remains.
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

/** Blocker kinds a delegated tedi may declare on the first line of its report. */
export const REPORT_BLOCKER_KINDS = [
	"missing_repository",
	"missing_access",
	"missing_capability",
	"transient",
] as const;

/** The line the model writes between the operator part and the technical part. */
export const TECHNICAL_REPORT_SEPARATOR = "---technical---";
const TECHNICAL_SEPARATOR_RE = /^\s*-{3,}\s*technical\s*-{3,}\s*$/im;

/**
 * The synthetic instruction that drives the forced final report. It asks for
 * two parts: the first is for the person who asked (plain words, no tool
 * names), the second is for the engineer and never reaches the chat. A tedi
 * that could not proceed opens with one `Blocked (<kind>): …` line so Home
 * can act on it instead of relaying a diagnostic.
 */
export function finalReportInstruction(reason: string): string {
	return (
		`The turn is ending because ${reason}. Do not call tools. ` +
		"Write two parts separated by a line containing only " +
		`\`${TECHNICAL_REPORT_SEPARATOR}\`. ` +
		"Part 1 is for the person who asked, in plain words with no tool names, file paths, ids or commands: " +
		"one or two sentences on what changed or what you found, then at most one next action they can take. " +
		"If you could not proceed because something is not connected, not configured or not allowed, " +
		"start Part 1 with one line `Blocked (<kind>): <what is missing, in plain words>` where <kind> is one of " +
		`${REPORT_BLOCKER_KINDS.join(", ")}. ` +
		"Part 2 is for the engineer: exact files, commands, ids and tool names, what remains, and the single next step."
	);
}

/**
 * Split the forced final report into its operator part and its technical
 * part. A report without the separator is all operator text.
 */
export function splitFinalReport(report: string): {
	operator: string;
	technical: string | null;
} {
	const match = TECHNICAL_SEPARATOR_RE.exec(report);
	if (!match) return { operator: report.trim(), technical: null };
	const operator = report.slice(0, match.index).trim();
	const technical = report.slice(match.index + match[0].length).trim();
	return { operator, technical: technical || null };
}

/**
 * The technical part travels inside the assistant text behind markers so it
 * stays in the run's evidence; Home strips the block before relaying and keeps
 * it as message metadata.
 */
export function technicalReportBlock(technical: string): string {
	return `[technical-report]\n${technical}\n[/technical-report]`;
}

/** Model-free notice appended after every early stop. */
export function stoppedTurnNotice(reason: string): string {
	return `[Turn stopped early: ${reason}. Partial results above; remaining work was not attempted.]`;
}

/**
 * Final assistant text of a turn that carries a forced final report: the loop's
 * own text, then the report's operator part, then the technical part behind
 * its markers, then the stop notice when the turn stopped early. Empty
 * segments are dropped so a turn that produced nothing still settles with the
 * report and the notice.
 */
export function composeStoppedTurnText(input: {
	assistantText: string;
	finalReport: string;
	notice: string | null;
}): string {
	const { operator, technical } = splitFinalReport(input.finalReport);
	return [
		input.assistantText,
		operator,
		technical ? technicalReportBlock(technical) : "",
		input.notice ?? "",
	]
		.map((segment) => segment.trim())
		.filter(Boolean)
		.join("\n\n");
}
