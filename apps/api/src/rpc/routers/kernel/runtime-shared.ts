/**
 * Kernel — shared runtime leaf helpers. Iso timestamps, cause-chain error
 * unwrapping, fail-soft D1 read predicates, run-status predicates/keys, turn-key
 * sanitization, and the internal service-binding context for in-process
 * cognitive-runtime calls. This module must NOT import kernel-runtime.ts (the
 * router imports this module; a value import back would create a cycle).
 */

import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import type { HomeChildRunEvidence } from "@tedix/api-contract/schemas/kernel-runtime";
import {
	buildRuntimeRunId,
	sanitizeRuntimeTurnKey,
} from "@tedix/api-contract/utils/runtime-identity";
import type { kernelRuntimeRuns } from "@tedix/db/schema/cognitive-runtime";
import { type BaseContext, createError, ErrorCodes } from "../../orpc";
import { hasDelegatedOutput } from "./delegated-stop";

/**
 * Shared system prompt for the bounded delegation-synthesis LLM pass — used by
 * both the on-read async-completion FALLBACK (`run-store.ts`, only when the
 * child left no final assistant message) and the inbox-wake delivery
 * (`turn-work.ts`). The role-play guard is load-bearing: a context-free pass
 * over a short transcript will otherwise ANSWER the work order ("Ready.
 * Please provide the task…") instead of reporting on it.
 */
/**
 * Structured delegation-failure envelope (Cloudflare `AgentToolFailure`
 * pattern): a machine-readable failure the kernel model, Tedix OS, and automation
 * can reason about — retry vs wake vs surface — instead of parsing an error
 * string. Carried in run/event metadata under `delegationFailure`.
 */
export interface DelegationFailureEnvelope {
	ok: false;
	status: "failed";
	/** Terminal reason key — `dispatch_failed` (transport/enqueue error) or `runtime_unavailable` (preflight: target unreachable/stopped). */
	reason: string;
	/** Human-readable error detail (unchanged from `delegationError`). */
	error: string;
	/**
	 * Whether re-dispatching the same work order is a sensible next step.
	 * Transport-ish dispatch errors are retryable; a preflight-unreachable
	 * runtime needs a wake (or operator attention) first, not a blind retry.
	 */
	retryable: boolean;
	/** True when the child may still be executing despite the parent settling (not the case for dispatch-time failures). */
	childStillRunning: boolean;
}

export function buildDelegationFailureEnvelope(input: {
	reason: string;
	error: string;
	childStillRunning?: boolean;
}): DelegationFailureEnvelope {
	return {
		ok: false,
		status: "failed",
		reason: input.reason,
		error: input.error,
		retryable: input.reason === "dispatch_failed",
		childStillRunning: input.childStillRunning ?? false,
	};
}

export const DELEGATION_SYNTHESIS_SYSTEM_PROMPT =
	"You are the Kernel — the control-plane orchestrator for Tedix Home. You delegated a bounded task to one or more worker tedis; that work is already FINISHED. Read their COMPLETE output and report the result FOR THE OPERATOR. Follow the original operator request exactly when it is provided: preserve its requested format, scope, and brevity. Include every finding the request requires, but omit worker process chatter, internal IDs, repetition, and unsolicited next steps. If the request gives no length preference, be concise. Interpret and reconcile the workers' evidence instead of emitting a raw transcript or preview. Never role-play as a worker, answer the work order yourself, or ask for a task; report completed work in past tense.";

/**
 * Build an internal service-binding context for in-process cognitive-runtime
 * router calls made on the kernel's behalf (child dispatch, child steer-forward,
 * child stop-cascade). The operator request context that reaches the kernel on
 * the MCP/Tedix OS path carries only an acting-user identity with no re-presentable
 * credential for the in-process enqueue/stop (it fails withAuth's strategies →
 * "No valid credentials"). These calls run under the service-binding marker
 * (`X-Service-Binding: true`) with the org threaded via `X-Tedix-Org-Id` and the one scope needed to enqueue or
 * control a tedi run. SAFE: the target tedi is already org-validated by the
 * org-scoped parent run row read, not external input.
 */
export function buildInternalServiceBindingContext(
	context: BaseContext,
	organizationId: string,
): BaseContext {
	const internalHeaders = new Headers();
	internalHeaders.set("X-Service-Binding", "true");
	internalHeaders.set("X-Tedix-Org-Id", organizationId);
	return {
		...context,
		organizationId,
		headers: internalHeaders,
		authType: "service-binding",
		tediScopes: ["tedis:write"],
	};
}

export function nowIso() {
	return new Date().toISOString();
}

export function offsetIso(baseIso: string, offsetMs: number) {
	return new Date(new Date(baseIso).getTime() + offsetMs).toISOString();
}

export function errorMessage(value: unknown): string {
	if (value instanceof Error) {
		const cause = (value as Error & { cause?: unknown }).cause;
		return `${value.message} ${cause ? errorMessage(cause) : ""}`.trim();
	}
	if (value && typeof value === "object") {
		const maybeCause = value as { cause?: unknown; message?: unknown };
		const message =
			typeof maybeCause.message === "string" ? maybeCause.message : "";
		const cause = maybeCause.cause ? errorMessage(maybeCause.cause) : "";
		return `${message} ${cause}`.trim();
	}
	return String(value);
}

export function recordOrNull(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

export async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(
					() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

export function isMissingKernelRuntimeTable(value: unknown): boolean {
	return errorMessage(value).includes("no such table: kernel_runtime_events");
}

export function isMissingKernelRuntimeRunsTable(value: unknown): boolean {
	return errorMessage(value).includes("no such table: kernel_runtime_runs");
}

/**
 * TRANSIENT remote-D1 transport failure — the class of error a bounded retry
 * can heal. Covers both observed shapes from remote D1 bindings:
 *   - `D1_ERROR: ... Network connection lost` (miniflare remote-binding drop)
 *   - `D1_ERROR: Failed to parse body as JSON, got: error code: 502` (the D1
 *     HTTP edge returned a 5xx body instead of JSON)
 * Both mean "the query never produced a result", never "the data is absent" —
 * callers must retry or fail soft, and must NOT render the miss as an empty
 * ledger (a completed delegation would otherwise render "No evidence yet").
 */
export function isRemoteD1TransportError(value: unknown): boolean {
	const message = errorMessage(value);
	if (!message.includes("D1_ERROR")) return false;
	return (
		message.includes("Network connection lost") ||
		message.includes("Failed to parse body as JSON")
	);
}

export function shouldFailSoftKernelRuntimeRead(value: unknown): boolean {
	return isMissingKernelRuntimeTable(value) || isRemoteD1TransportError(value);
}

export function shouldFailSoftHomeRunSetRead(value: unknown): boolean {
	return (
		isMissingKernelRuntimeRunsTable(value) || isRemoteD1TransportError(value)
	);
}

export function shouldFailSoftChildEvidenceRead(value: unknown): boolean {
	return isRemoteD1TransportError(value);
}

export function nonNullRecord(
	value: unknown,
): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	return value as Record<string, unknown>;
}

export function stringFromPayload(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function numberFromPayload(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

export function sanitizeAgentTurnKey(value: string): string {
	try {
		return sanitizeRuntimeTurnKey(value);
	} catch {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Delegated run id requires a stable client id",
		);
	}
}

export function predictAgentRunId(input: {
	clientRequestId: string;
	tediId: string;
}): string {
	return buildRuntimeRunId({
		tediId: input.tediId,
		turnKey: sanitizeAgentTurnKey(input.clientRequestId),
		surface: "mcp",
	});
}

export function childRunStatusFromSummary(
	value: Record<string, unknown> | null,
): HomeChildRunEvidence["status"] {
	const status = value?.childRunStatus;
	switch (status) {
		case "partial":
			// Older summaries persisted `partial` for a stop that left only the
			// runtime's `[Turn stopped early: …]` marker behind. A preview with no
			// output besides markers is a failed run, not a partial one.
			return typeof value?.childRunPreview === "string" &&
				!hasDelegatedOutput(value.childRunPreview)
				? "failed"
				: "partial";
		case "completed":
		case "failed":
		case "canceled":
		case "streaming":
		case "running":
		case "queued":
		case "requires_approval":
			return status;
		default:
			return "queued";
	}
}

export function isActiveHomeRunStatus(status: TediRunStatus): boolean {
	return (
		status === "queued" ||
		status === "running" ||
		status === "requires_approval"
	);
}

export function isTerminalHomeRunStatus(status: TediRunStatus): boolean {
	return status === "completed" || status === "failed" || status === "canceled";
}

/**
 * A blocker Work Item stops gating dependents only at a terminal business
 * disposition. Attempt failures do not change the Work Item's disposition and
 * therefore continue to gate dependents until the evidence-gated completion or
 * explicit cancellation transition occurs.
 */
export function isTerminalBlockerStatus(status: string): boolean {
	return status === "completed" || status === "cancelled";
}

export function homeRunProgress(input: {
	eventCount: number;
	latestActivityLabel?: string | null;
	status: HomeChildRunEvidence["status"] | TediRunStatus | undefined;
	/** The child's stop reason sentence (`Stopped after 17 steps: …`) for a runtime-stopped delegation. */
	stopDetail?: string | null;
}): { current: number; detail: string; label: string; total: number } {
	const eventDetail =
		input.eventCount === 0
			? // A terminal run with zero runtime events is the normal shape for the
				// direct routes (answer_in_home / ask_human / suggest_handoff, and a
				// needs-approval delegate_tedi that parks a draft work order) — the
				// kernel settles without emitting tool/delegation telemetry. The older
				// "0 runtime events recorded" phrasing read like missing telemetry; this
				// states it as the expected fact.
				"no runtime events"
			: input.eventCount === 1
				? "1 runtime event recorded"
				: `${input.eventCount} runtime events recorded`;
	// For in-progress statuses, prefer the live activity label (e.g. "calling
	// workers_builds_list_builds") over the bare count so the CLI live panel
	// shows what the tedi is actually doing right now. Terminal statuses keep
	// the event count so the panel records what happened overall.
	const inProgressDetail = input.latestActivityLabel ?? eventDetail;
	switch (input.status) {
		case "partial":
			return {
				current: 100,
				detail: input.stopDetail
					? `Partial result — ${input.stopDetail}; continuation required`
					: "Partial result — continuation required",
				label: "Partial",
				total: 100,
			};
		case "completed":
			return {
				current: 100,
				detail: eventDetail,
				label: "Complete",
				total: 100,
			};
		case "failed":
			return {
				current: 100,
				detail: input.stopDetail ?? eventDetail,
				label: "Failed",
				total: 100,
			};
		case "canceled":
			return {
				current: 100,
				detail: eventDetail,
				label: "Stopped",
				total: 100,
			};
		case "streaming":
			return {
				current: 72,
				detail: inProgressDetail,
				label: "Streaming",
				total: 100,
			};
		case "running":
			return {
				current: 48,
				detail: inProgressDetail,
				label: "Running",
				total: 100,
			};
		case "queued":
			return {
				current: 18,
				detail: inProgressDetail,
				label: "Queued",
				total: 100,
			};
		case "requires_approval":
			return {
				current: 64,
				detail: inProgressDetail,
				label: "Needs approval",
				total: 100,
			};
		default:
			return {
				current: 8,
				detail: inProgressDetail,
				label: "Waiting",
				total: 100,
			};
	}
}

export function childRunStatusKey(tediId: string, runId: string): string {
	return `${tediId}:${runId}`;
}

export function delegatedChildSteerRunId(
	row: typeof kernelRuntimeRuns.$inferSelect,
): string | null {
	const metadata = nonNullRecord(row.metadata);
	const delegatedChildSteer = nonNullRecord(metadata?.delegatedChildSteer);
	return stringFromPayload(delegatedChildSteer?.childInjectRunId) ?? null;
}

export function latestIso(
	values: Array<string | null | undefined>,
): string | null {
	return (
		values
			.filter((value): value is string => Boolean(value))
			.sort()
			.at(-1) ?? null
	);
}

export function nextCursor<T extends { createdAt: string }>(
	rows: T[],
	limit: number,
): string | null {
	return rows.length === limit
		? (rows[rows.length - 1]?.createdAt ?? null)
		: null;
}

export function resolveOrganizationId(
	context: BaseContext,
	requestedOrganizationId?: string,
): string {
	const organizationId = requestedOrganizationId ?? context.organizationId;
	if (!organizationId) {
		throw createError(ErrorCodes.UNAUTHORIZED, "Organization context required");
	}
	if (
		context.organizationId &&
		requestedOrganizationId &&
		requestedOrganizationId !== context.organizationId
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Access denied to this organization",
		);
	}
	return organizationId;
}

/** Bounded args JSON for cards/transcripts (never throws). */
export function boundedArgsJson(
	args: Record<string, unknown>,
	max = 400,
): string {
	try {
		const json = JSON.stringify(args ?? {});
		return json.length > max ? `${json.slice(0, max)}…` : json;
	} catch {
		return "[unserializable arguments]";
	}
}

/**
 * Per-delegation session key. Without an explicit conversationId every
 * delegation lands in the tedi's shared `agent:main:main` session, so two
 * concurrent delegations see each other's user messages in the same LLM
 * context and one turn answers both assignments. Deterministic per idempotency key, so redelivery
 * lands in the same session; the DO-level brain/memory/tools stay shared —
 * only the chat history is scoped.
 */
export function delegationSessionKey(childRunId: string): string {
	return `agent:main:delegation-${childRunId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
