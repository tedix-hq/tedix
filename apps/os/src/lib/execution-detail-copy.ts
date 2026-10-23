import type {
	HomeChildRunStatus,
	HomeRunTrace,
} from "@tedix/api-contract/schemas/kernel-runtime";

/**
 * Plain-language copy for the Response details panel. The trace and the
 * delegated-result preview carry machine codes and transport envelopes; the
 * person reading the panel gets sentences, never a code or an opaque id.
 */

const ACTIVE_RUN_STATUSES: ReadonlySet<string> = new Set([
	"queued",
	"running",
	"streaming",
	"requires_approval",
]);

export function isActiveRunStatus(status: string): boolean {
	return ACTIVE_RUN_STATUSES.has(status);
}

type TediName = (childRunId: string) => string;

const HEALTH_SENTENCES: Record<string, (who: string) => string> = {
	terminal_child_without_wake: (who) =>
		`${who} finished, but Home was not notified.`,
	acknowledged_wake_without_synthesis: (who) =>
		`Home received ${who}'s result but did not write a final answer.`,
	parent_completed_with_required_child_active: (who) =>
		`This response finished while ${who} was still working.`,
	child_evidence_missing: (who) => `${who}'s activity record is not available.`,
	child_evidence_truncated: (who) => `Only part of ${who}'s activity is shown.`,
	orphaned_workstation_reference: () =>
		"A workstation step could not be linked to its run.",
	repeated_synthesis_failures: () =>
		"Home failed several times to write the final answer.",
	repeated_redrive_failures: () =>
		"Retrying the delegation failed several times.",
};

/**
 * One short sentence for a trace gap code (`code` or `code:<childRunId>`), or
 * null when the code adds nothing a person can act on. Branch ids are resolved
 * to the delegated tedi's name and never printed.
 */
export function traceGapSentence(gap: string, tediName: TediName): string {
	const [code = "", ...rest] = gap.split(":");
	const branchId = rest.join(":");
	const who = branchId ? tediName(branchId) : "The delegated tedi";
	switch (code) {
		case "parent_not_terminal":
			return "Still running.";
		case "parent_events_missing":
			return "No activity was recorded for this response.";
		case "parent_events_truncated":
			return "Only the first part of the activity is shown.";
		case "branch_limit_exceeded":
			return "Some delegations are not shown.";
		case "child_not_terminal":
			return `${who}'s delegated run hasn't finished.`;
		case "child_evidence_missing":
		case "child_evidence_truncated":
			return HEALTH_SENTENCES[code]!(who);
		case "wake_pending":
			return `Waiting for Home to pick up ${who}'s result.`;
		case "final_synthesis_missing":
			return "Home hasn't written its final answer yet.";
		case "convergence_health": {
			const [health = "", ...childParts] = rest;
			const childId = childParts.join(":");
			const sentence = HEALTH_SENTENCES[health];
			return sentence
				? sentence(childId ? tediName(childId) : "the delegated tedi")
				: "Part of the delegation did not settle cleanly.";
		}
		case "request_acceptance_unverified":
			return "Result not yet checked against the request.";
		case "request_report_unacknowledged":
			return "The final report hasn't been delivered yet.";
		case "request_history_truncated":
			return "Only part of the request history is shown.";
		default:
			return "Some activity details are incomplete.";
	}
}

export type TraceSummary = {
	tone: "complete" | "pending" | "warning";
	title: string;
	notes: string[];
};

/**
 * Summarize trace completeness. A run that is still going is "pending", not a
 * warning: its open gaps are simply what has not happened yet.
 */
export function traceSummary(
	trace: Pick<
		HomeRunTrace,
		"complete" | "gaps" | "branches" | "parentEventIds"
	>,
	runStatus: string,
	tediName: TediName,
): TraceSummary {
	const notes = [
		...new Set(trace.gaps.map((gap) => traceGapSentence(gap, tediName))),
	];
	if (isActiveRunStatus(runStatus))
		return {
			tone: "pending",
			title: "In progress",
			notes: notes.filter((note) => note !== "Still running."),
		};
	if (trace.complete || !notes.length) {
		const branches = trace.branches.length;
		return {
			tone: "complete",
			title: "Activity fully recorded",
			notes: [
				`${trace.parentEventIds.length} step${trace.parentEventIds.length === 1 ? "" : "s"}${branches ? ` and ${branches} delegation${branches === 1 ? "" : "s"}` : ""} recorded.`,
			],
		};
	}
	return { tone: "warning", title: "Some details are missing", notes };
}

export type DelegatedResult =
	| { kind: "working"; message: string }
	| { kind: "empty"; message: string }
	| { kind: "text"; markdown: string }
	| {
			kind: "structured";
			message: string;
			raw: string;
			truncatedChars: number | null;
	  };

const RAW_RESULT_PREFIX = "Raw result:";
const FENCE = /^```[ \t]*(?:json|jsonc|json5)?[ \t]*\n?([\s\S]*?)\n?```$/i;
const ANSWER_KEYS = [
	"answer",
	"summary",
	"result",
	"message",
	"text",
	"content",
] as const;

function prettyJson(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

/** A string field that reads as the child's answer, when the JSON has one. */
function answerFrom(value: unknown): string | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	for (const key of ANSWER_KEYS) {
		const field = record[key];
		if (typeof field === "string" && field.trim()) return field.trim();
	}
	return null;
}

/**
 * Turn the child run's stored preview into something a person can read: the
 * answer as Markdown, or for structured output a one-line description with the
 * pretty-printed JSON kept for an opt-in "Show raw" view. A running child shows
 * a plain working state instead of whatever intermediate tool output it has.
 */
export function delegatedResult(
	status: HomeChildRunStatus,
	preview: string | null | undefined,
	tediName: string,
): DelegatedResult {
	if (status === "requires_approval")
		return { kind: "working", message: "Waiting for approval…" };
	if (isActiveRunStatus(status))
		return { kind: "working", message: "Still working…" };
	const text = preview?.trim();
	if (!text)
		return {
			kind: "empty",
			message:
				status === "failed"
					? `${tediName} stopped without a result.`
					: `${tediName} didn't return a written answer.`,
		};
	const body = text.startsWith(RAW_RESULT_PREFIX)
		? text.slice(RAW_RESULT_PREFIX.length).trim()
		: text;
	const fenced = FENCE.exec(body);
	const candidate = (fenced ? fenced[1] : body)?.trim() ?? "";
	if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
		return { kind: "text", markdown: text };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate);
	} catch {
		return text.startsWith(RAW_RESULT_PREFIX)
			? {
					kind: "structured",
					message: `${tediName} returned data instead of a written answer.`,
					raw: candidate,
					truncatedChars: null,
				}
			: { kind: "text", markdown: text };
	}
	const envelope =
		parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	if (envelope?.__tedix_truncated === true) {
		const inner = typeof envelope.preview === "string" ? envelope.preview : "";
		let innerValue: unknown = inner;
		try {
			innerValue = JSON.parse(inner);
		} catch {
			// A truncated preview is usually partial JSON; show it as text.
		}
		const answer = answerFrom(innerValue);
		if (answer) return { kind: "text", markdown: answer };
		return {
			kind: "structured",
			message: `${tediName} returned a large data result instead of a written answer.`,
			raw: typeof innerValue === "string" ? innerValue : prettyJson(innerValue),
			truncatedChars:
				typeof envelope.originalChars === "number"
					? envelope.originalChars
					: null,
		};
	}
	const answer = answerFrom(parsed);
	if (answer) return { kind: "text", markdown: answer };
	return {
		kind: "structured",
		message: `${tediName} returned data instead of a written answer.`,
		raw: prettyJson(parsed),
		truncatedChars: null,
	};
}

/** "Running for 3m 12s"-style elapsed time from an ISO start, or null. */
export function elapsedSince(
	startedAt: string | null | undefined,
	now: number,
): number | null {
	if (!startedAt) return null;
	const started = Date.parse(startedAt);
	if (!Number.isFinite(started)) return null;
	return Math.max(0, now - started);
}
