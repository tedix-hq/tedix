/**
 * MCP task-handle surface for governed Tedix OS gadget executions
 * (`run_os_gadget` → apps/api `osWorkspaces/gadgets/run`).
 *
 * A gadget run DISPATCHES the governed skill its manifest names through
 * skill-runtime /run — there is no new dispatch primitive and no gadget-code
 * loading here. When the run receipt is non-terminal, including while it is
 * parked before dispatch for human approval, the handler persists the routing
 * triple (workspaceId + gadgetId + executionId) as an `mcp_tasks` row and emits
 * an internal marker. The outer transport rewrites that marker to the native
 * MCP Task result; no task field is added to API structuredContent. Aggregate
 * `tasks/get` resolves the poll to `osWorkspaces/executions/get` and settles
 * from the receipt — the receipt is authoritative; the store row is routing
 * only.
 *
 * The routing row is created before an approval decision even though runId is
 * still null; polling always resolves the authoritative receipt live, and the
 * run id is not needed to address it.
 */

import { McpTaskError, type McpTaskState } from "@tedix/mcp-shared/tasks";
import { callApiRpc } from "../lib/rpc";
import { contentFreeMcpException, createMcpLogger } from "../log";
import {
	createGenericTask,
	readGenericTaskInputSnapshot,
} from "./generic-task-store";
import { isRecord } from "@tedix/api-contract/utils/is-record";

const log = createMcpLogger("mcp.os_gadget_task");

export const OS_GADGET_TASK_PREFIX = "os-gadget-";

/** apps/api endpoint the `run_os_gadget` operator tool dispatches (rpc transport). */
export const OS_GADGET_RUN_ENDPOINT = "osWorkspaces/gadgets/run";

const OS_GADGET_TASK_RPC_TIMEOUT_MS = 10_000;

/** Suggested poll cadence while the governed run is still pending. */
export const OS_GADGET_TASK_POLL_INTERVAL_MS = 2_500;

/**
 * Routing rows must outlive long governed skill runs, so they get a far longer
 * TTL than the generic 15 minutes. The row's own status/TTL is never projected
 * to the client — `tasks/get` resolves the receipt live.
 */
const OS_GADGET_TASK_TTL_MS = 24 * 60 * 60 * 1000;

/** Non-terminal receipt statuses that mean the governed run is still pending. */
const DISPATCHED_PENDING_STATUSES = new Set([
	"queued",
	"awaiting_approval",
	"running",
]);

export function isOsGadgetTaskId(taskId: string): boolean {
	return taskId.startsWith(OS_GADGET_TASK_PREFIX);
}

/** Lineage run id of the dispatched governed skill run. */
function executionRunId(execution: Record<string, unknown>): string | null {
	const lineage = isRecord(execution.lineage) ? execution.lineage : null;
	const value = lineage?.runId;
	return typeof value === "string" && value ? value : null;
}

export interface DispatchedOsGadgetExecution {
	executionId: string;
	workspaceId: string;
	gadgetId: string;
	runId: string | null;
}

/**
 * Detect a governed pending receipt in a `gadgets/run` rpc result. A parked
 * receipt has no run id until approval settlement dispatches it, but it still
 * needs a durable MCP task handle so a headless caller can poll the exact
 * receipt through the decision and runtime phases.
 */
export function readDispatchedOsGadgetExecution(
	data: unknown,
): DispatchedOsGadgetExecution | null {
	if (!isRecord(data)) return null;
	const execution = data.execution;
	if (!isRecord(execution)) return null;
	const status = execution.status;
	if (typeof status !== "string" || !DISPATCHED_PENDING_STATUSES.has(status)) {
		return null;
	}
	const runId = executionRunId(execution);
	const executionId = typeof execution.id === "string" ? execution.id : "";
	const workspaceId =
		typeof execution.workspaceId === "string" ? execution.workspaceId : "";
	const gadgetId =
		typeof execution.gadgetId === "string" ? execution.gadgetId : "";
	if (!executionId || !workspaceId || !gadgetId) return null;
	return { executionId, workspaceId, gadgetId, runId };
}

export interface LinkOsGadgetTaskInput {
	db: D1Database;
	appId: string;
	organizationId: string;
	/** Serving tool id, recorded on the routing row for operator correlation. */
	toolId: string;
	requestId?: string;
	data: Record<string, unknown>;
}

/**
 * Internal transport marker consumed by `tool-execution.ts` and rewritten by
 * the outer MCP transport into the protocol-native `resultType: "task"`
 * response. It is deliberately kept outside structuredContent so API contract
 * output remains schema-valid and no compatibility task field leaks publicly.
 */
export interface OsGadgetTaskMarker {
	taskId: string;
	status: "working";
	ttlMs: null;
	pollIntervalMs: number;
}

export interface LinkedOsGadgetTaskResult {
	data: Record<string, unknown>;
	task: OsGadgetTaskMarker | null;
}

/**
 * Link a dispatched `gadgets/run` result to its durable task routing row.
 * Non-dispatched results (admission-only, denied, or terminal) pass through
 * untouched. If the routing row cannot be written, the synchronous result is
 * returned instead — a task id that can never resolve is worse than no task
 * handle (the receipt is still inline).
 */
export async function linkOsGadgetTask(
	input: LinkOsGadgetTaskInput,
): Promise<LinkedOsGadgetTaskResult> {
	const dispatched = readDispatchedOsGadgetExecution(input.data);
	if (!dispatched) return { data: input.data, task: null };
	const taskId = `${OS_GADGET_TASK_PREFIX}${dispatched.executionId}`;
	try {
		await createGenericTask({
			db: input.db,
			taskId,
			orgId: input.organizationId,
			appId: input.appId,
			toolName: input.toolId,
			requestId: input.requestId ?? null,
			inputArgs: {
				workspaceId: dispatched.workspaceId,
				gadgetId: dispatched.gadgetId,
				executionId: dispatched.executionId,
				...(dispatched.runId ? { runId: dispatched.runId } : {}),
			},
			ttlMs: OS_GADGET_TASK_TTL_MS,
			pollIntervalMs: OS_GADGET_TASK_POLL_INTERVAL_MS,
		});
	} catch (error) {
		log.error("OS gadget task routing write failed", {
			event: "os_gadget_task.routing_write_failed",
			appId: input.appId,
			organizationId: input.organizationId,
			toolName: input.toolId,
			taskId,
			executionId: dispatched.executionId,
			outcome: "unavailable",
			error: contentFreeMcpException(error),
		});
		return { data: input.data, task: null };
	}
	return {
		data: input.data,
		task: {
			taskId,
			status: "working",
			ttlMs: null,
			pollIntervalMs: OS_GADGET_TASK_POLL_INTERVAL_MS,
		},
	};
}

/**
 * Project one execution receipt to MCP task state.
 *
 * Pending (queued / awaiting_approval / running) → `working` with a status
 * note; terminal (completed / failed / canceled / denied) → terminal with the
 * receipt inlined, mirroring how the tedi-run branch inlines its final result.
 * Approvals never flow through tasks/update — the awaiting_approval note
 * points at permissions_list_open / permissions_respond.
 */
export function osGadgetExecutionToTaskState(
	taskId: string,
	execution: Record<string, unknown>,
): McpTaskState {
	const status = typeof execution.status === "string" ? execution.status : "";
	const createdAt =
		typeof execution.createdAt === "string"
			? execution.createdAt
			: new Date().toISOString();
	const completedAt =
		typeof execution.completedAt === "string" ? execution.completedAt : null;
	const base = {
		taskId,
		createdAt,
		lastUpdatedAt: completedAt ?? createdAt,
		ttlMs: null,
	};
	if (status === "completed") {
		return { ...base, status: "completed", result: { execution } };
	}
	if (status === "failed") {
		return {
			...base,
			status: "failed",
			error: {
				code: -32_603,
				message:
					typeof execution.error === "string" && execution.error
						? execution.error
						: "Gadget execution failed",
				data: { execution },
			},
		};
	}
	if (status === "denied") {
		const policyDecision = isRecord(execution.policyDecision)
			? execution.policyDecision
			: undefined;
		const reasons = Array.isArray(policyDecision?.reasons)
			? policyDecision.reasons.filter(
					(reason): reason is string => typeof reason === "string",
				)
			: [];
		return {
			...base,
			status: "failed",
			error: {
				code: -32_603,
				message:
					reasons.length > 0
						? `Gadget execution denied by policy: ${reasons.join("; ")}`
						: "Gadget execution denied by policy",
				data: { execution },
			},
		};
	}
	if (status === "canceled" || status === "cancelled") {
		return { ...base, status: "cancelled", result: { execution } };
	}
	// queued / awaiting_approval / running — and, defensively, any future
	// non-terminal status — keep the poll alive with a phase note.
	const statusMessage =
		status === "queued"
			? "Gadget execution admitted; the governed skill run is queued for dispatch."
			: status === "awaiting_approval"
				? "The governed skill run is awaiting approval. List pending approvals with permissions_list_open and resolve them with permissions_respond — approvals do not flow through tasks/update."
				: status === "running"
					? "The governed skill run is executing."
					: `Gadget execution is pending (status: ${status || "unknown"}).`;
	return {
		...base,
		status: "working",
		statusMessage,
		pollIntervalMs: OS_GADGET_TASK_POLL_INTERVAL_MS,
	};
}

export interface GetOsGadgetTaskStateInput {
	env: CloudflareEnv;
	organizationId: string;
	taskId: string;
}

/**
 * Resolve an `os-gadget-<executionId>` task id: read the routing triple from
 * the org-scoped store row, fetch the receipt via `osWorkspaces/executions/get`
 * (service-binding + X-Tedix-Org-Id, mirroring the tedi-run branch's
 * callCognitiveRuntime), and project it to task state. Missing/foreign rows
 * and missing receipts are indistinguishable not-found.
 */
export async function getOsGadgetTaskState(
	input: GetOsGadgetTaskStateInput,
): Promise<McpTaskState> {
	const routing = await readGenericTaskInputSnapshot(
		input.env.DB,
		input.taskId,
		input.organizationId,
	);
	const workspaceId =
		typeof routing?.workspaceId === "string" ? routing.workspaceId : "";
	const gadgetId =
		typeof routing?.gadgetId === "string" ? routing.gadgetId : "";
	const executionId =
		typeof routing?.executionId === "string" ? routing.executionId : "";
	if (!workspaceId || !gadgetId || !executionId) {
		throw McpTaskError.notFound(input.taskId);
	}
	let result: { data: unknown; status: number };
	try {
		result = await callApiRpc(
			input.env,
			"osWorkspaces/executions/get",
			{ workspaceId, gadgetId, executionId },
			{
				headers: { "X-Tedix-Org-Id": input.organizationId },
				timeoutMs: OS_GADGET_TASK_RPC_TIMEOUT_MS,
			},
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new McpTaskError(
			-32_603,
			`gadget execution read failed: ${message}`,
			{ taskId: input.taskId },
		);
	}
	if (result.status === 404) throw McpTaskError.notFound(input.taskId);
	if (result.status >= 400) {
		throw new McpTaskError(-32_603, "gadget execution read failed", {
			taskId: input.taskId,
			status: result.status,
		});
	}
	const payload =
		isRecord(result.data) && "json" in result.data
			? (result.data as { json: unknown }).json
			: result.data;
	const execution = isRecord(payload) ? payload.execution : undefined;
	if (!isRecord(execution)) throw McpTaskError.notFound(input.taskId);
	return osGadgetExecutionToTaskState(input.taskId, execution);
}
