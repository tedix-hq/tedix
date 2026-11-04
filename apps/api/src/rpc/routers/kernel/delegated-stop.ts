/**
 * One classifier for a delegated child run that the runtime stopped before the
 * work was done (budget / step / context ceilings, a sealed provider error) or
 * that the tedi itself labeled partial.
 *
 * "Partial" is precise: the child's assistant text, with every synthetic
 * runtime marker stripped and trimmed, is non-empty. A stop that left only the
 * `[Turn stopped early: …]` notice behind produced NO output and is `failed`,
 * carrying the runtime's stop reason and step count so Home can say why.
 *
 * Works for both child-runtime generations: the older one appended only the
 * marker (text may be empty); the newer one forces a text report before the
 * marker. The structured `run.completed.payload.stopReason` is authoritative
 * for the reason id when present; the marker is parsed when it is not.
 */

export type DelegatedStopOutcome = "partial" | "failed";

/** The existing leading final-answer protocol; this is a task result, not runtime status. */
export type DeclaredDelegationOutcome =
	| "succeeded"
	| "failed"
	| "needs_follow_up";

export function declaredDelegationOutcome(
	text: string | null | undefined,
): DeclaredDelegationOutcome | null {
	// Only an exact first line declares an outcome. Missing/invalid declarations
	// keep the existing ordinary-answer path; mentions and quoted logs do not count.
	switch (text?.trimStart().split("\n", 1)[0]?.trimEnd()) {
		case "Outcome: succeeded":
			return "succeeded";
		case "Outcome: failed":
			return "failed";
		case "Outcome: needs_follow_up":
			return "needs_follow_up";
		default:
			return null;
	}
}

/**
 * The heading a delegated child must write above the quoted output of its
 * verify command. The dispatch text asks for it verbatim; the classifier
 * below looks for it (as a line start, tolerating markdown emphasis) before it
 * lets a success report stand.
 */
export const VERIFICATION_OUTPUT_HEADING = "Verification output:";
/** Stop reason id for a success report that skipped the required verification. */
export const VERIFICATION_MISSING_STOP_REASON = "verification_missing";
// The heading may carry Markdown noise and an ordered-list marker: a child
// asked to report in numbered steps writes "4. Verification output:".
const VERIFICATION_OUTPUT_RE =
	/(?:^|\n)[\s#*>`_-]*(?:\d{1,3}[.)]\s*)?[\s#*>`_-]*Verification output:/i;
const MAX_VERIFY_COMMAND_LEN = 500;

/** Whether the child's text carries a `Verification output:` section. */
export function hasVerificationOutput(
	text: string | null | undefined,
): boolean {
	return typeof text === "string" && VERIFICATION_OUTPUT_RE.test(text);
}

/**
 * Read the verify command off a Home run's opaque `metadata` JSON column —
 * `metadata.delegationWorkOrder.verifyCommand`, written only by
 * `buildDelegationWorkOrder`. Any other shape resolves to `null`.
 */
export function delegationVerifyCommand(metadata: unknown): string | null {
	if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
		return null;
	}
	const workOrder = (metadata as Record<string, unknown>).delegationWorkOrder;
	if (!workOrder || typeof workOrder !== "object" || Array.isArray(workOrder)) {
		return null;
	}
	const value = (workOrder as Record<string, unknown>).verifyCommand;
	const trimmed = typeof value === "string" ? value.trim() : "";
	return trimmed ? trimmed.slice(0, MAX_VERIFY_COMMAND_LEN) : null;
}

/**
 * The child-facing verification requirement, rendered identically by every
 * dispatch text (rendered work order, direct delegation, raw fallback) so the
 * classifier's expectation and the instruction never drift apart.
 */
export function verificationRequirementLines(verifyCommand: string): string[] {
	return [
		"Verification:",
		`- Before reporting, run this exact command in your own environment: ${verifyCommand}`,
		`- Quote its final output (bounded to the last ~40 lines) under a \`${VERIFICATION_OUTPUT_HEADING}\` heading in your reply.`,
		"- If the command does not pass, report `Outcome: failed` or begin with `Partial result:` — never `Outcome: succeeded`.",
		`- A success report without a \`${VERIFICATION_OUTPUT_HEADING}\` section is treated as partial by Home.`,
	];
}

/** Failure-policy clause appended when a delegation carries a verify command. */
export function verificationFailurePolicyClause(): string {
	return `a success report without a "${VERIFICATION_OUTPUT_HEADING}" section quoting the verify command's output is treated as partial`;
}

export type DelegatedStopClassification = {
	/** `partial` when the child produced substantive text; `failed` when only markers remained or execution was explicitly refused. */
	outcome: DelegatedStopOutcome;
	/** Structured reason id (`context_ceiling`, `step_ceiling`, `budget_exhausted`, `provider_error`, `reported_partial`, `early_stop`, `blocked`). */
	stopReason: string;
	/** Operator-facing sentence: `Stopped after 17 steps: per-turn cumulative input-token ceiling reached`. */
	detail: string;
	/** Step count parsed from the marker, when the runtime reported one. */
	steps: number | null;
	/** The child's assistant text with synthetic markers stripped and trimmed. */
	output: string;
	/** The structured blocker the child declared (or that its text plainly carries), when it could not proceed. */
	blocker?: DelegationBlocker | null;
};

/** Stop reason id for a child that declared it could not proceed. */
export const BLOCKED_STOP_REASON = "blocked";

export const DELEGATION_BLOCKER_KINDS = [
	"missing_repository",
	"missing_access",
	"missing_capability",
	"transient",
] as const;
export type DelegationBlockerKind = (typeof DELEGATION_BLOCKER_KINDS)[number];

/**
 * What stopped a delegated child before it could do the work, as data Home can
 * act on: re-route to a tedi that has the capability, retry once after a
 * transient failure, or ask the person for the one thing to connect or allow.
 * `detail` is the child's plain-words description of what is missing.
 */
export type DelegationBlocker = {
	kind: DelegationBlockerKind;
	detail: string;
	/** `declared` when the child wrote the `Blocked (<kind>):` line; `inferred` when its text plainly carries a known blocker. */
	source: "declared" | "inferred";
};

// The child's protocol line: `Blocked (missing_repository): no repository is connected yet.`
// Only the first non-empty line declares a blocker; mentions further down do not.
const BLOCKED_LINE_RE =
	/^[\s#*>`_-]*Blocked\s*\((missing_repository|missing_access|missing_capability|transient)\)\s*:\s*(.+?)\s*$/i;
// Text that says, in the runtime's or the model's own words, that nothing was
// done because a known dependency is missing. Checked against the report's
// head only, so a long answer that merely mentions a configuration does not
// turn into a blocker.
const NO_PROGRESS_RE =
	/\b(?:accomplished nothing|nothing (?:was )?(?:accomplished|done|produced)|could not (?:start|proceed|begin|continue)|did not (?:get|make) (?:any )?progress|unable to (?:start|proceed|continue))\b/i;
const INFERRED_BLOCKERS: ReadonlyArray<{
	kind: DelegationBlockerKind;
	match: RegExp;
	detail: string;
	/** Strong enough on its own; no no-progress phrase needed. */
	standalone?: boolean;
}> = [
	{
		kind: "missing_repository",
		match:
			/repository_not_configured|No repository is (?:configured|connected)/i,
		detail: "no repository is connected for this worker yet.",
		standalone: true,
	},
	{
		kind: "missing_capability",
		match:
			/\bcapability (?:gap|tool unavailable)\b|\bno (?:tool|app) (?:is )?(?:available|connected) (?:for|to)\b/i,
		detail: "a tool this task needs is not connected for this worker.",
	},
	{
		kind: "missing_access",
		match:
			/\b(?:unavailable or unauthorized|not authorized|unauthori[sz]ed|permission denied|access (?:is )?denied|403 Forbidden|missing (?:scope|permission)s?)\b/i,
		detail: "this worker is not allowed to use something the task needs.",
	},
];
const INFERRED_HEAD_CHARS = 600;
const BLOCKER_DETAIL_CHARS = 240;

function clampBlockerDetail(detail: string): string {
	const oneLine = detail.replace(/\s+/g, " ").trim();
	return oneLine.length > BLOCKER_DETAIL_CHARS
		? `${oneLine.slice(0, BLOCKER_DETAIL_CHARS - 1).trimEnd()}…`
		: oneLine;
}

/**
 * The blocker the child declared on its first line, or the one its text
 * plainly carries. `null` for an ordinary answer. Call with marker-free text.
 */
export function parseDelegationBlocker(
	text: string | null | undefined,
): DelegationBlocker | null {
	if (!text) return null;
	const firstLine = text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	const declared = firstLine ? BLOCKED_LINE_RE.exec(firstLine) : null;
	if (declared?.[1] && declared[2]) {
		return {
			kind: declared[1].toLowerCase() as DelegationBlockerKind,
			detail: clampBlockerDetail(declared[2]),
			source: "declared",
		};
	}
	const head = text.slice(0, INFERRED_HEAD_CHARS);
	const noProgress = NO_PROGRESS_RE.test(head);
	for (const candidate of INFERRED_BLOCKERS) {
		if (!candidate.match.test(head)) continue;
		if (!candidate.standalone && !noProgress) continue;
		return {
			kind: candidate.kind,
			detail: candidate.detail,
			source: "inferred",
		};
	}
	return null;
}

/** Read a persisted blocker record back; any other shape is `null`. */
export function delegationBlockerFromRecord(
	value: unknown,
): DelegationBlocker | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const kind = record.kind;
	const detail = typeof record.detail === "string" ? record.detail.trim() : "";
	if (
		typeof kind !== "string" ||
		!(DELEGATION_BLOCKER_KINDS as readonly string[]).includes(kind) ||
		!detail
	)
		return null;
	return {
		kind: kind as DelegationBlockerKind,
		detail,
		source: record.source === "inferred" ? "inferred" : "declared",
	};
}

/** The text without its technical block; every other marker is kept. */
export function stripTechnicalReport(text: string): string {
	return text.replace(new RegExp(TECHNICAL_REPORT_RE.source, "g"), "").trim();
}

/**
 * The engineer-facing part of a child's final report, which the runtime keeps
 * behind `[technical-report]` markers. `null` when the text carries none.
 */
export function extractTechnicalReport(
	text: string | null | undefined,
): string | null {
	if (!text) return null;
	const parts: string[] = [];
	for (const match of text.matchAll(
		new RegExp(TECHNICAL_REPORT_RE.source, "g"),
	)) {
		const body = match[1]?.trim();
		if (body) parts.push(body);
	}
	return parts.length ? parts.join("\n\n") : null;
}

const EARLY_STOP_MARKER_RE = /\[Turn stopped early:\s*([^\]]*)\]/g;
const TECHNICAL_REPORT_RE =
	/\[technical-report\]\s*([\s\S]*?)\s*\[\/technical-report\]/g;
const PARTIAL_RESULT_HEADER_RE = /\[partial-result\]\s*(?:stopReason=[^\n]*)?/g;
const TRUNCATION_MARKER_RE = /\[(?:assistant|tool) result truncated\]/g;
const EMPTY_ASSISTANT_SENTINEL_RE = /^\s*empty_assistant_message\s*$/i;
const REPORTED_PARTIAL_RE =
	/^\s*(?:\*{1,2})?Partial(?:\s+result)?\s*(?::|—|-)/i;
// Existing terminal-refusal vocabulary, restricted to the latest answer's start.
const REPORTED_REFUSAL_RE =
	/^(?:[\s#*>`🔴⛔❌]|⚠\uFE0F?)*(?:(?:Status|Outcome):\s*[*`]*\s*(?:Blocked|(?:403\s+)?Forbidden|Execution\s+(?:blocked|denied))\b|(?:Blocked(?:\s+fail-closed)?|(?:403\s+)?Forbidden)\s*:|Execution\s+(?:blocked|denied)\b)/iu;

const STRUCTURED_STOP_REASONS = new Set([
	"budget_exhausted",
	"step_ceiling",
	"context_ceiling",
	// A definitely non-retryable provider fault sealed by the durable turn
	// (`provider-error-settlement.ts`) rather than re-driven.
	"provider_error",
]);

const STRUCTURED_STOP_LABELS: Record<string, string> = {
	budget_exhausted: "inference token budget exhausted mid-turn",
	step_ceiling: "per-turn provider-call ceiling reached",
	context_ceiling: "per-turn cumulative input-token ceiling reached",
	provider_error: "provider error sealed the turn",
};

/** Whether `value` is a runtime-owned structured stop reason (not model prose). */
export function isStructuredDelegatedStopReason(
	value: string | null | undefined,
): value is string {
	return typeof value === "string" && STRUCTURED_STOP_REASONS.has(value);
}

/**
 * Remove every marker the runtime or the kernel injects into assistant text
 * so that what remains is what the tedi actually wrote.
 */
export function stripSyntheticMarkers(text: string): string {
	return text
		.replace(EARLY_STOP_MARKER_RE, "")
		.replace(TECHNICAL_REPORT_RE, "")
		.replace(PARTIAL_RESULT_HEADER_RE, "")
		.replace(TRUNCATION_MARKER_RE, "")
		.replace(EMPTY_ASSISTANT_SENTINEL_RE, "")
		.trim();
}

/** Whether assistant text carries anything beyond synthetic markers. */
export function hasDelegatedOutput(text: string | null | undefined): boolean {
	return typeof text === "string" && stripSyntheticMarkers(text).length > 0;
}

export type EarlyStopMarker = {
	/** Reason id inferred from the marker wording. */
	stopReason: string;
	/** The reason phrase without the runtime's trailing boilerplate or counters. */
	reason: string;
	steps: number | null;
};

/** Parse the runtime's `[Turn stopped early: <reason>. Partial results above; …]` notice. */
export function parseEarlyStopMarker(
	text: string | null | undefined,
): EarlyStopMarker | null {
	if (!text) return null;
	const match = new RegExp(EARLY_STOP_MARKER_RE.source).exec(text);
	if (!match?.[1]) return null;
	const full = match[1].trim();
	const raw = full
		.replace(/\.\s*Partial results above;.*$/is, "")
		.replace(/\.\s*$/, "")
		.trim();
	const stepsMatch =
		/\bover\s+(\d+)\s+steps?\b/i.exec(raw) ??
		/\((\d+)\/\d+\s+steps?\)/i.exec(raw);
	const steps = stepsMatch?.[1] ? Number.parseInt(stepsMatch[1], 10) : null;
	const reason = raw.replace(/\s*\([^)]*\)\s*$/, "").trim() || full;
	const stopReason = /input-token ceiling/i.test(reason)
		? "context_ceiling"
		: /provider-call ceiling/i.test(reason)
			? "step_ceiling"
			: /budget exhausted/i.test(reason)
				? "budget_exhausted"
				: /provider error/i.test(reason)
					? "provider_error"
					: "early_stop";
	return { stopReason, reason, steps: Number.isFinite(steps) ? steps : null };
}

function stopDetail(input: { reason: string; steps: number | null }): string {
	return input.steps !== null
		? `Stopped after ${input.steps} ${input.steps === 1 ? "step" : "steps"}: ${input.reason}`
		: `Stopped early: ${input.reason}`;
}

/**
 * Classify a terminal child run. Returns `null` when nothing indicates an
 * early stop or a reported partial — the caller then applies its ordinary
 * completed/failed disposition.
 */
export function classifyDelegatedStop(input: {
	assistantText: string | null | undefined;
	structuredStopReason: string | null | undefined;
	/**
	 * The work order's verify command, when one was requested. A final text
	 * that lacks the `Verification output:` section is then a partial with
	 * `stopReason: "verification_missing"` — the child never proved its claim.
	 */
	verifyCommand?: string | null;
}): DelegatedStopClassification | null {
	const text = input.assistantText ?? "";
	const marker = parseEarlyStopMarker(text);
	const output = stripSyntheticMarkers(text);
	const reportedPartial = REPORTED_PARTIAL_RE.test(output);
	const reportedRefusal = REPORTED_REFUSAL_RE.test(output);
	const structured = isStructuredDelegatedStopReason(input.structuredStopReason)
		? input.structuredStopReason
		: null;
	const verifyCommand = input.verifyCommand?.trim() || null;
	// A declared or plainly carried blocker outranks the stop mechanics: a
	// child that could not start is blocked whether or not it also ran into a
	// ceiling while trying, and its text is a report of the gap, not output.
	const blocker = parseDelegationBlocker(output);
	if (blocker) {
		return {
			outcome: "failed",
			stopReason: BLOCKED_STOP_REASON,
			detail: blocker.detail,
			steps: marker?.steps ?? null,
			output,
			blocker,
		};
	}
	if (!structured && !marker && reportedRefusal) {
		return {
			outcome: "failed",
			stopReason: "reported_refusal",
			detail: "The tedi reported that execution was blocked or denied",
			steps: null,
			output,
		};
	}
	if (!structured && !marker && !reportedPartial) {
		if (!verifyCommand || hasVerificationOutput(output)) return null;
		return {
			outcome: output.length > 0 ? "partial" : "failed",
			stopReason: VERIFICATION_MISSING_STOP_REASON,
			detail: `verification output missing (required: ${verifyCommand})`,
			steps: null,
			output,
		};
	}
	const stopReason = structured ?? marker?.stopReason ?? "reported_partial";
	const detail = marker
		? stopDetail(marker)
		: structured
			? stopDetail({
					reason: STRUCTURED_STOP_LABELS[structured] ?? structured,
					steps: null,
				})
			: "The tedi reported a partial result";
	return {
		outcome: output.length > 0 ? "partial" : "failed",
		stopReason,
		detail,
		steps: marker?.steps ?? null,
		output,
	};
}

/**
 * Recover the stop classification from a child-run summary or a persisted
 * run-metadata record (`childRunStatus` / `childRunStopReason` /
 * `childRunStopDetail` / `childRunPreview`). Older rows persisted `partial`
 * for a marker-only stop; re-reading the preview corrects them on read.
 */
export function delegatedStopFromSummary(
	summary: Record<string, unknown> | null | undefined,
): DelegatedStopClassification | null {
	if (!summary) return null;
	const status = summary.childRunStatus;
	const stopReason =
		typeof summary.childRunStopReason === "string"
			? summary.childRunStopReason
			: null;
	const preview =
		typeof summary.childRunPreview === "string"
			? summary.childRunPreview
			: null;
	if (status !== "partial" && !stopReason) return null;
	const classified = classifyDelegatedStop({
		assistantText: preview,
		structuredStopReason: stopReason,
	});
	const persistedDetail =
		typeof summary.childRunStopDetail === "string"
			? summary.childRunStopDetail
			: null;
	const persistedBlocker = delegationBlockerFromRecord(summary.childRunBlocker);
	if (classified) {
		return {
			...classified,
			...(persistedDetail ? { detail: persistedDetail } : {}),
			...(persistedBlocker && !classified.blocker
				? {
						blocker: persistedBlocker,
						stopReason: BLOCKED_STOP_REASON,
						outcome: "failed" as const,
					}
				: {}),
		};
	}
	// A persisted blocker whose preview was clamped past the declaring line
	// still reaches Home as data.
	if (persistedBlocker || stopReason === BLOCKED_STOP_REASON) {
		return {
			outcome: "failed",
			stopReason: BLOCKED_STOP_REASON,
			detail:
				persistedDetail ??
				persistedBlocker?.detail ??
				"The tedi could not proceed",
			steps: null,
			output: preview ? stripSyntheticMarkers(preview) : "",
			blocker: persistedBlocker,
		};
	}
	// A persisted `partial` whose preview never carried a marker (a reported
	// partial clamped out of the preview, or no preview at all) keeps its label
	// unless the preview is present and empty of anything but markers.
	return {
		outcome:
			preview !== null && !hasDelegatedOutput(preview) ? "failed" : "partial",
		stopReason: stopReason ?? "reported_partial",
		detail: persistedDetail ?? "The tedi reported a partial result",
		steps: null,
		output: preview ? stripSyntheticMarkers(preview) : "",
	};
}
