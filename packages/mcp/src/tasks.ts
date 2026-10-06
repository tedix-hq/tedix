import {
	MCP_CLIENT_CAPABILITIES_META_KEY,
	MCP_TASKS_EXTENSION,
} from "./protocol";

/**
 * Does the caller's request `_meta` opt into the Tasks extension?
 *
 * Reads `io.modelcontextprotocol/clientCapabilities.extensions` from request
 * `_meta`. Returns `true` only when the tasks extension is explicitly declared.
 * Per the 2026-07-28 spec the extension is REQUIRED for task-shaped results, so
 * callers that omit `clientCapabilities` — or declare capabilities WITHOUT the
 * tasks extension — are treated as not task-capable (`false`). The former
 * no-capabilities exemption (legacy callers → `true`) was removed together with
 * the compat task shims.
 */
export function clientSupportsTasks(meta: unknown): boolean {
	if (typeof meta !== "object" || meta === null) return false;
	const caps = (meta as Record<string, unknown>)[
		MCP_CLIENT_CAPABILITIES_META_KEY
	];
	if (typeof caps !== "object" || caps === null) return false;
	const extensions = (caps as Record<string, unknown>).extensions;
	if (typeof extensions !== "object" || extensions === null) return false;
	return MCP_TASKS_EXTENSION in (extensions as Record<string, unknown>);
}

/**
 * Extract an MCP task id from a `tools/call` result: the 2026-07-28
 * protocol-native `resultType: "task"` envelope. Returns null for a normal
 * synchronous tool result. (The legacy Tedix `task: { id }` compatibility
 * linkage — top-level and under `structuredContent` — was removed together with
 * the compat task shims.)
 *
 * Canonical, shared by every Tedix-owned MCP client that must await a
 * long-running tool: the stateless client loop (`packages/mcp-client-core`) and
 * the skill-runtime workflow bridge (`apps/skill-runtime`). Both detect and poll
 * a task the same way.
 */
export function extractMcpTaskId(result: unknown): string | null {
	if (!isTaskRecord(result)) return null;
	if (result.resultType === "task" && typeof result.taskId === "string") {
		return result.taskId;
	}
	return null;
}

export const MCP_TASK_STATUS_VALUES = [
	"working",
	"input_required",
	"completed",
	"cancelled",
	"failed",
] as const;

export type McpTaskStatus = (typeof MCP_TASK_STATUS_VALUES)[number];

export interface McpJsonRpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export interface McpTaskState {
	taskId: string;
	status: McpTaskStatus;
	statusMessage?: string;
	createdAt: string;
	lastUpdatedAt: string;
	ttlMs: number | null;
	pollIntervalMs?: number;
	inputRequests?: Record<string, unknown>;
	result?: Record<string, unknown>;
	error?: McpJsonRpcErrorObject;
}

export interface McpTaskGetInput {
	taskId: string;
}

export interface McpTaskUpdateInput {
	taskId: string;
	inputResponses: Record<string, unknown>;
}

export interface McpTaskCancelInput {
	taskId: string;
}

export interface McpTaskHandlers {
	get(input: McpTaskGetInput): Promise<McpTaskState>;
	update(input: McpTaskUpdateInput): Promise<void>;
	cancel(input: McpTaskCancelInput): Promise<void>;
}

export class McpTaskError extends Error {
	readonly code: number;
	readonly data: Record<string, unknown> | undefined;

	constructor(code: number, message: string, data?: Record<string, unknown>) {
		super(message);
		this.name = "McpTaskError";
		this.code = code;
		this.data = data;
	}

	static notFound(taskId: string): McpTaskError {
		return new McpTaskError(-32_602, "Task not found", { taskId });
	}
}

// =============================================================================
// TEDI RUN → TASK PROJECTION (shared)
// Projects a tedi run's durable cognitive-runtime events
// (`cognitiveRuntime.listEvents` over `tedi_runtime_events`) to MCP task state.
// Used by the per-tedi MCP surface (apps/tedi) AND the aggregate (apps/mcp),
// which routes namespaced `tedi:<tediId>:<runId>` task ids to this projection.
// =============================================================================

/** Suggested poll cadence while a tedi run is still working. */
export const TEDI_RUN_TASK_POLL_INTERVAL_MS = 2_500;

/** Loose runtime-event shape — the contract guarantees the full shape; we only
 * read the fields the projection uses. */
export interface TediRunTaskEvent {
	kind?: string;
	conversationId?: string;
	runId?: string;
	messageId?: string;
	approvalRequestId?: string;
	payload?: Record<string, unknown>;
	createdAt?: string;
	[key: string]: unknown;
}

function isTaskRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Unwrap the apps/api oRPC `{ json: { events } }` envelope to the events array. */
export function eventsFromApi(data: unknown): TediRunTaskEvent[] {
	const unwrapped =
		isTaskRecord(data) && "json" in data
			? (data as { json: unknown }).json
			: data;
	if (!isTaskRecord(unwrapped)) return [];
	const events = unwrapped.events;
	if (!Array.isArray(events)) return [];
	return events.filter(isTaskRecord) as TediRunTaskEvent[];
}

const TERMINAL_EVENT_TASK_STATUS: Record<string, McpTaskStatus> = {
	"run.completed": "completed",
	"run.failed": "failed",
	"run.canceled": "cancelled",
};

function eventTimeMs(event: TediRunTaskEvent): number {
	if (typeof event.createdAt !== "string") return 0;
	const ms = new Date(event.createdAt).getTime();
	return Number.isFinite(ms) ? ms : 0;
}

function failureMessage(event: TediRunTaskEvent | undefined): string {
	const payload = isTaskRecord(event?.payload) ? event.payload : {};
	if (typeof payload.error === "string" && payload.error) return payload.error;
	if (typeof payload.message === "string" && payload.message) {
		return payload.message;
	}
	return "Tedi run failed";
}

/**
 * Project a tedi run's durable runtime events to MCP task state.
 *
 * - latest terminal event wins: run.completed → completed, run.failed → failed,
 *   run.canceled → cancelled
 * - unresolved `approval.requested` (no matching `approval.resolved`) →
 *   input_required pointing at the durable approval tools
 * - otherwise → working with a poll hint
 *
 * Events may arrive in any order (listEvents returns DESC); the projection
 * scans the page rather than trusting position.
 */
export function runEventsToTaskState(
	taskId: string,
	events: TediRunTaskEvent[],
): McpTaskState {
	let earliest: TediRunTaskEvent | undefined;
	let latest: TediRunTaskEvent | undefined;
	let terminalEvent: TediRunTaskEvent | undefined;
	let outputMessageId: string | undefined;
	let outputMessageAtMs = -1;
	let conversationId: string | undefined;
	const requestedApprovalIds = new Set<string>();
	const resolvedApprovalIds = new Set<string>();

	for (const event of events) {
		const atMs = eventTimeMs(event);
		if (!earliest || atMs < eventTimeMs(earliest)) earliest = event;
		if (!latest || atMs >= eventTimeMs(latest)) latest = event;
		if (!conversationId && typeof event.conversationId === "string") {
			conversationId = event.conversationId;
		}

		const kind = typeof event.kind === "string" ? event.kind : "";
		if (
			TERMINAL_EVENT_TASK_STATUS[kind] &&
			(!terminalEvent || atMs >= eventTimeMs(terminalEvent))
		) {
			terminalEvent = event;
		}
		if (
			kind === "message.completed" &&
			typeof event.messageId === "string" &&
			atMs >= outputMessageAtMs
		) {
			outputMessageId = event.messageId;
			outputMessageAtMs = atMs;
		}
		if (kind === "approval.requested" && event.approvalRequestId) {
			requestedApprovalIds.add(String(event.approvalRequestId));
		}
		if (kind === "approval.resolved" && event.approvalRequestId) {
			resolvedApprovalIds.add(String(event.approvalRequestId));
		}
	}

	const pendingApprovalIds = [...requestedApprovalIds].filter(
		(id) => !resolvedApprovalIds.has(id),
	);

	const terminalStatus = terminalEvent
		? TERMINAL_EVENT_TASK_STATUS[String(terminalEvent.kind)]
		: undefined;
	const status: McpTaskStatus =
		terminalStatus ??
		(pendingApprovalIds.length > 0 ? "input_required" : "working");

	const nowIso = new Date().toISOString();
	const state: McpTaskState = {
		taskId,
		status,
		createdAt: earliest?.createdAt ?? nowIso,
		lastUpdatedAt: latest?.createdAt ?? earliest?.createdAt ?? nowIso,
		ttlMs: null,
	};

	if (status === "working") {
		state.pollIntervalMs = TEDI_RUN_TASK_POLL_INTERVAL_MS;
		state.statusMessage =
			"Tedi run is still working. Poll tasks/get, or use messages_read for the canonical transcript.";
	} else if (status === "input_required") {
		state.pollIntervalMs = TEDI_RUN_TASK_POLL_INTERVAL_MS;
		state.statusMessage =
			"Tedi run is waiting on a runtime approval. Approvals are durable — resolve via permissions_list_open + permissions_respond (requires tedi:permissions.write), not tasks/update.";
		state.inputRequests = {
			approval: {
				runId: taskId,
				approvalRequestIds: pendingApprovalIds,
				listWith: "permissions_list_open",
				respondWith: "permissions_respond",
			},
		};
	} else {
		const result: Record<string, unknown> = {
			runId: taskId,
			runStatus:
				status === "completed"
					? "completed"
					: status === "failed"
						? "failed"
						: "canceled",
			readWith: "messages_read",
		};
		if (conversationId) result.conversationId = conversationId;
		if (outputMessageId) result.outputMessageId = outputMessageId;
		if (terminalEvent?.createdAt) result.completedAt = terminalEvent.createdAt;
		state.result = result;

		if (status === "failed") {
			state.error = {
				code: -32_603,
				message: failureMessage(terminalEvent),
				data: { runId: taskId },
			};
		}
	}

	return state;
}
