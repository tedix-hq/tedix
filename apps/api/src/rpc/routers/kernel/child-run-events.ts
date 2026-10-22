import type { HomeChildRunStatus } from "@tedix/api-contract/schemas/kernel-runtime";
import type { TediRuntimeEventRow } from "@tedix/db/queries/kernel-runtime-events";
import {
	classifyDelegatedStop,
	declaredDelegationOutcome,
} from "./delegated-stop";
import {
	nonNullRecord,
	numberFromPayload,
	stringFromPayload,
} from "./runtime-shared";

/**
 * Derive a short human-readable activity label from the latest meaningful
 * child runtime event (DESC-ordered rows, so rows[0] is most recent).
 *
 * Priority (first match on newest event wins):
 *   tool.started / tool.completed / tool.failed → "calling <name>"
 *   message.delta → "responding…"
 *   step.completed with toolNames → "calling <last tool>"
 *   message.received → "reading the task"
 *   context.injected → "loading context…"
 *   run.started → "thinking…"
 *   subagent.started → "delegating…"
 *   artifact.created → "writing <name>" (truncated 35)
 *   message.completed (latest, run still live) → "wrapping up…"
 * Returns null when no meaningful event is found (fail-soft).
 */
export function latestActivityLabelFromEvents(
	rows: TediRuntimeEventRow[],
): string | null {
	for (const row of rows) {
		if (
			row.kind === "tool.started" ||
			row.kind === "tool.completed" ||
			row.kind === "tool.failed"
		) {
			const payload = nonNullRecord(row.payload);
			const name = typeof payload?.name === "string" ? payload.name : null;
			if (name) {
				// Truncate long MCP-namespaced tool names to keep the panel tight.
				const label = name.length > 36 ? `${name.slice(0, 35)}…` : name;
				return `calling ${label}`;
			}
		}
		if (row.kind === "message.progress") {
			// T1.1 heartbeat: the model is mid-generation (synthesizing its reply)
			// during the post-tool window before the first message.delta lands. This
			// keeps the live panel legible instead of frozen on the last tool name.
			return "synthesizing…";
		}
		if (row.kind === "message.delta") {
			return "responding…";
		}
		if (row.kind === "step.completed") {
			const payload = nonNullRecord(row.payload);
			const toolNames = Array.isArray(payload?.toolNames)
				? (payload.toolNames as unknown[]).filter(
						(n): n is string => typeof n === "string",
					)
				: [];
			const lastName = toolNames.at(-1);
			if (lastName) {
				const label =
					lastName.length > 36 ? `${lastName.slice(0, 35)}…` : lastName;
				return `calling ${label}`;
			}
		}
		if (row.kind === "message.received") {
			return "reading the task";
		}
		if (row.kind === "context.injected") {
			return "loading context…";
		}
		if (row.kind === "run.started") {
			return "thinking…";
		}
		if (row.kind === "subagent.started") {
			return "delegating…";
		}
		if (row.kind === "artifact.created") {
			const payload = nonNullRecord(row.payload);
			const artifactRecord = nonNullRecord(payload?.artifact);
			const artifactLabel =
				typeof artifactRecord?.name === "string" && artifactRecord.name.trim()
					? artifactRecord.name.trim()
					: null;
			if (artifactLabel) {
				const truncated =
					artifactLabel.length > 35
						? `${artifactLabel.slice(0, 35)}…`
						: artifactLabel;
				return `writing ${truncated}`;
			}
			return "writing artifact";
		}
		if (row.kind === "message.completed") {
			// Only emit "wrapping up…" for in-progress runs — not as the terminal
			// post-hoc record label. Rows are DESC-ordered; message.completed as the
			// latest event (before any run.completed) means the run is still settling.
			return "wrapping up…";
		}
	}
	return null;
}

/**
 * Coerce a child-run result candidate into the structured JSON value the Tedix OS's
 * typed-card detectors render — or `null` when there is no structured value.
 *
 * Accepts (a) a structured JSON value directly (a tool's `payload.data` object/
 * array), or (b) a string that is ENTIRELY one structured JSON object/array,
 * optionally wrapped in a ```json fence or single/double backticks (the shape a
 * child tedi emits when its FINAL assistant message IS structured JSON). Bare
 * prose, a primitive, or partial/malformed JSON returns `null`.
 *
 * This intentionally mirrors the Tedix OS consumer's `unwrapStructuredPayload`
 * (consumed by the browser typed-tool cards): the producer must only mint the
 * `Raw result: …` envelope for payloads the consumer will actually accept and
 * card, never wrap arbitrary prose as fake JSON.
 */
export function structuredResultValue(candidate: unknown): unknown {
	if (candidate !== null && typeof candidate === "object") return candidate;
	if (typeof candidate !== "string") return null;
	let rest = candidate.trim();
	if (!rest) return null;
	// Strip a single ```json/```jsonc/```json5 (or bare ```) fence, else a single-
	// or double-backtick inline wrapper. Mirrors FENCE_RE / INLINE_BACKTICK_RE on
	// the consumer; anything else (a prefixed string, double fence) is left for
	// JSON.parse to reject.
	if (rest.startsWith("```")) {
		const fence =
			/^```[ \t]*(?:json|jsonc|json5)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(rest);
		if (!fence) return null;
		rest = (fence[1] ?? "").trim();
	} else {
		const inline = /^(`{1,2})([\s\S]*?)\1$/.exec(rest);
		if (inline) rest = (inline[2] ?? "").trim();
	}
	const first = rest[0];
	if (first !== "{" && first !== "[") return null; // structured payloads only
	let parsed: unknown;
	try {
		parsed = JSON.parse(rest) as unknown;
	} catch {
		return null; // malformed / partial / trailing junk → not structured
	}
	if (parsed === null || typeof parsed !== "object") return null;
	return parsed;
}

/**
 * The canonical `` Raw result: `{json}` `` envelope the Tedix OS delegation-receipt
 * detector unwraps (`boundedRawResultOutput` → `unwrapRawResultEnvelope`) to
 * render a typed plan/test/diff/structured card, or `null` when `value` is not
 * a structured JSON value.
 *
 * A ```json fence is used (not an inline backtick) because the minified JSON can
 * itself contain a backtick, which would unbalance the inline-backtick wrapper;
 * the fence's body is parsed verbatim by the consumer. The output is verified to
 * round-trip through the SAME accept gate the Tedix OS applies before it is emitted,
 * so a non-round-tripping payload degrades to the prose fallback instead of
 * shipping an envelope the consumer would silently drop.
 */
function rawResultEnvelope(candidate: unknown): string | null {
	const structured = structuredResultValue(candidate);
	if (structured === null) return null;
	let json: string;
	try {
		json = JSON.stringify(structured);
	} catch {
		return null; // non-serializable (cycles) → prose fallback
	}
	if (!json || (json[0] !== "{" && json[0] !== "[")) return null;
	const envelope = `Raw result: \`\`\`json\n${json}\n\`\`\``;
	// Self-check: only ship an envelope the consumer's accept gate re-derives, so
	// the producer can never drift from `unwrapStructuredPayload`.
	if (structuredResultValue(envelope.slice("Raw result: ".length)) === null) {
		return null;
	}
	return envelope;
}

/**
 * Prefer the child's own final assistant message (`rawPreview`) as the
 * operator-facing preview — the tedi's conclusion is the answer, and it must
 * not be buried under an intermediate tool payload (e.g. a discovery listing).
 * When that message is itself one structured JSON value it ships as the
 * canonical `Raw result:` envelope so the Tedix OS typed-card detector activates;
 * prose ships verbatim — never wrapped as fake JSON. Only when there is no
 * message content at all does the most-recent structured, non-error
 * `tool.completed` result stand in as the envelope fallback.
 */
/**
 * Returns true when a `tool.completed` result value represents an engine-level
 * error that should NOT be shown as a structured answer — `Execution error:`,
 * `timed out`, etc.
 */
export function isToolErrorString(value: unknown): boolean {
	if (typeof value !== "string") return false;
	return /^Execution error:|^timed out|timed out after/i.test(value.trim());
}

/**
 * Render a tool-error string as a concise, operator-facing one-liner — no raw
 * scope prefixes, no Cloudflare-internal POST URLs. Max 120 chars of context.
 */
function humanizeToolError(raw: string): string {
	// Strip leading engine prefix to expose the root cause.
	const stripped = raw
		.trim()
		.replace(/^Execution error:\s*/i, "")
		.trim();
	// Remove raw HTTP lines ("POST https://..." or "503 Service Unavailable").
	const cleaned = stripped
		.replace(/\n?(POST|GET|PUT|PATCH|DELETE)\s+https?:\/\/\S+/gi, "")
		.replace(/\n?\d{3}\s+\S[^\n]*/g, "")
		.trim();
	const excerpt = cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
	return `Tool step errored: ${excerpt}`;
}

/**
 * Humanize a run.failed terminal payload to an operator-facing preview string.
 * Strips raw 503/Cloudflare-internal POST URLs from any message before showing.
 */
function humanizeRunFailedPayload(
	payload: Record<string, unknown>,
): string | null {
	const reason =
		stringFromPayload(payload.reason) ??
		stringFromPayload(payload.terminalReason);
	if (reason === "runtime_dropped") {
		return "The tedi runtime dropped this run before it finished — retry.";
	}
	const recoveryReason = stringFromPayload(
		nonNullRecord(payload.recovery)?.reason,
	);
	const recoveryMessage = humanizeRecoveryFailureReason(
		recoveryReason ?? (reason === "recovery_exhausted" ? undefined : reason),
	);
	if (recoveryMessage) return recoveryMessage;
	const message =
		stringFromPayload(payload.message) ??
		stringFromPayload(payload.error) ??
		(reason !== undefined ? reason : null);
	if (!message) return null;
	// Strip raw POST/GET lines and bare HTTP status codes.
	const cleaned = message
		.replace(/\n?(POST|GET|PUT|PATCH|DELETE)\s+https?:\/\/\S+/gi, "")
		.replace(/\n?\d{3}\s+\S[^\n]*/g, "")
		.trim();
	if (!cleaned) return null;
	return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}

function humanizeRecoveryFailureReason(
	reason: string | undefined,
): string | null {
	switch (reason) {
		case "out_of_memory":
			return "The tedi exceeded the Durable Object memory limit while recovering this turn.";
		case "work_budget_exceeded":
			return "The recovery loop kept making progress but did not converge.";
		case "no_progress_timeout":
			return "The recovery loop stopped making progress.";
		default:
			return null;
	}
}

/**
 * Returns true when the child run produced a structured (non-error) result via
 * a tool.completed event — even with no final assistant message. This prevents
 * a tool-only success from being downgraded to "failed" by the disposition gate.
 */
function hasStructuredToolResult(rows: TediRuntimeEventRow[]): boolean {
	return rows.some((row) => {
		if (row.kind !== "tool.completed") return false;
		const payload = nonNullRecord(row.payload);
		const candidate = payload?.data ?? payload?.result;
		if (isToolErrorString(candidate)) return false;
		return structuredResultValue(candidate) !== null;
	});
}

type KernelWorkflowInspection = {
	status: string;
	workflowRunId: string;
	workflowSlug: string;
	workflowTediId: string | null;
};

/**
 * Project the stable identity of a workflow inspection from a delegated tool
 * result into Home run metadata. This is deliberately narrower than the full
 * inspection payload: the Tedix OS fetches current steps/artifacts from its status
 * endpoint, while the transcript only needs enough identity to mount that
 * live card. Never parse the child's prose response for these fields.
 */
export function workflowInspectionFromEvents(
	rows: TediRuntimeEventRow[],
): KernelWorkflowInspection | null {
	for (const row of rows) {
		if (row.kind !== "tool.completed") continue;
		const payload = nonNullRecord(row.payload);
		const result = [payload?.data, payload?.result, payload?.resultIdentity]
			.map((candidate) => nonNullRecord(structuredResultValue(candidate)))
			.find((candidate) => candidate !== undefined);
		const statusResult = nonNullRecord(result?.status);
		const inspection = nonNullRecord(result?.inspection);
		const inspectionRun = nonNullRecord(inspection?.run);
		const revision = nonNullRecord(inspection?.revision);
		const statusRunId = stringFromPayload(statusResult?.id);
		const inspectionRunId = stringFromPayload(inspectionRun?.id);
		const workflowRunId = statusRunId ?? inspectionRunId;
		const workflowSlug = stringFromPayload(revision?.skillSlug);
		if (
			!workflowRunId ||
			!workflowSlug ||
			(statusRunId && inspectionRunId && statusRunId !== inspectionRunId)
		) {
			continue;
		}
		return {
			status:
				stringFromPayload(statusResult?.status) ??
				stringFromPayload(inspectionRun?.status) ??
				"unknown",
			workflowRunId,
			workflowSlug,
			workflowTediId:
				stringFromPayload(statusResult?.tediId) ??
				stringFromPayload(inspectionRun?.tediId) ??
				null,
		};
	}
	return null;
}

export function childRunPreviewFromEvents(
	rows: TediRuntimeEventRow[],
	rawPreview: string | null,
): string | null {
	// 1) The child's own message content is the operator-facing answer and wins
	//    over intermediate tool payloads. Structured-JSON message content ships
	//    as the canonical envelope (typed card); prose ships verbatim.
	const prosePreview =
		rawPreview !== null && rawPreview.trim().length > 0 ? rawPreview : null;
	if (prosePreview !== null) {
		return rawResultEnvelope(prosePreview) ?? prosePreview;
	}
	// 2) No message content — among all tool.completed rows (DESC-createdAt),
	//    fall back to the most-recent STRUCTURED, non-error result. The naive
	//    `.find()` on the first row grabs whatever ran last — on a multi-tool
	//    turn that is frequently an intermediate "Execution error:" or timeout
	//    string rather than the substantive answer. Some runtime event producers
	//    carry the value under `payload.data`; Agent runtime's MCP-client
	//    emitter (`recordToolEvent`) carries it as a JSON string under
	//    `payload.result`. We read `data ?? result` for both shapes.
	const toolRows = rows.filter((row) => row.kind === "tool.completed");
	let firstToolError: string | null = null;
	for (const row of toolRows) {
		const payload = nonNullRecord(row.payload);
		const candidate = payload?.data ?? payload?.result;
		if (isToolErrorString(candidate)) {
			// Track the most-recent error in case we need to fall back to it.
			if (firstToolError === null && typeof candidate === "string") {
				firstToolError = candidate;
			}
			continue; // skip; prefer a successful structured result further in DESC order
		}
		const envelope = rawResultEnvelope(candidate);
		if (envelope) return envelope;
	}
	// 3) Only tool errors and no message content → a humanized error one-liner
	//    rather than raw engine internals.
	if (firstToolError !== null) {
		return humanizeToolError(firstToolError);
	}
	// 4) Nothing substantive → preserve the raw (empty/whitespace) preview as-is.
	return rawPreview;
}

function hasSubstantiveChildRunResult(
	rows: TediRuntimeEventRow[],
	preview: string | null,
): boolean {
	return (
		(preview !== null && preview.trim().length > 0) ||
		rows.some(
			(row) =>
				row.kind === "message.completed" || row.kind === "artifact.created",
		) ||
		// A child that produced its answer solely via a structured tool.completed
		// (no final assistant message) still counts as substantive — prevents a
		// tool-only success from being downgraded to "failed" by the disposition gate.
		hasStructuredToolResult(rows)
	);
}

type WorkstationProcessOutcomeFromArtifact = {
	eventType: string;
	preview: string;
	status: Extract<HomeChildRunStatus, "completed" | "failed" | "canceled">;
};

function workstationProcessTerminalStatus(
	eventType: string | undefined,
	metadata: Record<string, unknown> | undefined,
): WorkstationProcessOutcomeFromArtifact["status"] | null {
	if (eventType === "workstation.process.completed") return "completed";
	if (eventType === "workstation.process.failed") return "failed";
	if (eventType === "workstation.process.timed_out") return "failed";
	if (eventType === "workstation.process.canceled") return "canceled";
	if (
		metadata &&
		(metadata.source === "workstation_process" ||
			metadata.subKind === "workstation_process")
	) {
		if (metadata.canceled === true) return "canceled";
		if (metadata.timedOut === true) return "failed";
		const exitCode = numberFromPayload(metadata.exitCode);
		if (exitCode === 0) return "completed";
		if (exitCode !== undefined) return "failed";
	}
	return null;
}

export function workstationProcessOutcomeFromArtifactEvent(
	row: TediRuntimeEventRow,
): WorkstationProcessOutcomeFromArtifact | null {
	if (row.kind !== "artifact.created") return null;
	const payload = nonNullRecord(row.payload);
	const artifact = nonNullRecord(payload?.artifact);
	const metadata =
		nonNullRecord(artifact?.metadata) ?? nonNullRecord(payload?.metadata);
	const eventType =
		stringFromPayload(metadata?.eventType) ??
		stringFromPayload(payload?.eventType);
	const status = workstationProcessTerminalStatus(eventType, metadata);
	if (!status) return null;
	const processId =
		stringFromPayload(metadata?.processId) ??
		stringFromPayload(payload?.processId);
	const artifactName = stringFromPayload(artifact?.name);
	const detail = processId
		? `process ${processId}`
		: artifactName
			? `artifact ${artifactName}`
			: "workstation process";
	const outcome =
		status === "completed"
			? "completed"
			: status === "canceled"
				? "canceled"
				: eventType === "workstation.process.timed_out"
					? "timed out"
					: "failed";
	return {
		eventType: eventType ?? `workstation.process.${outcome}`,
		preview: `Workstation ${detail} ${outcome}; subprocess artifact evidence is available.`,
		status,
	};
}

/** Event rows are newest-first. Never borrow an older answer when the final is empty. */
export function latestFinalAssistantContent(
	rows: TediRuntimeEventRow[],
): string | null {
	const final = rows.find(
		(row) =>
			row.kind === "message.completed" &&
			(nonNullRecord(row.payload)?.role === undefined ||
				nonNullRecord(row.payload)?.role === "assistant"),
	);
	const content = nonNullRecord(final?.payload)?.content;
	return typeof content === "string" ? content.trim() : null;
}

export function summarizeChildRuntimeEvents(
	rows: TediRuntimeEventRow[],
	options: {
		/** The parent work order's verify command; a success without `Verification output:` is partial. */
		verifyCommand?: string | null;
	} = {},
): Record<string, unknown> | null {
	if (rows.length === 0) return null;
	const terminal = rows.find(
		(row) =>
			row.kind === "run.completed" ||
			row.kind === "run.failed" ||
			row.kind === "run.canceled",
	);
	// Prefer completed over failed/canceled when both events exist for the same
	// run_id (race: transient failed superseded by a real completed). Events are
	// DESC-ordered so this is a secondary safety net, not the primary mechanism.
	const hasCompletionEvent = rows.some((row) => row.kind === "run.completed");
	const completedPayload = nonNullRecord(
		rows.find((row) => row.kind === "run.completed")?.payload,
	);
	const structuredStopReason =
		stringFromPayload(completedPayload?.stopReason) ?? null;
	// A workstation process artifact describes one subprocess, not the delegated
	// child run. Keep it visible as progress/evidence, but only a canonical
	// run.completed/run.failed/run.canceled event may settle the child.
	const workstationOutcome = rows
		.map(workstationProcessOutcomeFromArtifactEvent)
		.find((candidate) => candidate !== null);
	const hasPendingApproval =
		rows.some((row) => row.kind === "approval.requested") &&
		!rows.some((row) => row.kind === "approval.resolved");
	const latest = rows[0];
	// Keep Home-plan delegation previews aligned with direct delegation: only
	// accept assistant messages.
	const latestMessage = rows.find((row) => {
		if (row.kind !== "message.completed" && row.kind !== "message.delta") {
			return false;
		}
		const payload = nonNullRecord(row.payload);
		return payload?.role === undefined || payload.role === "assistant";
	});
	const latestPayload = nonNullRecord(latest?.payload);
	const messagePayload = nonNullRecord(latestMessage?.payload);
	const rawPreview =
		latestMessage?.delta ??
		stringFromPayload(messagePayload?.content) ??
		stringFromPayload(messagePayload?.text) ??
		stringFromPayload(latestPayload?.content) ??
		stringFromPayload(latestPayload?.text) ??
		null;
	// A runtime stop (structured reason or the `[Turn stopped early: …]`
	// marker) or a self-reported partial. It is `partial` only when the child
	// wrote something besides the markers; a marker-only stop produced no
	// output and is `failed`, carrying the stop reason so Home can say why.
	const stop =
		terminal?.kind === "run.completed"
			? classifyDelegatedStop({
					assistantText: latestFinalAssistantContent(rows) ?? rawPreview,
					structuredStopReason,
					verifyCommand: options.verifyCommand ?? null,
				})
			: null;
	// Latest live-activity label for the CLI panel ("calling <tool>", "responding…").
	// Derived from the most-recent meaningful event; null when no event qualifies.
	const latestActivityLabel = latestActivityLabelFromEvents(rows);
	const kernelWorkflowInspect = workflowInspectionFromEvents(rows);
	const status =
		terminal?.kind === "run.completed"
			? stop
				? stop.outcome
				: // Disposition gate: a bare run.completed with no substantive result
					// (dropped-runtime / succeededLost shape) is NOT a clean completion —
					// the child produced no answer, so treat it as failed to surface the
					// gap rather than returning an empty work card.
					hasSubstantiveChildRunResult(rows, rawPreview)
					? "completed"
					: "failed"
			: terminal?.kind === "run.failed"
				? // Race guard: if a run.completed also exists, completed wins.
					hasCompletionEvent
					? "completed"
					: "failed"
				: terminal?.kind === "run.canceled"
					? "canceled"
					: hasPendingApproval
						? "requires_approval"
						: rows.some((row) => row.kind === "message.delta")
							? "streaming"
							: // A bounded recent window can lose run.started while the
								// same child continues executing tools and model steps.
								rows.some(
										(row) =>
											row.kind === "run.started" ||
											row.kind === "tool.started" ||
											row.kind === "tool.completed" ||
											row.kind === "tool.failed" ||
											row.kind === "step.completed",
								  )
								? "running"
								: "queued";
	// For run.failed, prefer a humanized preview from the terminal payload so the
	// orphan-sweep runtime drop no longer renders as a causeless "child run failed".
	const terminalPayload =
		terminal?.kind === "run.failed"
			? nonNullRecord(terminal.payload)
			: undefined;
	const failedPreview = terminalPayload
		? humanizeRunFailedPayload(terminalPayload)
		: null;
	return {
		childRunEventCount: rows.length,
		childRunLatestEventAt: latest?.createdAt ?? null,
		childRunLatestEventKind: latest?.kind ?? null,
		// Short live-activity label for the CLI panel (e.g. "calling workers_builds…").
		// Null when no meaningful activity event is present (fail-soft).
		childRunLatestActivityLabel: latestActivityLabel,
		// Prefer the canonical `Raw result: …` envelope for a structured child
		// result so the Tedix OS typed-card detector activates; prose otherwise.
		// For run.failed with no other content, use the humanized failure reason.
		childRunPreview:
			failedPreview !== null && rawPreview === null
				? failedPreview
				: workstationOutcome && rawPreview === null
					? workstationOutcome.preview
					: stop?.outcome === "failed" && !stop.output
						? `No output was produced. ${stop.detail}`
						: childRunPreviewFromEvents(rows, rawPreview),
		childRunStatus: status,
		childTaskOutcome: declaredDelegationOutcome(
			latestFinalAssistantContent(rows),
		),
		childRunStopReason: stop?.stopReason ?? null,
		...(stop ? { childRunStopDetail: stop.detail } : {}),
		childRunTerminalAt: terminal?.createdAt ?? null,
		childRunTerminalEventKind: terminal?.kind ?? null,
		...(kernelWorkflowInspect ? { kernelWorkflowInspect } : {}),
	};
}
