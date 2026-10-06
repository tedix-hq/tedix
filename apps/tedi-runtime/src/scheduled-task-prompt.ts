/**
 * Canonical prompt envelope for a scheduled (cron / systemEvent) tedi turn.
 *
 * Pure and dependency-free so it can be unit tested without booting the DO, and
 * so the same envelope can be produced by any future scheduler (skill workflows,
 * kernel wake-ups) rather than re-invented per call site.
 *
 * WHY: `cron-turn-outcome.ts` already reasons carefully about what a cron turn's
 * DELIVERABLE is — tool work and durable ledger effects, NOT closing chat prose.
 * The prompt must tell the model that too. A turn that assumes a human is
 * reading answers conversationally: it asks a clarifying question no one will
 * answer, or apologizes instead of doing the work. `facetTurnFailureReason` then
 * has to reclassify empty prose as success downstream to avoid false negatives.
 * This is the upstream half of that fix.
 *
 * A comparable coding agent's `src/cron/scheduled-task-prompt.ts` is the prior art: every fire
 * is wrapped with its identity, its schedule, the intended-vs-actual fire time,
 * and an explicit autonomous notice — and the envelope is parseable back off the
 * persisted message so scheduled runs stay auditable.
 *
 * The stored authored prompt stays SEPARATE from runtime metadata: the schedule
 * row keeps `payload.message` verbatim, and the envelope is composed at dispatch.
 */

export type ScheduledTaskRecurrence =
	| { type: "one-off" }
	| { type: "cron"; expr: string }
	| { type: "every"; everyMs: number };

export interface ScheduledTaskPromptInput {
	/** Schedule name (`payload.name`), or null for an unnamed job. */
	name: string | null;
	/** The authored prompt, exactly as persisted on the schedule. */
	prompt: string;
	/** Occurrence the scheduler intended to fire (ms since epoch). */
	scheduledForMs: number | null;
	/** Authoritative time captured at dispatch (ms since epoch). */
	currentTimeMs: number;
	recurrence: ScheduledTaskRecurrence;
}

/**
 * The load-bearing sentence. A scheduled turn has no interlocutor: a question is
 * a dropped turn, and an apology is not work. Naming where output must land
 * (channels, memory, ledger) is what turns "acknowledge the prompt" into "do the
 * job".
 */
export const AUTONOMOUS_NOTICE =
	"You are running autonomously: no user is watching this turn and questions will not be answered. Deliver results through your available tools and channels or record them in memory — the deliverable is the tool work and its durable effects, not a closing message. Work until the task is done or genuinely blocked.";

const TITLE_PREFIX = "Scheduled task";
const PROMPT_MARKER = "Prompt:";

function formatIso(ms: number | null): string | null {
	if (ms === null || !Number.isFinite(ms)) return null;
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatRecurrence(recurrence: ScheduledTaskRecurrence): string {
	switch (recurrence.type) {
		case "cron":
			return `This is a recurring scheduled task (cron: ${recurrence.expr}).`;
		case "every":
			return `This is a recurring scheduled task (every ${recurrence.everyMs}ms).`;
		default:
			return "This is a one-off scheduled task.";
	}
}

/**
 * Compose the envelope. Drift between `Scheduled for` and `Current time` is
 * deliberately visible: a fire minutes late is a real signal the turn (and any
 * human reading the ledger) should be able to see.
 */
export function formatScheduledTaskPrompt(
	input: ScheduledTaskPromptInput,
): string {
	const scheduledFor = formatIso(input.scheduledForMs);
	const currentTime = formatIso(input.currentTimeMs);
	const lines = [
		`${TITLE_PREFIX} "${input.name ?? "unnamed"}" is firing.`,
		...(scheduledFor ? [`Scheduled for: ${scheduledFor}`] : []),
		...(currentTime ? [`Current time: ${currentTime}`] : []),
		formatRecurrence(input.recurrence),
		"",
		AUTONOMOUS_NOTICE,
		"",
		`${PROMPT_MARKER} ${input.prompt}`,
	];
	return lines.join("\n");
}
