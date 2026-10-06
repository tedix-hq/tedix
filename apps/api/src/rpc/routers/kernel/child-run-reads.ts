/**
 * Kernel — delegated child-run reads. Projects child tedi runtime events into
 * activity labels, previews, evidence rows, single-run summaries, full results,
 * and the fan-out child-run tree. This module must NOT import kernel-runtime.ts
 * (the router imports this module; a value import back would create a cycle).
 */

import type {
	HomeChildRunStatus,
	HomeChildRunTree,
	HomeChildRunTreeNode,
	HomeRun,
} from "@tedix/api-contract/schemas/kernel-runtime";
import {
	getChatDispatchMappingByIdempotencyKey,
	listTediArtifacts,
	listTediRuntimeEvents,
	type TediArtifactRow,
	type TediRuntimeEventRow,
} from "@tedix/db/queries/kernel-runtime-events";
import type { KernelRuntimeRun } from "@tedix/db/queries/kernel-runtime-runs";
import {
	classifyToolCall,
	hasExecutionEvidence,
	type TurnToolCall,
} from "@tedix/mcp-client-core/tool-liveness";
import { type FanoutSlotRecord, readFanoutSlots } from "@tedix/provisioning";
import type { BaseContext } from "../../orpc";
import {
	hasSuccessfulCompletionEvidence,
	hasTerminalJobCompletionEvidence,
} from "../../../services/runtime-execution-evidence";
import { getProvisioningConfig } from "../tedis/helpers";
import {
	classifyDelegatedStop,
	declaredDelegationOutcome,
	type DeclaredDelegationOutcome,
	type DelegatedStopClassification,
	isStructuredDelegatedStopReason,
} from "./delegated-stop";
import {
	childRunStatusFromSummary,
	errorMessage,
	isRemoteD1TransportError,
	latestIso,
	nonNullRecord,
	numberFromPayload,
	shouldFailSoftChildEvidenceRead,
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
function structuredResultValue(candidate: unknown): unknown {
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
function isToolErrorString(value: unknown): boolean {
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
function latestFinalAssistantContent(
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

export type ChildRunEvidenceRows = {
	artifactRows: TediArtifactRow[];
	eventRows: TediRuntimeEventRow[];
	observedRunIds: string[];
};

/**
 * Extra attempts (beyond the first) for a TRANSIENT remote-D1 transport error.
 * Evidence rows for a delegated run are correctly keyed by the stored
 * childRunId (verified against production D1 for the
 * `{tediId}:mcp:{homeRunId}_auto_{tediId}` auto-dispatch shape) — when a read
 * comes back empty-with-error it is a transport flake, not missing data, so a
 * bounded in-request retry heals it instead of rendering "No evidence yet"
 * over a fully-populated ledger.
 */
const TRANSIENT_D1_RETRY_ATTEMPTS = 2;

async function withTransientD1Retry<T>(read: () => Promise<T>): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= TRANSIENT_D1_RETRY_ATTEMPTS; attempt += 1) {
		try {
			return await read();
		} catch (error) {
			if (!isRemoteD1TransportError(error)) throw error;
			lastError = error;
		}
	}
	throw lastError;
}

async function readMappedWorkstationRunIds(
	context: BaseContext,
	ref: { runId: string; tediId: string },
): Promise<string[]> {
	try {
		const mapping = await withTransientD1Retry(() =>
			getChatDispatchMappingByIdempotencyKey(context.db, ref.runId),
		);
		const mappedRunId = mapping?.runId;
		if (!mappedRunId || mappedRunId === ref.runId) return [];
		return [mappedRunId];
	} catch (error) {
		// Fail-soft: a transport flake on the OPTIONAL workstation mapping must
		// not sink the whole evidence read — the primary childRunId query still
		// runs. Non-transient errors propagate.
		if (!shouldFailSoftChildEvidenceRead(error)) throw error;
		console.warn("[kernelRuntime] workstation run-id mapping read failed", {
			error: errorMessage(error),
			runId: ref.runId,
			tediId: ref.tediId,
		});
		return [];
	}
}

async function resolveObservedChildRunIds(
	context: BaseContext,
	ref: {
		includeMappedWorkstationRun?: boolean;
		runId: string;
		tediId: string;
	},
): Promise<string[]> {
	const ids = [ref.runId];
	if (ref.includeMappedWorkstationRun) {
		for (const mappedRunId of await readMappedWorkstationRunIds(context, ref)) {
			if (!ids.includes(mappedRunId)) ids.push(mappedRunId);
		}
	}
	return ids;
}

export async function readChildRunEvidenceRows(
	context: BaseContext,
	input: {
		artifactLimit: number;
		eventLimit: number;
		includeMappedWorkstationRun?: boolean;
		// When provided, a separate query fetches workstation.egress.* events
		// recorded under the kernel run ID (which differs from childRunId).
		kernelRunId?: string;
		organizationId?: string;
		runId: string;
		tediId: string;
	},
): Promise<ChildRunEvidenceRows & { eventReadAvailable: boolean }> {
	const observedRunIds = await resolveObservedChildRunIds(context, {
		includeMappedWorkstationRun: input.includeMappedWorkstationRun,
		runId: input.runId,
		tediId: input.tediId,
	});
	let eventReadAvailable = true;
	const readEventRows = (async () => {
		try {
			return await withTransientD1Retry(() =>
				listTediRuntimeEvents(context.db, {
					organizationId: input.organizationId,
					tediId: input.tediId,
					runIds: observedRunIds,
					order: "desc",
					limit: input.eventLimit,
				}),
			);
		} catch (error) {
			if (!shouldFailSoftChildEvidenceRead(error)) throw error;
			eventReadAvailable = false;
			console.warn("[kernelRuntime] child runtime event evidence read failed", {
				error: errorMessage(error),
				organizationId: input.organizationId,
				runIds: observedRunIds,
				tediId: input.tediId,
			});
			return [] as TediRuntimeEventRow[];
		}
	})();
	// Egress events are recorded with runId = kernelRunId (the kernel delegation
	// row PK), not childRunId, so they are invisible to the inArray query above.
	// Fetch them separately and merge so denied egress attempts surface as evidence.
	// Egress kind values recorded by tedi-workstation-runtime (cognitive-runtime schema).
	const WORKSTATION_EGRESS_KINDS = [
		"workstation.egress.allow",
		"workstation.egress.deny",
	] as const;
	const kernelRunId = input.kernelRunId;
	const readEgressRows = kernelRunId
		? (async () => {
				try {
					return await withTransientD1Retry(() =>
						listTediRuntimeEvents(context.db, {
							organizationId: input.organizationId,
							tediId: input.tediId,
							runId: kernelRunId,
							kinds: WORKSTATION_EGRESS_KINDS,
							order: "desc",
							limit: input.eventLimit,
						}),
					);
				} catch (error) {
					console.warn(
						"[kernelRuntime] workstation egress event evidence read failed",
						{
							error: errorMessage(error),
							kernelRunId,
							organizationId: input.organizationId,
							tediId: input.tediId,
						},
					);
					return [] as TediRuntimeEventRow[];
				}
			})()
		: Promise.resolve([] as TediRuntimeEventRow[]);
	const readArtifactRows =
		input.artifactLimit > 0
			? (async () => {
					try {
						return await withTransientD1Retry(() =>
							listTediArtifacts(context.db, {
								organizationId: input.organizationId,
								tediId: input.tediId,
								runIds: observedRunIds,
								limit: input.artifactLimit,
							}),
						);
					} catch (error) {
						console.warn(
							"[kernelRuntime] child artifact evidence read failed",
							{
								error: errorMessage(error),
								organizationId: input.organizationId,
								runIds: observedRunIds,
								tediId: input.tediId,
							},
						);
						return [] as TediArtifactRow[];
					}
				})()
			: Promise.resolve([] as TediArtifactRow[]);
	const [eventRows, egressRows, artifactRows] = await Promise.all([
		readEventRows,
		readEgressRows,
		readArtifactRows,
	]);
	// Merge egress events into the main event list, dedup by id, keep DESC order.
	type EventRow = TediRuntimeEventRow;
	let mergedEventRows: EventRow[] = eventRows;
	if (egressRows.length > 0) {
		const seenIds = new Set(eventRows.map((r: EventRow) => r.id));
		const newEgressRows = egressRows.filter(
			(r: EventRow) => !seenIds.has(r.id),
		);
		if (newEgressRows.length > 0) {
			mergedEventRows = [...eventRows, ...newEgressRows].sort(
				(a: EventRow, b: EventRow) =>
					(b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
			);
		}
	}
	return {
		artifactRows,
		eventRows: mergedEventRows,
		observedRunIds,
		eventReadAvailable,
	};
}

/**
 * Read and summarize the child runtime events for a single delegation child run.
 * Returns the `summarizeChildRuntimeEvents` summary (which includes
 * `childRunStatus`, `childRunPreview`, etc.) or null when no events exist or the
 * read fails. Used by the crash-lease sweep in `reconcileStaleSubmissions` to
 * identify fresh child activity and substantive completion before crash-failing
 * a silent delegation parent. The sweep supplies its organization constraint.
 */
export async function readSingleChildRunSummary(
	context: BaseContext,
	ref: { organizationId?: string; tediId: string; runId: string },
): Promise<Record<string, unknown> | null> {
	try {
		const { eventRows } = await readChildRunEvidenceRows(context, {
			artifactLimit: 0,
			eventLimit: 25,
			// Include the mapped workstation run. A workstation child's
			// `...:workstation:...` run-id carries no events itself — they live under
			// the mapped run-id (chatDispatchIdempotency). Without this the
			// crash-lease self-heal is blind to workstation delegations (the exact
			// firecrawl/750ee463 cohort) and falls through to crash-fail. Mirrors
			// the on-read reconciler (readChildRunStatusesForRunRows, which passes
			// the run's workstationDispatch flag) so the sweep recovers BOTH paths.
			includeMappedWorkstationRun: true,
			organizationId: ref.organizationId,
			runId: ref.runId,
			tediId: ref.tediId,
		});
		return summarizeChildRuntimeEvents(eventRows);
	} catch (error) {
		console.warn("[kernelRuntime] readSingleChildRunSummary failed", {
			error: error instanceof Error ? error.message : String(error),
			runId: ref.runId,
			tediId: ref.tediId,
		});
		return null;
	}
}

/**
 * Hard char budget for the assembled full-result transcript passed to the
 * synthesis LLM — matches the L0 flat-cap so no single delegation can exceed
 * the context window.
 */
const DELEGATION_RESULT_CHAR_BUDGET = 24_576;

/**
 * Read the FULL result transcript for a single completed child delegation run.
 * Assembles an ORDERED, chronological transcript from:
 *   - `message.completed` payload.content (full, no char cap)
 *   - Structured `tool.completed` payloads (data ?? result, errors skipped)
 *   - Artifact titles/refs
 * Hard-capped at {@link DELEGATION_RESULT_CHAR_BUDGET} (24 576 chars).
 * Fail-soft: read errors → null (never throws).
 *
 * Exported for injection into {@link KernelTurnWorkDeps.readChildRunFullResult}.
 */
export async function readChildRunFullResult(
	context: BaseContext,
	input: {
		tediId: string;
		runId: string;
		organizationId: string;
		eventLimit?: number;
		artifactLimit?: number;
		includeMappedWorkstationRun?: boolean;
	},
): Promise<string | null> {
	return (await readChildRunResultAndLiveness(context, input)).transcript;
}

/**
 * Child-run LIVENESS over the same event ledger the transcript is built from:
 * a comparable EXECUTION EVIDENCE model. `toolCallCount` is how many tools the run
 * called; `hasExecutionEvidence` is true when at least one EXECUTION tool call
 * (not a discovery meta-call, not a discover-only `tedix_mcp_code` program)
 * SUCCEEDED, or a real (non-`turn_summary` bookkeeping) artifact was written.
 * Feeds the delegation proof gate so a discovery-only stall is not treated as
 * proof of completion. See `@tedix/mcp-client-core/tool-liveness`.
 */
export interface ChildRunLiveness {
	toolCallCount: number;
	hasExecutionEvidence: boolean;
	/** A terminal successful read_execution receipt was observed. */
	hasTerminalExecutionEvidence: boolean;
	/**
	 * True when the LLM's authoritative `step.completed` tool-call tally exceeds
	 * the number of `tool.started` events we could classify — i.e. a tool call
	 * ran but its `tool.started` was dropped from the ledger (the direct-path
	 * telemetry gap). Such a call is UNCLASSIFIABLE (discovery vs execution), so
	 * the proof gate must report execution evidence as UNKNOWN. Unknown evidence
	 * may trigger recovery or require a durable proof ref, but may never silently
	 * become a successful completion.
	 */
	hasUnclassifiedToolCall: boolean;
}

/**
 * Bookkeeping artifacts every run writes — NOT task-completion evidence.
 * Matched on the label's FIRST PATH SEGMENT because the runtime emits labels
 * as paths (`turn_summary/<runId>.json`); exact-matching the whole label
 * would let every run's own summary count as proof of itself.
 *
 * `workstation_process` is DELIBERATELY not in this set: unlike a
 * turn_summary (self-referential, every run emits one), a
 * `workstation_process/<pid>/...` artifact exists only when a subprocess
 * actually ran under the delegated run's workstation lease — that is real
 * execution. It feeds only the generic
 * (non-terminal) `hasExecutionEvidence`, never the terminal receipt path,
 * so a subprocess still cannot settle the child run.
 */
const BOOKKEEPING_ARTIFACT_NAMES = new Set(["turn_summary"]);
const RECEIPT_REQUIRED_EXECUTION_TOOLS = new Set([
	"tedix_mcp_code",
	"tedix_mcp_call_tool",
]);

/**
 * Derive {@link ChildRunLiveness} from DESC-ordered child event rows. Pairs each
 * `tool.started` (name + arguments → kind via `classifyToolCall`) with its
 * `tool.completed`/`tool.failed` by name + arrival order, then reuses
 * `hasExecutionEvidence`. A real artifact (not `turn_summary`) also counts.
 *
 * Cross-checks the LLM's own authoritative record: each `step.completed` carries
 * `toolCallCount` (how many tools the model actually invoked that round). If the
 * summed step tally exceeds the classifiable `tool.started` events, a tool call
 * ran unobserved — we surface {@link ChildRunLiveness.hasUnclassifiedToolCall}
 * so the gate can preserve UNKNOWN as a third state. See the direct-path
 * telemetry gap: `tedix_mcp_code` executes but its `tool.started` is dropped,
 * leaving only a `step.completed` with `toolCallCount: 1`.
 */
export function computeChildRunLiveness(
	eventRows: TediRuntimeEventRow[],
): ChildRunLiveness {
	const chronological = [...eventRows].reverse();
	const toolCalls: TurnToolCall[] = [];
	// FIFO of unresolved starts per tool name, so a completed/failed resolves the
	// oldest matching start (handles retries: a code timeout then a code success).
	const pendingByName = new Map<string, TurnToolCall[]>();
	let realArtifact = false;
	// Authoritative tool-call tally from the model's own per-round step records.
	let stepToolCallCount = 0;
	const stepToolNames: string[] = [];
	let missingExecutionReceipt = false;
	let terminalExecutionEvidence = false;

	for (const row of chronological) {
		const payload = nonNullRecord(row.payload);
		const name = typeof payload?.name === "string" ? payload.name : null;
		if (row.kind === "tool.started" && name) {
			const argsJson = JSON.stringify(payload?.arguments ?? {});
			const call: TurnToolCall = {
				name,
				ok: false,
				kind: classifyToolCall(name, argsJson),
			};
			toolCalls.push(call);
			const queue = pendingByName.get(name) ?? [];
			queue.push(call);
			pendingByName.set(name, queue);
		} else if (
			(row.kind === "tool.completed" || row.kind === "tool.failed") &&
			name
		) {
			const call = pendingByName.get(name)?.shift();
			if (call) {
				const completed = row.kind === "tool.completed";
				const result = payload?.data ?? payload?.result;
				if (completed && hasTerminalJobCompletionEvidence(result)) {
					terminalExecutionEvidence = true;
				}
				const requiresReceipt =
					call.kind === "execution" &&
					RECEIPT_REQUIRED_EXECUTION_TOOLS.has(name);
				// The EXECUTOR-attested receipt sits beside `result`, because the
				// result is the model's own projection: a Code Mode program that
				// returns `{ count: 9 }` drops the per-call `completionEvidence`
				// its tool results carried. Reading only inside `result` scored
				// every such run as a missing receipt — UNKNOWN evidence for work
				// that demonstrably ran. Same bar, evidence the gate can now see.
				const hasReceipt =
					!requiresReceipt ||
					hasSuccessfulCompletionEvidence({
						completionEvidence: payload?.completionEvidence,
					}) ||
					hasSuccessfulCompletionEvidence(result);
				call.ok = completed && hasReceipt;
				if (completed && requiresReceipt && !hasReceipt) {
					missingExecutionReceipt = true;
				}
			}
		} else if (row.kind === "step.completed") {
			const count =
				typeof payload?.toolCallCount === "number" ? payload.toolCallCount : 0;
			if (count > 0) stepToolCallCount += count;
			if (Array.isArray(payload?.toolNames)) {
				for (const toolName of payload.toolNames) {
					if (typeof toolName === "string" && toolName.length > 0) {
						stepToolNames.push(toolName);
					}
				}
			}
		} else if (row.kind === "artifact.created") {
			const artifactRecord = nonNullRecord(payload?.artifact);
			const label =
				typeof artifactRecord?.name === "string" && artifactRecord.name.trim()
					? artifactRecord.name.trim()
					: "";
			const labelHead = label.split("/", 1)[0] ?? "";
			if (label && !BOOKKEEPING_ARTIFACT_NAMES.has(labelHead)) {
				realArtifact = true;
			}
		}
	}

	// Facet-native tools can currently reach the authoritative `step.completed`
	// record without a matching `tool.started` ledger row. Reconcile the named
	// step calls against observed starts as a multiset. A missing direct tool name
	// is still classifiable from its name (`browser_execute`, `write`,
	// `tedix_mcp_call_tool`, ...), while `tedix_mcp_code` remains UNKNOWN because
	// its arguments are required to distinguish `discover.*` from real execution.
	const unmatchedStepToolNames: string[] = [];
	const remainingObservedByName = new Map<string, number>();
	for (const call of toolCalls) {
		remainingObservedByName.set(
			call.name,
			(remainingObservedByName.get(call.name) ?? 0) + 1,
		);
	}
	for (const toolName of stepToolNames) {
		const remaining = remainingObservedByName.get(toolName) ?? 0;
		if (remaining > 0) {
			remainingObservedByName.set(toolName, remaining - 1);
		} else {
			unmatchedStepToolNames.push(toolName);
		}
	}
	const hasNamedStepExecutionEvidence = unmatchedStepToolNames.some(
		(toolName) =>
			toolName !== "tedix_mcp_code" &&
			classifyToolCall(toolName, "{}") === "execution",
	);
	const anonymousStepShortfall = Math.max(
		0,
		stepToolCallCount - stepToolNames.length,
	);
	const hasUnclassifiedToolCall =
		anonymousStepShortfall > 0 ||
		unmatchedStepToolNames.includes("tedix_mcp_code") ||
		missingExecutionReceipt;

	return {
		toolCallCount: Math.max(toolCalls.length, stepToolCallCount),
		hasExecutionEvidence:
			realArtifact ||
			hasExecutionEvidence(toolCalls) ||
			hasNamedStepExecutionEvidence,
		hasTerminalExecutionEvidence: terminalExecutionEvidence,
		hasUnclassifiedToolCall,
	};
}

/**
 * Read BOTH the full transcript AND the {@link ChildRunLiveness} from ONE event
 * ledger query. Liveness describes observed execution separately from the task
 * outcome; the transcript-only {@link readChildRunFullResult} wraps
 * this and drops the liveness for callers that don't need it.
 */
export async function readChildRunResultAndLiveness(
	context: BaseContext,
	input: {
		tediId: string;
		runId: string;
		organizationId: string;
		eventLimit?: number;
		artifactLimit?: number;
		includeMappedWorkstationRun?: boolean;
		/** The parent work order's verify command; a success without `Verification output:` is partial. */
		verifyCommand?: string | null;
	},
): Promise<{
	transcript: string | null;
	liveness: ChildRunLiveness | null;
	/** Structured runtime stop reason from `run.completed`, or null. */
	stopReason: string | null;
	/** Full stop classification (partial vs no-output failed), or null. */
	stop: DelegatedStopClassification | null;
	declaredOutcome: DeclaredDelegationOutcome | null;
	/** False only when the authoritative child ledger could not be read. */
	readAvailable: boolean;
}> {
	try {
		let { eventRows, artifactRows, eventReadAvailable, observedRunIds } =
			await readChildRunEvidenceRows(context, {
				tediId: input.tediId,
				runId: input.runId,
				organizationId: input.organizationId,
				eventLimit: input.eventLimit ?? 120,
				artifactLimit: input.artifactLimit ?? 8,
				includeMappedWorkstationRun:
					input.includeMappedWorkstationRun ??
					input.runId.includes(":workstation:"),
			});

		// Later tool/transport events can evict the final answer from the mixed window.
		// Recover it through the existing kind-filtered ledger query, bounded to one page.
		if (eventReadAvailable && latestFinalAssistantContent(eventRows) === null) {
			const finalRows = await withTransientD1Retry(() =>
				listTediRuntimeEvents(context.db, {
					organizationId: input.organizationId,
					tediId: input.tediId,
					runIds: observedRunIds,
					kinds: ["message.completed"],
					order: "desc",
					limit: 16,
				}),
			);
			if (latestFinalAssistantContent(finalRows) === null) {
				throw new Error(
					"Latest final assistant result is unavailable in the bounded child ledger read",
				);
			}
			const seen = new Set(eventRows.map((row) => row.id));
			eventRows = [
				...eventRows,
				...finalRows.filter((row) => !seen.has(row.id)),
			].sort(
				(a, b) =>
					b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
			);
		}

		const liveness = computeChildRunLiveness(eventRows);
		const completedPayload = nonNullRecord(
			eventRows.find((row) => row.kind === "run.completed")?.payload,
		);
		const structuredStopReason =
			stringFromPayload(completedPayload?.stopReason) ?? null;
		const stopReason = isStructuredDelegatedStopReason(structuredStopReason)
			? structuredStopReason
			: null;
		const priorityParts: string[] = [];
		if (stopReason) {
			priorityParts.push(
				`[partial-result]\nstopReason=${stopReason}; continuation and fresh verification are required.`,
			);
		}

		const assistantParts: string[] = [];
		const finalAssistantContent = latestFinalAssistantContent(eventRows);
		for (const row of eventRows) {
			if (row.kind !== "message.completed") continue;
			const payload = nonNullRecord(row.payload);
			if (payload?.role !== undefined && payload.role !== "assistant") continue;
			const content =
				typeof payload?.content === "string" ? payload.content.trim() : "";
			if (content) {
				const bounded =
					content.length > FINAL_ASSISTANT_MESSAGE_CHAR_CAP
						? `${content.slice(0, FINAL_ASSISTANT_MESSAGE_CHAR_CAP)}\n[assistant result truncated]`
						: content;
				assistantParts.push(`[assistant]\n${bounded}`);
			}
		}
		if (assistantParts[0]) priorityParts.push(assistantParts[0]);
		const stop = classifyDelegatedStop({
			assistantText: finalAssistantContent,
			structuredStopReason,
			verifyCommand: input.verifyCommand ?? null,
		});

		for (const artifact of artifactRows.slice(0, 8)) {
			const artifactLabel = artifact.name.trim()
				? artifact.name.trim()
				: (artifact.kind ?? "artifact");
			priorityParts.push(`[artifact:${artifactLabel}]\nid=${artifact.id}`);
		}

		const toolParts: string[] = [];
		// eventRows are DESC-ordered: newest evidence first. Bound each payload so
		// one discovery catalog cannot consume the entire synthesis transcript.
		for (const row of eventRows) {
			if (row.kind === "tool.completed") {
				const payload = nonNullRecord(row.payload);
				const name = typeof payload?.name === "string" ? payload.name : "tool";
				const data = payload?.data ?? payload?.result;
				if (data !== undefined && data !== null) {
					const dataStr =
						typeof data === "string" ? data : JSON.stringify(data);
					if (dataStr && !isToolErrorString(dataStr)) {
						const bounded =
							dataStr.length > 4_096
								? `${dataStr.slice(0, 4_096)}\n[tool result truncated]`
								: dataStr;
						toolParts.push(`[tool:${name}]\n${bounded}`);
					}
				}
			}
		}
		for (const priorAssistant of assistantParts.slice(1)) {
			toolParts.push(priorAssistant);
		}
		const selected: string[] = [];
		let used = 0;
		for (const part of [...priorityParts, ...toolParts]) {
			const separator = selected.length > 0 ? 2 : 0;
			if (used + separator + part.length > DELEGATION_RESULT_CHAR_BUDGET) {
				continue;
			}
			selected.push(part);
			used += separator + part.length;
		}
		return {
			transcript: selected.length > 0 ? selected.join("\n\n") : null,
			liveness,
			stopReason,
			stop,
			declaredOutcome: declaredDelegationOutcome(finalAssistantContent),
			readAvailable: eventReadAvailable,
		};
	} catch (error) {
		console.warn("[kernelRuntime] readChildRunResultAndLiveness failed", {
			error: errorMessage(error),
			tediId: input.tediId,
			runId: input.runId,
		});
		// Failed observation supplies neither a task declaration nor execution telemetry.
		return {
			transcript: null,
			liveness: null,
			stopReason: null,
			stop: null,
			declaredOutcome: null,
			readAvailable: false,
		};
	}
}

/** Char cap for the promoted final assistant message (well under the 24k transcript budget). */
const FINAL_ASSISTANT_MESSAGE_CHAR_CAP = 8_192;

/** Keep delegated MCP UI state small enough for one durable Home event row. */
const DELEGATED_WIDGET_RESULT_BYTE_CAP = 24_000;
const DELEGATED_WIDGET_VALUE_DEPTH_CAP = 8;
const DELEGATED_WIDGET_COLLECTION_CAP = 100;
const DELEGATED_WIDGET_STRING_CAP = 4_096;
const MAX_DELEGATED_WIDGETS = 3;
const MCP_APP_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const SENSITIVE_RESULT_KEYS = new Set([
	"api_key",
	"apikey",
	"authorization",
	"bearer",
	"cookie",
	"credential",
	"credentials",
	"password",
	"refresh_token",
	"secret",
	"set-cookie",
	"token",
	"access_token",
]);

export type DelegatedWidgetProjection = {
	resourceUri: string;
	toolInput?: Record<string, unknown>;
	toolResult?: Record<string, unknown>;
	/**
	 * The app whose tool actually produced this result, derived from the tool
	 * NAME on the `tool.completed` event — never from the payload, which is the
	 * untrusted side. A result can declare any `ui://widgets/mcp-app/<slug>/…`
	 * it likes; `widgetTargetFromResourceUri` validates the URI's SHAPE and puts
	 * no constraint on which slug appears, so without this the transcript would
	 * render app B's UI inside a turn where only app A ran. Renderers compare
	 * the two and refuse a mismatch.
	 *
	 * Absent when the tool name is missing or carries no namespace — in that
	 * case provenance is UNKNOWN and must not be fabricated.
	 */
	producedByAppSlug?: string;
};

export type ChildRunFinalAssistantResult = {
	content: string | null;
	widgets: DelegatedWidgetProjection[];
};

function validatedMcpAppResourceUri(value: unknown): string | null {
	if (typeof value !== "string" || value.trim() === "") return null;
	const resourceUri = value.trim();
	let parsed: URL;
	try {
		parsed = new URL(resourceUri);
	} catch {
		return null;
	}
	const [namespace, appSlug, ...resourcePath] = parsed.pathname
		.split("/")
		.filter(Boolean);
	if (
		parsed.protocol !== "ui:" ||
		parsed.hostname !== "widgets" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		parsed.port !== "" ||
		namespace !== "mcp-app" ||
		!appSlug ||
		!MCP_APP_SLUG_PATTERN.test(appSlug) ||
		resourcePath.length === 0
	) {
		return null;
	}
	return resourceUri;
}

function sanitizedDelegatedWidgetValue(value: unknown, depth = 0): unknown {
	if (depth > DELEGATED_WIDGET_VALUE_DEPTH_CAP) return undefined;
	if (
		value === null ||
		typeof value === "boolean" ||
		typeof value === "number"
	) {
		return value;
	}
	if (typeof value === "string") {
		return value.length > DELEGATED_WIDGET_STRING_CAP
			? value.slice(0, DELEGATED_WIDGET_STRING_CAP)
			: value;
	}
	if (Array.isArray(value)) {
		return value
			.slice(0, DELEGATED_WIDGET_COLLECTION_CAP)
			.map((item) => sanitizedDelegatedWidgetValue(item, depth + 1))
			.filter((item) => item !== undefined);
	}
	const record = nonNullRecord(value);
	if (!record) return undefined;
	const result: Record<string, unknown> = {};
	for (const [key, nested] of Object.entries(record).slice(
		0,
		DELEGATED_WIDGET_COLLECTION_CAP,
	)) {
		const normalizedKey = key.toLowerCase();
		if (
			SENSITIVE_RESULT_KEYS.has(normalizedKey) ||
			(normalizedKey.endsWith("token") && normalizedKey !== "tokenscope")
		) {
			continue;
		}
		const sanitized = sanitizedDelegatedWidgetValue(nested, depth + 1);
		if (sanitized !== undefined) result[key] = sanitized;
	}
	return result;
}

function boundedDelegatedWidgetRecord(
	value: unknown,
): Record<string, unknown> | undefined {
	const sanitized = sanitizedDelegatedWidgetValue(value);
	const record = nonNullRecord(sanitized);
	if (!record) return undefined;
	try {
		return new TextEncoder().encode(JSON.stringify(record)).byteLength <=
			DELEGATED_WIDGET_RESULT_BYTE_CAP
			? record
			: undefined;
	} catch {
		return undefined;
	}
}

function widgetResourceUriFromRecord(
	record: Record<string, unknown>,
): string | null {
	return validatedMcpAppResourceUri(
		nonNullRecord(nonNullRecord(record._meta)?.ui)?.resourceUri,
	);
}

/**
 * Project only validated MCP UI targets and their bounded initial result from
 * delegated child tool events. Arbitrary child metadata never crosses into the
 * durable Home transcript.
 */
export function delegatedWidgetProjectionFromEvents(
	rows: TediRuntimeEventRow[],
): DelegatedWidgetProjection[] {
	const widgets: DelegatedWidgetProjection[] = [];
	const seenUris = new Set<string>();

	const visit = (
		value: unknown,
		toolInput: Record<string, unknown> | undefined,
		producedByAppSlug: string | undefined,
		depth = 0,
	): void => {
		if (
			depth > DELEGATED_WIDGET_VALUE_DEPTH_CAP ||
			widgets.length >= MAX_DELEGATED_WIDGETS
		) {
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value)
				visit(item, toolInput, producedByAppSlug, depth + 1);
			return;
		}
		const record = nonNullRecord(value);
		if (!record) return;
		const resourceUri = widgetResourceUriFromRecord(record);
		if (resourceUri) {
			if (!seenUris.has(resourceUri)) {
				seenUris.add(resourceUri);
				const toolResult = boundedDelegatedWidgetRecord(record);
				widgets.push({
					resourceUri,
					...(toolInput ? { toolInput } : {}),
					...(toolResult ? { toolResult } : {}),
					...(producedByAppSlug ? { producedByAppSlug } : {}),
				});
			}
			return;
		}
		for (const nested of Object.values(record)) {
			visit(nested, toolInput, producedByAppSlug, depth + 1);
		}
	};

	for (const row of rows) {
		if (row.kind !== "tool.completed") continue;
		const payload = nonNullRecord(row.payload);
		const candidate = structuredResultValue(
			payload?.resultProjection ?? payload?.data ?? payload?.result,
		);
		if (candidate === null || isToolErrorString(candidate)) continue;
		const toolInput = boundedDelegatedWidgetRecord(
			payload?.input ?? payload?.arguments,
		);
		// Provenance comes from the EVENT, not the result body.
		const toolName = typeof payload?.name === "string" ? payload.name : null;
		// Only app-qualified MCP names attest an app. Harness wrappers such as
		// tedix_mcp_call_tool can execute any authorized app through Code Mode.
		const producedByAppSlug = toolName?.includes("__")
			? toolName.split("__")[0] || undefined
			: undefined;
		visit(candidate, toolInput, producedByAppSlug);
		if (widgets.length >= MAX_DELEGATED_WIDGETS) break;
	}
	return widgets;
}

/**
 * Read ONLY the child's final assistant message (the latest `message.completed`
 * content). Non-LLM fallback for the delegation completion message when
 * synthesis is disabled or fails — the operator should see the tedi's own
 * closing answer, not a rolling activity preview. Fail-soft: null on error.
 */
export async function readChildRunFinalAssistantMessage(
	context: BaseContext,
	input: { tediId: string; runId: string; organizationId: string },
): Promise<string | null> {
	return (await readChildRunFinalAssistantResult(context, input)).content;
}

/** Read the final answer together with the explicitly bounded MCP UI projection. */
export async function readChildRunFinalAssistantResult(
	context: BaseContext,
	input: { tediId: string; runId: string; organizationId: string },
): Promise<ChildRunFinalAssistantResult> {
	try {
		const { eventRows } = await readChildRunEvidenceRows(context, {
			tediId: input.tediId,
			runId: input.runId,
			organizationId: input.organizationId,
			eventLimit: 120,
			artifactLimit: 0,
			includeMappedWorkstationRun: input.runId.includes(":workstation:"),
		});
		const widgets = delegatedWidgetProjectionFromEvents(eventRows);
		// eventRows are DESC-ordered: the first assistant message.completed is final.
		for (const row of eventRows) {
			if (row.kind !== "message.completed") continue;
			const payload = nonNullRecord(row.payload);
			if (payload?.role !== undefined && payload.role !== "assistant") continue;
			const content =
				typeof payload?.content === "string" ? payload.content.trim() : "";
			if (!content) continue;
			return {
				content:
					content.length > FINAL_ASSISTANT_MESSAGE_CHAR_CAP
						? content.slice(0, FINAL_ASSISTANT_MESSAGE_CHAR_CAP)
						: content,
				widgets,
			};
		}
		return { content: null, widgets };
	} catch (error) {
		console.warn("[kernelRuntime] readChildRunFinalAssistantResult failed", {
			error: errorMessage(error),
			tediId: input.tediId,
			runId: input.runId,
		});
		return { content: null, widgets: [] };
	}
}

function homeChildRunTreeStatus(run: HomeRun): HomeChildRunStatus {
	const metadataStatus = nonNullRecord(run.metadata)?.childRunStatus;
	if (
		metadataStatus === "queued" ||
		metadataStatus === "running" ||
		metadataStatus === "streaming" ||
		metadataStatus === "requires_approval" ||
		metadataStatus === "partial" ||
		metadataStatus === "completed" ||
		metadataStatus === "failed" ||
		metadataStatus === "canceled"
	) {
		return metadataStatus;
	}
	if (
		run.status === "queued" ||
		run.status === "running" ||
		run.status === "requires_approval" ||
		run.status === "completed" ||
		run.status === "failed" ||
		run.status === "canceled"
	) {
		return run.status;
	}
	return "queued";
}

function homeChildRunTreeLabel(run: HomeRun): string {
	const metadata = nonNullRecord(run.metadata) ?? {};
	const route = nonNullRecord(metadata.kernelRoute);
	const owner = stringFromPayload(route?.ownerLabel);
	return (
		owner ??
		stringFromPayload(metadata.delegatedTediSlug) ??
		run.delegatedTediId ??
		run.childRunId ??
		run.id
	);
}

/** Read live fan-out slots from the tedi-runtime DO for a delegation node. Fail-soft → []. */
async function readFanoutSlotsForNode(
	context: BaseContext,
	node: {
		delegatedTediId: string;
		childRunId: string;
		metadata?: Record<string, unknown> | null;
	},
): Promise<FanoutSlotRecord[]> {
	try {
		const slug =
			typeof node.metadata?.delegatedTediSlug === "string"
				? node.metadata.delegatedTediSlug
				: null;
		if (!slug) return [];
		const config = getProvisioningConfig({ slug }, context.env);
		// Skip when no service-binding fetcher (test env or misconfigured API).
		if (!config?.fetcher) return [];
		const result = await readFanoutSlots(config, {
			parentRunId: node.childRunId,
			limit: 20,
		});
		return result.slots ?? [];
	} catch {
		return [];
	}
}

/**
 * Query tediRuntimeEvents for terminal fan-out child runs belonging to a
 * given tedi. Fan-out runIds follow the pattern `${tediId}:fanout:%`. Groups
 * by runId to derive per-child status. Fail-soft → empty map.
 */
async function readTerminalFanoutRuns(
	context: BaseContext,
	tediId: string,
): Promise<Map<string, "partial" | "completed" | "failed" | "canceled">> {
	try {
		const rows = await listTediRuntimeEvents(context.db, {
			tediId,
			runIdPrefix: `${tediId}:fanout:`,
			order: "desc",
			limit: 200,
		});
		const byRunId = new Map<string, TediRuntimeEventRow[]>();
		for (const row of rows) {
			if (!row.runId) continue;
			const existing = byRunId.get(row.runId) ?? [];
			existing.push(row);
			byRunId.set(row.runId, existing);
		}
		const result = new Map<
			string,
			"partial" | "completed" | "failed" | "canceled"
		>();
		for (const [runId, runRows] of byRunId) {
			const summary = summarizeChildRuntimeEvents(runRows);
			const childStatus = childRunStatusFromSummary(summary);
			if (
				childStatus === "partial" ||
				childStatus === "completed" ||
				childStatus === "failed" ||
				childStatus === "canceled"
			) {
				result.set(runId, childStatus);
			}
		}
		return result;
	} catch {
		return new Map();
	}
}

/**
 * Build `HomeChildRunTreeNode` children for a delegation node by merging live
 * fan-out slots (from the DO) with terminal statuses (from tediRuntimeEvents).
 */
export function buildFanoutChildNodes(input: {
	homeRunId: string;
	conversationId: string;
	delegatedTediId: string;
	liveSlots: FanoutSlotRecord[];
	terminalByRunId: Map<string, "partial" | "completed" | "failed" | "canceled">;
}): HomeChildRunTreeNode[] {
	const seen = new Set<string>();
	const children: HomeChildRunTreeNode[] = [];

	for (const slot of input.liveSlots) {
		if (!slot.childRunId || seen.has(slot.childRunId)) continue;
		seen.add(slot.childRunId);
		// If D1 says terminal, trust that over the slot's "queued" status.
		const terminalStatus = input.terminalByRunId.get(slot.childRunId);
		const status: HomeChildRunTreeNode["status"] = terminalStatus ?? "queued";
		const active =
			status !== "partial" &&
			status !== "completed" &&
			status !== "failed" &&
			status !== "canceled";
		children.push({
			id: `fanout:${input.delegatedTediId}:${slot.childRunId}`,
			homeRunId: input.homeRunId,
			conversationId: input.conversationId,
			delegatedTediId: input.delegatedTediId,
			childRunId: slot.childRunId,
			parentRunId: null,
			label: slot.ownerLabel || slot.objective || slot.childRunId,
			status,
			active,
			depth: 1,
			updatedAt: slot.dispatchedAt,
			children: [],
			metadata: { source: "fanout" },
		});
	}

	// Add terminal children not in the live-slot list.
	for (const [runId, terminalStatus] of input.terminalByRunId) {
		if (seen.has(runId)) continue;
		seen.add(runId);
		children.push({
			id: `fanout:${input.delegatedTediId}:${runId}`,
			homeRunId: input.homeRunId,
			conversationId: input.conversationId,
			delegatedTediId: input.delegatedTediId,
			childRunId: runId,
			parentRunId: null,
			label: `Fan-out ${runId.split(":fanout:").at(-1) ?? runId}`,
			status: terminalStatus,
			active: false,
			depth: 1,
			updatedAt: null,
			children: [],
			metadata: { source: "fanout" },
		});
	}

	return children;
}

/**
 * Augment a `HomeChildRunTree` with within-tedi fan-out children for each
 * delegation node. Reads live slots from the tedi-runtime DO and terminal
 * statuses from `tediRuntimeEvents`. Fail-soft: any per-node failure returns
 * the node with `children: []` (today's behavior) — never throws.
 */
export async function augmentTreeWithFanoutChildren(
	context: BaseContext,
	tree: HomeChildRunTree,
	rows: KernelRuntimeRun[],
): Promise<HomeChildRunTree> {
	// Only process delegation nodes that are not already terminal on the kernel side.
	const activeDelegationNodes = tree.nodes.filter(
		(node) =>
			node.delegatedTediId &&
			node.childRunId &&
			(node.status === "queued" ||
				node.status === "running" ||
				node.status === "streaming" ||
				node.status === "requires_approval"),
	);
	if (activeDelegationNodes.length === 0) return tree;

	// Cap parallel DO calls to 5 to avoid overloading in wide conversations.
	const cappedNodes = activeDelegationNodes.slice(0, 5);

	// Build a slug lookup from the raw rows (metadata.delegatedTediSlug).
	const slugByChildRunId = new Map<string, string>();
	for (const row of rows) {
		if (!row.childRunId) continue;
		const slug =
			typeof (row.metadata as Record<string, unknown> | null)
				?.delegatedTediSlug === "string"
				? (row.metadata as Record<string, unknown>).delegatedTediSlug
				: null;
		if (typeof slug === "string") slugByChildRunId.set(row.childRunId, slug);
	}

	// Parallel: fetch live slots + terminal events for each active delegation node.
	const augmented = await Promise.all(
		cappedNodes.map(async (node) => {
			if (!node.delegatedTediId || !node.childRunId) {
				return { nodeId: node.id, children: [] as HomeChildRunTreeNode[] };
			}
			try {
				const slug = slugByChildRunId.get(node.childRunId) ?? null;
				const [liveSlots, terminalByRunId] = await Promise.all([
					readFanoutSlotsForNode(context, {
						delegatedTediId: node.delegatedTediId,
						childRunId: node.childRunId,
						metadata: slug ? { delegatedTediSlug: slug } : null,
					}),
					readTerminalFanoutRuns(context, node.delegatedTediId),
				]);
				const children = buildFanoutChildNodes({
					homeRunId: node.homeRunId,
					conversationId: node.conversationId,
					delegatedTediId: node.delegatedTediId,
					liveSlots,
					terminalByRunId,
				});
				return { nodeId: node.id, children };
			} catch {
				return { nodeId: node.id, children: [] as HomeChildRunTreeNode[] };
			}
		}),
	);

	if (augmented.every(({ children }) => children.length === 0)) return tree;

	const childrenByNodeId = new Map<string, HomeChildRunTreeNode[]>();
	for (const { nodeId, children } of augmented) {
		if (children.length > 0) childrenByNodeId.set(nodeId, children);
	}

	const augmentedNodes = tree.nodes.map((node) => {
		const fanoutChildren = childrenByNodeId.get(node.id);
		if (!fanoutChildren || fanoutChildren.length === 0) return node;
		return { ...node, children: fanoutChildren };
	});

	return { ...tree, nodes: augmentedNodes };
}

export function buildHomeChildRunTree(input: {
	organizationId: string;
	conversationId: string;
	runs: HomeRun[];
}): HomeChildRunTree {
	const nodes: HomeChildRunTreeNode[] = input.runs.flatMap(
		(run): HomeChildRunTreeNode[] => {
			const metadata = nonNullRecord(run.metadata);
			const plan = nonNullRecord(metadata?.homePlan);
			const assignments = Array.isArray(plan?.assignments)
				? plan.assignments.flatMap((value): HomeChildRunTreeNode[] => {
						const assignment = nonNullRecord(value);
						const delegatedTediId = stringFromPayload(assignment?.ownerTediId);
						const childRunId = stringFromPayload(assignment?.childRunId);
						if (!delegatedTediId && !childRunId) return [];
						const rawStatus = stringFromPayload(assignment?.status);
						const status: HomeChildRunStatus =
							rawStatus === "completed" ||
							rawStatus === "failed" ||
							rawStatus === "canceled" ||
							rawStatus === "queued" ||
							rawStatus === "running" ||
							rawStatus === "streaming"
								? rawStatus
								: "requires_approval";
						const active =
							status === "queued" ||
							status === "running" ||
							status === "streaming" ||
							status === "requires_approval";
						return [
							{
								id: childRunId
									? `child:${delegatedTediId ?? "unknown"}:${childRunId}`
									: `assignment:${run.id}:${stringFromPayload(assignment?.id) ?? delegatedTediId ?? "unknown"}`,
								homeRunId: run.id,
								conversationId: run.conversationId,
								delegatedTediId: delegatedTediId ?? null,
								childRunId: childRunId ?? null,
								parentRunId: run.id,
								label:
									stringFromPayload(assignment?.ownerLabel) ??
									stringFromPayload(assignment?.ownerSlug) ??
									"Tedi",
								status,
								active,
								depth: 1,
								updatedAt: run.updatedAt ?? null,
								children: [],
								metadata: {
									objective: stringFromPayload(assignment?.objective) ?? null,
									preview: stringFromPayload(assignment?.error) ?? null,
									workItemId: stringFromPayload(assignment?.workItemId) ?? null,
								},
							},
						];
					})
				: [];
			if (assignments.length > 0) {
				const status = homeChildRunTreeStatus(run);
				return [
					{
						id: `home:${run.id}`,
						homeRunId: run.id,
						conversationId: run.conversationId,
						delegatedTediId: null,
						childRunId: null,
						parentRunId: null,
						label: "Home plan",
						status,
						active: assignments.some((assignment) => assignment.active),
						depth: 0,
						updatedAt: run.updatedAt ?? null,
						children: assignments,
						metadata: { progress: run.progress },
					},
				];
			}
			if (!run.delegatedTediId && !run.childRunId) return [];
			const status = homeChildRunTreeStatus(run);
			const active =
				status === "queued" ||
				status === "running" ||
				status === "streaming" ||
				status === "requires_approval";
			const childRunId = run.childRunId ?? null;
			const id = childRunId
				? `child:${run.delegatedTediId ?? "unknown"}:${childRunId}`
				: `home:${run.id}`;
			return [
				{
					id,
					homeRunId: run.id,
					conversationId: run.conversationId,
					delegatedTediId: run.delegatedTediId ?? null,
					childRunId,
					parentRunId: null,
					label: homeChildRunTreeLabel(run),
					status,
					active,
					// Home delegations are single-level today; recursive schema stays for future nested delegation.
					depth: 0,
					updatedAt: run.updatedAt ?? null,
					children: [],
					metadata: {
						progress: run.progress,
						preview: nonNullRecord(run.metadata)?.childRunPreview ?? null,
					},
				},
			];
		},
	);
	const activeNodeId = nodes.find((node) => node.active)?.id ?? null;
	return {
		organizationId: input.organizationId,
		conversationId: input.conversationId,
		nodes,
		activeNodeId,
		updatedAt: latestIso(nodes.map((node) => node.updatedAt)),
	};
}
