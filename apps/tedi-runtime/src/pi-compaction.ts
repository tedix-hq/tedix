import type { AigMetadata } from "./llm";
import {
	observerCompletion,
	type ObserverEnv,
	type ConfiguredObserverCallOptions,
} from "./observer-llm";

export type ContextCompactionCompletion = (
	options: ConfiguredObserverCallOptions,
) => Promise<string>;

/** Summarize the exact context span selected by the session repository.
 * Roll a prior summary forward; observer failures leave the original rows intact.
 */
export async function summarizeContextEntries(
	env: ObserverEnv,
	entries: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
	// #7 incremental compaction: the prior rolling summary (if any).
	previousSummary?: string,
	metadata?: AigMetadata,
	model?: Pick<ConfiguredObserverCallOptions, "modelRef" | "deployment">,
	completion: ContextCompactionCompletion = observerCompletion,
): Promise<string | null> {
	if (entries.length === 0) return null;
	const transcript = entries
		.map((e) => `${e.role}:\n${e.content}`)
		.filter((line) => line.trim().length > 0)
		.join("\n\n");
	if (!transcript.trim()) return null;

	// #7: when a prior summary exists, roll it FORWARD — feed it in and switch to
	// the UPDATE prompt so the model preserves prior facts and adds the new span,
	// instead of re-summarizing already-compacted history. Fresh otherwise.
	const hasPrior = !!previousSummary?.trim();
	const systemPrompt = hasPrior
		? UPDATE_COMPACTION_SYSTEM_PROMPT
		: COMPACTION_SYSTEM_PROMPT;
	const userContent = hasPrior
		? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n<new-messages>\n${transcript}\n</new-messages>`
		: transcript;

	try {
		const raw = await completion({
			env,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userContent },
			],
			temperature: 0.2,
			metadata,
			...model,
		});
		const summary = extractSummary(raw);
		return summary.trim() ? summary : null;
	} catch {
		// Best-effort: never propagate a compaction failure into the turn.
		return null;
	}
}

/**
 * The summary's structure. Mid-turn compaction now fires INSIDE long tool-heavy
 * turns (proactively at a share of the model window, see
 * `context-overflow.ts`), so the agent must resume the same task from the
 * summary alone: what it was doing, what is already done, and the exact paths,
 * commands, and errors it needs. A free-form paragraph lost those.
 */
export const COMPACTION_SUMMARY_SECTIONS = [
	"Goal",
	"Constraints",
	"Done",
	"In progress",
	"Remaining",
	"Files touched",
	"Critical context",
] as const;

const COMPACTION_SUMMARY_SHAPE =
	"Write the summary as plain text with these headed sections, in this order, " +
	"each on its own line followed by its content: " +
	COMPACTION_SUMMARY_SECTIONS.map((section) => `${section}:`).join(" ") +
	" — Goal is the task the user asked for; Constraints are the rules, " +
	"scope limits and preferences stated; Done lists completed steps with their " +
	"outcomes; In progress is the step underway at the cut; Remaining is the " +
	"ordered work still to do; Files touched lists exact paths with what " +
	"changed in each; Critical context holds exact commands run, exact error " +
	"messages, identifiers, URLs and values needed to continue without " +
	'rediscovering them. Write "none" for an empty section.';

const COMPACTION_SYSTEM_PROMPT =
	"You compress a span of an AI agent conversation into a concise factual " +
	"summary so no important context is lost when the original messages are " +
	"dropped. Preserve concrete decisions, established facts, user intent, " +
	"tool calls and their results, and any unresolved threads. Omit filler and " +
	"pleasantries. Be terse and specific.\n\n" +
	COMPACTION_SUMMARY_SHAPE +
	"\n\nRespond with a JSON object of the exact shape " +
	'{"summary": "<the summary as a single plain-text string>"}.';

// Incremental compaction roll-forward prompt. Used when a prior summary is
// rolled forward with only the new message span.
const UPDATE_COMPACTION_SYSTEM_PROMPT =
	"You maintain a rolling summary of an AI agent conversation. You are given " +
	"the PREVIOUS summary (in <previous-summary>) and only the NEW messages " +
	"since it was written (in <new-messages>). Produce an UPDATED summary that " +
	"PRESERVES all information from the previous summary and ADDS the new " +
	"decisions, established facts, user intent, tool calls and their results, " +
	"and unresolved threads from the new messages. Never drop prior facts; " +
	"reconcile any that the new messages changed. Omit filler and pleasantries. " +
	"Be terse and specific.\n\n" +
	COMPACTION_SUMMARY_SHAPE +
	" Move items from In progress and Remaining into Done as the new messages " +
	"complete them.\n\nRespond with a JSON object of the exact shape " +
	'{"summary": "<the updated summary as a single plain-text string>"}.';

/**
 * Pull the summary string out of the observer's JSON response. The observer
 * deployment runs in `response_format: json_object` mode, so we expect
 * `{ "summary": "..." }`; we fall back to the raw text (stripped of code
 * fences) if parsing fails or the field is missing.
 */
function extractSummary(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) return "";
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			const obj = parsed as { summary?: unknown };
			if (typeof obj.summary === "string") return obj.summary.trim();
		}
	} catch {
		// Not JSON — strip fences and use the body as-is.
	}
	return trimmed
		.replace(/^```(?:json)?\s*\n?/i, "")
		.replace(/\n?```\s*$/, "")
		.trim();
}
