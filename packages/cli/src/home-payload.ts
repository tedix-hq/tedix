import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	type HomeRunSet,
	HomeRunSetSchema,
	type HomeRunUsage,
} from "@tedix/api-contract/schemas/kernel-runtime";
import type { McpTaskState } from "@tedix/mcp-shared/tasks";
import { unwrapCallToolResult } from "@tedix/mcp-shared/tool-result";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { normalizeCodeResult } from "./code-result";

// Terminal run statuses — a typed subset of the canonical TediRunStatus enum
// (queued/running are the only in-flight states). Typing it as TediRunStatus
// makes any contract change a typecheck error here, which kills the old
// "canceled"/"cancelled" string-drift hedge. Unknown statuses stay non-terminal
// (fail-open: keep polling).
const SETTLED_HOME_RUN_STATUSES = new Set<TediRunStatus>([
	"completed",
	"failed",
	"canceled",
	"requires_approval",
]);

export function homePayloadFromTask(
	state: McpTaskState,
): Record<string, unknown> {
	const status =
		state.status === "working"
			? "running"
			: state.status === "input_required"
				? "requires_approval"
				: state.status === "cancelled"
					? "canceled"
					: state.status;
	return {
		run: {
			id: state.taskId,
			status,
			...(state.statusMessage
				? { progress: { label: state.statusMessage } }
				: {}),
		},
		mcpTask: state,
	};
}

export interface HomeRunSummary {
	assistantText: string;
	approvedDelegationWorkOrder?: {
		objective?: string;
		outputContract?: string;
		sourceContent?: string;
		status?: string;
	};
	childRunId?: string;
	childRunPreview?: string;
	conversationId?: string;
	delegationMode?: string;
	delegationObjective?: string;
	delegationOutputContract?: string;
	delegationReason?: string;
	delegationResolution?: string;
	delegationResolvedAt?: string;
	delegationStatus?: string;
	delegationError?: string;
	delegatedTediId?: string;
	homeRunId: string;
	kernelRoute?: Record<string, unknown>;
	progressDetail?: string;
	progressLabel?: string;
	/**
	 * PRESENTATION ONLY, never from the server: the prefix of this run's answer
	 * that the CLI's live region already promoted into the terminal's scrollback.
	 * The summary renderer drops it so the canonical message is not reprinted on
	 * top of text the user has already read.
	 */
	renderedAnswerPrefix?: string;
	status?: string;
	targetTediId?: string;
	targetTediLabel?: string;
	/**
	 * Per-run token usage from the kernel run-set; drives the panel ↓N count.
	 * Shared shape from the contract (HomeRunUsageSchema) so it can't drift.
	 */
	usage?: HomeRunUsage;
	workItemId?: string;
	/**
	 * Present when a `propose_tool_write` run COMPLETED without creating an
	 * approval card — the kernel internally declined the write (e.g. the provider
	 * connection is unconfirmed). The run row's optimistic answer text otherwise
	 * reads like the draft was made; this lets the CLI flag that nothing happened.
	 */
	writeDeclined?: { stage: string; detail?: string };
}

/**
 * True only while an operator decision can still change this run.
 *
 * Terminal runs retain their original delegation metadata as history. A draft
 * work order cannot reopen a completed, failed, or canceled run.
 */
export function isPendingHomeApproval(summary: HomeRunSummary): boolean {
	if (
		summary.status === "completed" ||
		summary.status === "failed" ||
		summary.status === "canceled"
	)
		return false;
	if (summary.status === "requires_approval") return true;
	if (summary.delegationMode !== "needs_approval" || summary.childRunId) {
		return false;
	}
	const status = summary.delegationStatus?.toLowerCase();
	return !status || status === "draft" || status === "pending";
}

export interface HomeRunEvent {
	createdAt?: string;
	id?: string;
	kind?: string;
	/** Message this event belongs to, when the row carries one. */
	messageId?: string;
	offset: string;
	payload?: unknown;
	/**
	 * Row-local ordering key the kernel stamps on streamed frames (answer deltas,
	 * phase transitions). Present only on the kinds that need ordering; the
	 * array-index `offset` stays the resume cursor.
	 */
	sequence?: number;
}

export interface HomeRunEventsPage {
	events: HomeRunEvent[];
	/** Resume cursor for the next read: the last delivered event's offset. */
	nextOffset: string;
	/** Run terminal status when the server reports one. */
	status?: string;
	/**
	 * True when this page reached the tail of the stream — i.e. it came back
	 * empty. A FULL page never means caught up: the server bounds a page by
	 * `limit`, so later offsets can still hold events.
	 */
	upToDate: boolean;
	/**
	 * The run's terminal receipt, computed from the run row rather than from this
	 * page. It can be true while later offsets still hold events, so it is a
	 * "will not grow" signal, never "you have read everything".
	 */
	closed?: boolean;
	/** Id of the authoritative terminal event, when the receipt names one. */
	terminalEventId?: string;
	/** A status the server stated outright (as opposed to one derived from events). */
	explicitStatus?: string;
}

/**
 * Sentinel offset meaning "read from the beginning of the stream". The kernel
 * runtime event reader (`kernelRuntime/readRunEvents`) uses an array-index
 * offset model: `0` reads from the start, `nextOffset = start + delivered`.
 */
export const HOME_RUN_EVENTS_START = "0";

/**
 * Events per page. Sized well under the Code Mode gateway's result budget: a
 * whole Home run's stream does not fit in one gateway result, and a truncated
 * result carries no events at all.
 */
export const HOME_RUN_EVENTS_PAGE = 12;

/** Transcript rows per page, for the same gateway-budget reason. */
export const HOME_MESSAGES_PAGE = 10;

export const HOME_RUN_SET_PAGE = 20;

/** Run-row fields the CLI reads (summaries, latest-run recovery, HomeRunSchema). */
export const HOME_RUN_SET_RUN_KEYS = [
	"id",
	"organizationId",
	"conversationId",
	"status",
	"inputMessageId",
	"outputMessageId",
	"delegatedTediId",
	"childRunId",
	"startedAt",
	"completedAt",
	"timeoutAt",
	"createdAt",
	"updatedAt",
	"progress",
	"usage",
];

/** `run.metadata` keys `summarizeHomePayload` and its helpers consume. */
export const HOME_RUN_SET_METADATA_KEYS = [
	"source",
	"approvalRequestId",
	"cancelReason",
	"childRunId",
	"childTaskOutcome",
	"clientSubmissionId",
	"delegatedTediId",
	"delegationError",
	"delegationWorkOrder",
	"homeDelegation",
	"kernelWriteProposalDeclined",
	"workItemId",
];

/** Child-tree node fields the CLI renders; `metadata` keeps progress and a clipped preview. */
export const HOME_CHILD_TREE_NODE_KEYS = [
	"id",
	"homeRunId",
	"conversationId",
	"delegatedTediId",
	"childRunId",
	"parentRunId",
	"label",
	"status",
	"active",
	"depth",
	"updatedAt",
];

export function parseMcpResponsePayload(
	text: string,
	method: string,
): { error?: unknown; result?: unknown } {
	const trimmed = text.trim();
	if (!trimmed) throw new Error(`MCP ${method} returned an empty response`);
	if (trimmed.startsWith("{")) {
		return JSON.parse(trimmed) as { error?: unknown; result?: unknown };
	}
	for (const event of trimmed.split(/\r?\n\r?\n/).reverse()) {
		const data = event
			.split(/\r?\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
			.trim();
		if (data && data !== "[DONE]" && data.startsWith("{")) {
			return JSON.parse(data) as { error?: unknown; result?: unknown };
		}
	}
	throw new Error(
		`MCP ${method} returned unsupported response content: ${trimmed.slice(0, 120)}`,
	);
}

/**
 * Normalize a completed MCP tool result through the canonical Tedix pipeline.
 * Task polling and approval input remain CLI responsibilities and finish before
 * this function runs; result semantics must match every other Tedix surface.
 */
/**
 * The API rejects a forwarded access token that has expired
 * (apps/api/src/rpc/orpc.ts). It arrives as an application-level UNAUTHORIZED,
 * so it is matched on the server's own wording rather than a status code.
 */
export function isExpiredSessionError(error: unknown): boolean {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "";
	return /Forwarded MCP user token is expired/i.test(message);
}

export function unwrapToolResult(
	result: unknown,
	toolName = "tedix-cli.tool",
): unknown {
	return unwrapCallToolResult(result, toolName);
}

/**
 * Validate a read_home_run_set payload against the canonical HomeRunSetSchema.
 * The MCP payload is either the run-set directly or wrapped as `{ runSet: {…} }`.
 * Returns the typed HomeRunSet on success, or null so callers fall back to the
 * defensive findRunArray digging — never throws (fail-open). This is the same
 * contract Tedix OS consumes typed; the CLI just validates the proxied MCP payload.
 */
export function coerceHomeRunSet(payload: unknown): HomeRunSet | null {
	const candidate =
		isRecord(payload) && isRecord(payload.runSet) ? payload.runSet : payload;
	const parsed = HomeRunSetSchema.safeParse(candidate);
	if (!parsed.success && process.env.TEDIX_DEBUG) {
		// Surface contract drift (the run-set no longer matches HomeRunSetSchema)
		// without breaking — the caller falls back to defensive digging.
		console.error(
			"[coerceHomeRunSet] payload failed HomeRunSetSchema; using fallback:",
			parsed.error.issues.slice(0, 3),
		);
	}
	return parsed.success ? parsed.data : null;
}

function runFromPayload(payload: unknown): Record<string, unknown> | null {
	if (!isRecord(payload)) return null;
	const run = payload.run;
	return isRecord(run) ? run : null;
}

function runIdFromPayload(payload: unknown): string | null {
	const run = runFromPayload(payload);
	if (typeof run?.id === "string" && run.id) return run.id;
	if (isRecord(payload)) {
		const task = payload.task;
		if (isRecord(task) && typeof task.id === "string" && task.id) {
			return task.id;
		}
	}
	return null;
}

/**
 * Extract the delegated-child stop outcome a `cancel` propagated to a live child.
 * It lands in `run.metadata.delegatedChildStop` asynchronously AFTER the cancel
 * ack, so the cancel command polls the run for it. Null until it settles.
 */
export function delegatedChildStopFromPayload(
	payload: unknown,
): { outcome: string; childRunId?: string } | null {
	const normalized = normalizeCodeResult(payload);
	if (normalized.truncated) return null;
	payload = normalized.value;
	const run = runFromPayload(payload);
	const metadata = isRecord(run?.metadata) ? run.metadata : {};
	const stop = isRecord(metadata.delegatedChildStop)
		? metadata.delegatedChildStop
		: null;
	const outcome = stop ? stringValue(stop.outcome) : undefined;
	if (!outcome) return null;
	const childRunId = stop ? stringValue(stop.childRunId) : undefined;
	return { outcome, ...(childRunId ? { childRunId } : {}) };
}

function routeFromRun(run: Record<string, unknown> | null) {
	const metadata = isRecord(run?.metadata) ? run.metadata : {};
	const route = metadata.kernelRoute;
	return isRecord(route) ? route : undefined;
}

/** Recursively find the first run-like array (elements with an id) in a payload. */
function findRunArray(payload: unknown): unknown[] | null {
	if (Array.isArray(payload)) {
		return payload.some(
			(e) =>
				isRecord(e) &&
				(typeof e.id === "string" ||
					typeof e.homeRunId === "string" ||
					typeof e.runId === "string"),
		)
			? payload
			: null;
	}
	if (!isRecord(payload)) return null;
	for (const key of ["runs", "data", "items", "results"]) {
		const found = findRunArray(payload[key]);
		if (found) return found;
	}
	for (const value of Object.values(payload)) {
		const found = findRunArray(value);
		if (found) return found;
	}
	return null;
}

/**
 * Best-effort recovery of the most recent run id + status from a
 * `read_home_run_set` payload, used when a blocking `ask` stalls but the
 * durable run was created. Defensive about payload shape; null if none found.
 *
 * Tie-breaking: equal or missing timestamps → prefer the last array element
 * (newest insertion order). Missing/unparseable timestamps sort as -Infinity so
 * any real timestamp wins over them.
 */
export function latestRunFromSet(
	payload: unknown,
	clientSubmissionId?: string,
): { homeRunId: string; status?: string } | null {
	// Prefer the contract-validated run array; fall back to defensive digging.
	const arr = coerceHomeRunSet(payload)?.runs ?? findRunArray(payload);
	if (!arr || arr.length === 0) return null;
	let latest: Record<string, unknown> | null = null;
	let latestStamp = -Infinity;
	for (const entry of arr) {
		if (!isRecord(entry)) continue;
		if (clientSubmissionId) {
			const metadata = isRecord(entry.metadata) ? entry.metadata : {};
			if (metadata.clientSubmissionId !== clientSubmissionId) continue;
		}
		const rawStamp =
			stringValue(entry.createdAt) ?? stringValue(entry.startedAt);
		// Parse numerically; missing or unparseable stamps become -Infinity so
		// any real timestamp wins. On a tie, the later element wins (>=).
		const stamp = rawStamp ? Date.parse(rawStamp) : Number.NaN;
		const numStamp = Number.isNaN(stamp) ? -Infinity : stamp;
		if (latest === null || numStamp >= latestStamp) {
			latest = entry;
			latestStamp = numStamp;
		}
	}
	if (!latest) return null;
	const id =
		stringValue(latest.id) ??
		stringValue(latest.homeRunId) ??
		stringValue(latest.runId);
	if (!id) return null;
	return { homeRunId: id, status: stringValue(latest.status) };
}

/** A completed propose_tool_write run that internally declined the write. */
function writeDeclinedFromMetadata(metadata: Record<string, unknown>): {
	writeDeclined?: { stage: string; detail?: string };
} {
	const declined = isRecord(metadata.kernelWriteProposalDeclined)
		? metadata.kernelWriteProposalDeclined
		: null;
	const stage = declined ? stringValue(declined.stage) : undefined;
	if (!stage) return {};
	const detail = declined ? stringValue(declined.detail) : undefined;
	return { writeDeclined: { stage, ...(detail ? { detail } : {}) } };
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function assistantTextFromPayload(payload: unknown): string {
	if (!isRecord(payload)) return "";
	const assistantMessage = payload.assistantMessage;
	if (isRecord(assistantMessage)) {
		const content = stringValue(assistantMessage.content);
		if (content) return content;
	}
	const run = runFromPayload(payload);
	const route = routeFromRun(run);
	const metadata = isRecord(run?.metadata) ? run.metadata : {};
	// For routes whose durable route answer is null, the rendered operator-facing
	// text is in run.metadata.bodyExecutionResult.summary (written by the turn
	// body). It is the only authoritative answer on the poll path because:
	// (a) ask initial ack has assistantMessage:undefined when dispatched async to DO
	// (b) read_home_run never includes assistantMessage
	// (c) delegate/direct routes can have route.answer === null.
	const bodyResultSummary = stringValue(
		isRecord(metadata.bodyExecutionResult)
			? metadata.bodyExecutionResult.summary
			: undefined,
	);
	return (
		stringValue(route?.answer) ??
		stringValue(route?.clarifyingQuestion) ??
		bodyResultSummary ??
		stringValue(metadata.childRunPreview) ??
		""
	);
}

function approvedDelegationWorkOrderFromMetadata(
	metadata: Record<string, unknown>,
	homeDelegation: Record<string, unknown>,
): HomeRunSummary["approvedDelegationWorkOrder"] {
	const directWorkOrder = isRecord(metadata.delegationWorkOrder)
		? metadata.delegationWorkOrder
		: undefined;
	const homeWorkOrder = isRecord(homeDelegation.workOrder)
		? homeDelegation.workOrder
		: undefined;
	const workOrder = directWorkOrder ?? homeWorkOrder;
	if (!workOrder || stringValue(workOrder.status) !== "approved") {
		return undefined;
	}
	return {
		status: stringValue(workOrder.status),
		objective: stringValue(workOrder.objective),
		outputContract: stringValue(workOrder.outputContract),
		sourceContent: stringValue(workOrder.sourceContent),
	};
}

function delegationStatusFromMetadata(
	metadata: Record<string, unknown>,
	homeDelegation: Record<string, unknown>,
): string | undefined {
	const directWorkOrder = isRecord(metadata.delegationWorkOrder)
		? metadata.delegationWorkOrder
		: undefined;
	const homeWorkOrder = isRecord(homeDelegation.workOrder)
		? homeDelegation.workOrder
		: undefined;
	return (
		stringValue(homeDelegation.resolutionStatus) ??
		stringValue(homeWorkOrder?.status) ??
		stringValue(directWorkOrder?.status)
	);
}

function delegationWorkOrderFromMetadata(
	metadata: Record<string, unknown>,
	homeDelegation: Record<string, unknown>,
): Record<string, unknown> {
	if (isRecord(metadata.delegationWorkOrder)) {
		return metadata.delegationWorkOrder;
	}
	return isRecord(homeDelegation.workOrder) ? homeDelegation.workOrder : {};
}

export function summarizeHomePayload(payload: unknown): HomeRunSummary | null {
	const normalized = normalizeCodeResult(payload);
	if (normalized.truncated) return null;
	payload = normalized.value;
	const run = runFromPayload(payload);
	const homeRunId = runIdFromPayload(payload);
	if (!homeRunId) return null;
	const status = stringValue(run?.status);
	const route = routeFromRun(run);
	const progress = isRecord(run?.progress) ? run.progress : {};
	const metadata = isRecord(run?.metadata) ? run.metadata : {};
	const homeDelegation = isRecord(metadata.homeDelegation)
		? metadata.homeDelegation
		: {};
	const delegationDecision = isRecord(homeDelegation.decision)
		? homeDelegation.decision
		: {};
	const delegationWorkOrder = delegationWorkOrderFromMetadata(
		metadata,
		homeDelegation,
	);
	const cancelReason = stringValue(metadata.cancelReason);
	const assistantText =
		status === "canceled"
			? cancelReason
				? `Home run canceled by operator: ${cancelReason}`
				: "Home run canceled by operator."
			: assistantTextFromPayload(payload);
	return {
		homeRunId,
		status,
		conversationId: stringValue(run?.conversationId),
		delegatedTediId: stringValue(run?.delegatedTediId),
		childRunId:
			stringValue(run?.childRunId) ?? stringValue(metadata.childRunId),
		delegationError: stringValue(metadata.delegationError),
		delegationMode: stringValue(delegationDecision.mode),
		delegationObjective: stringValue(delegationWorkOrder.objective),
		delegationOutputContract: stringValue(delegationWorkOrder.outputContract),
		delegationReason: stringValue(delegationDecision.reason),
		delegationResolution: stringValue(homeDelegation.resolution),
		delegationResolvedAt: stringValue(homeDelegation.resolvedAt),
		delegationStatus: delegationStatusFromMetadata(metadata, homeDelegation),
		progressLabel: stringValue(progress.label),
		progressDetail: stringValue(progress.detail),
		kernelRoute: route,
		approvedDelegationWorkOrder: approvedDelegationWorkOrderFromMetadata(
			metadata,
			homeDelegation,
		),
		childRunPreview: stringValue(metadata.childRunPreview),
		assistantText,
		targetTediId: stringValue(route?.targetTediId),
		targetTediLabel: stringValue(route?.targetTediLabel),
		workItemId: stringValue(metadata.workItemId),
		...writeDeclinedFromMetadata(metadata),
	};
}

export function isSettledHomeStatus(status: string | undefined): boolean {
	return (
		status !== undefined &&
		(SETTLED_HOME_RUN_STATUSES as ReadonlySet<string>).has(status)
	);
}

function numericOffset(value: unknown, fallback: number): number {
	const parsed =
		typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
	if (
		typeof parsed !== "number" ||
		!Number.isSafeInteger(parsed) ||
		parsed < 0
	) {
		return fallback;
	}
	return parsed;
}

/**
 * Derive a settled run status from terminal event(s) so the follow loop can
 * stop and the CLI can label the outcome. The kernel reader signals termination
 * via `stream.closed` + `terminalEventId`; the matching event's `kind` carries
 * the failed/canceled/approval nuance.
 *
 * KEYSTONE: do NOT trust `events[events.length - 1]` as the terminal event.
 * The durable ledger's `submission.settled` event trails the authoritative
 * `run.failed` / `run.canceled` etc., so a failed/canceled run ending with a
 * trailing `submission.settled` would be mistaken for success. Instead:
 *
 * 1. If `terminalEventId` is provided and found, use that event's kind.
 * 2. Otherwise scan ALL events for any authoritative fail/cancel kind and
 *    return the worst-case non-success status found.
 * 3. Only fall through to "completed" when no fail/cancel signal is present.
 */
export function settledStatusFromTerminal(
	events: HomeRunEvent[],
	terminalEventId: string | undefined,
): string {
	// Try the authoritative terminal event first.
	if (terminalEventId) {
		const terminal = events.find((event) => event.id === terminalEventId);
		if (terminal) {
			const kind = terminal.kind ?? "";
			// `submission.settled` is a trailing ledger event and not an outcome.
			// Scan the whole page before defaulting it to success.
			if (!kind.startsWith("submission.")) {
				if (/fail|error/i.test(kind)) return "failed";
				if (/cancel/i.test(kind)) return "canceled";
				if (/approval|approve|await/i.test(kind)) return "requires_approval";
				return "completed";
			}
		}
	}
	// terminalEventId absent, not found, or only a trailing submission event — scan ALL events for authoritative
	// fail/cancel signals rather than trusting the last event (which may be a
	// trailing submission.settled that follows the real outcome).
	let sawApproval = false;
	for (const event of events) {
		const kind = event.kind ?? "";
		if (/fail|error/i.test(kind)) return "failed";
		if (/cancel/i.test(kind)) return "canceled";
		if (/approval|approve|await/i.test(kind)) sawApproval = true;
	}
	if (sawApproval) return "requires_approval";
	return "completed";
}

/**
 * Normalize a `read_home_run_events` payload into a Tedix event page. The
 * kernel runtime reader returns `{ events, stream: { offset, nextOffset, closed,
 * terminalEventId } }` with an array-index offset model: each event's resume
 * offset is `stream.offset + i`, `nextOffset` is the cursor to read next, and
 * `stream.closed` is the terminal signal. `status` stays undefined while the
 * run is live so the follow loop keeps polling, and resolves to a settled
 * status once the stream closes. Tolerant of a flatter root-level shape.
 */
export function parseHomeRunEventsPage(
	payload: unknown,
	previousOffset: string = HOME_RUN_EVENTS_START,
): HomeRunEventsPage {
	const root = isRecord(payload) ? payload : {};
	const stream = isRecord(root.stream) ? root.stream : root;
	const rawEvents = Array.isArray(root.events)
		? root.events
		: Array.isArray(stream.events)
			? stream.events
			: [];
	const start = numericOffset(stream.offset, numericOffset(previousOffset, 0));
	const events: HomeRunEvent[] = [];
	rawEvents.forEach((entry, index) => {
		if (!isRecord(entry)) return;
		const sequence =
			typeof entry.sequence === "number" && Number.isFinite(entry.sequence)
				? entry.sequence
				: undefined;
		const messageId = stringValue(entry.messageId);
		events.push({
			offset: String(start + index),
			kind: stringValue(entry.kind) ?? stringValue(entry.type),
			createdAt: stringValue(entry.createdAt) ?? stringValue(entry.at),
			id: stringValue(entry.id),
			...(messageId ? { messageId } : {}),
			...(sequence !== undefined ? { sequence } : {}),
			payload:
				"payload" in entry && entry.payload !== undefined
					? entry.payload
					: entry.delta,
		});
	});
	const nextOffset = String(
		numericOffset(stream.nextOffset, start + events.length),
	);
	const closed = stream.closed === true || root.closed === true;
	// A page is only "caught up" when it came back EMPTY. A full page means the
	// server hit this read's `limit`, and later offsets still hold events —
	// treating that as caught-up is what made the follow loop re-read offset 0
	// forever instead of draining the stream.
	const upToDate = events.length === 0;
	const terminalEventId = stringValue(stream.terminalEventId);
	const explicitStatus =
		stringValue(stream.status) ??
		stringValue(root.status) ??
		stringValue(isRecord(root.run) ? root.run.status : undefined);
	let status: string | undefined;
	if (closed) {
		if (explicitStatus) {
			status = explicitStatus;
		} else if (
			terminalEventId &&
			!events.some((e) => e.id === terminalEventId)
		) {
			// The terminal event is not in THIS page — either a split page or a
			// paginated read that has not reached it yet. Indeterminate, never an
			// implied success. `streamHomeRunEvents` resolves the paginated case
			// from the terminal signals it accumulates across pages.
			status = "unknown";
		} else {
			status = settledStatusFromTerminal(events, terminalEventId);
		}
	} else {
		status = explicitStatus;
	}
	return {
		events,
		nextOffset,
		status,
		upToDate,
		closed,
		...(terminalEventId ? { terminalEventId } : {}),
		...(explicitStatus ? { explicitStatus } : {}),
	};
}
