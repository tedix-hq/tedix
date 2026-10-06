/**
 * Generic server-side MCP Tasks store helpers.
 *
 * Backs config-driven async tools (`config._asyncTask === true`) that have no
 * first-class run ledger. Home runs project `kernel_runtime_runs` and per-tedi
 * runs project `tedi_runtime_events`; this store is only for generic tools.
 *
 * Public task ids are namespaced `generic-<uuid>` so the aggregate task handler
 * can route `tasks/get|update|cancel` here without colliding with bare kernel
 * run ids or namespaced `tedi:<id>:<runId>` ids.
 */

import { createDbClient } from "@tedix/db/client";
import { mcpTasks, type NewMcpTask } from "@tedix/db/schema/mcp-tasks";
import { toJsonRecord } from "@tedix/db/utils/json";
import {
	McpTaskError,
	type McpTaskState,
	type McpTaskStatus,
} from "@tedix/mcp-shared/tasks";
import { and, eq } from "drizzle-orm";

export const GENERIC_TASK_PREFIX = "generic-";

/** Default protocol-visible TTL for a generic task (15 minutes). */
export const GENERIC_TASK_TTL_MS = 15 * 60 * 1000;
/** Suggested poll cadence while a generic task is still working. */
export const GENERIC_TASK_POLL_INTERVAL_MS = 2_000;

export function isGenericTaskId(taskId: string): boolean {
	return taskId.startsWith(GENERIC_TASK_PREFIX);
}

/** Mint a fresh `generic-<uuid>` task id. */
export function newGenericTaskId(): string {
	return `${GENERIC_TASK_PREFIX}${crypto.randomUUID()}`;
}

/**
 * Minimal execution snapshot the GenericTasksWorkflow needs to dispatch the
 * tool out-of-band without re-resolving D1/ServerContext. Captured at task
 * creation from `tool.config`. Only `rpc`/`rest`-transport tools are executable
 * from the workflow today; other transports are recorded but reported as a
 * documented seam.
 */
export interface GenericTaskExecConfig {
	transport?: string;
	endpoint?: string;
	method?: string;
	responsePath?: string;
}

/**
 * Durable caller-identity REFERENCES captured at task-creation so the detached
 * GenericTasksWorkflow can replay the caller's authority context (not the
 * caller's credentials) on the out-of-band dispatch, and apps/api can re-derive
 * the correct credential leg + re-validate authority server-side.
 *
 * SECURITY — what is deliberately absent and why:
 *  - no `token`/`bearer`/`accessToken`: a stored bearer is a long-lived
 *    credential at rest and a confused-deputy seed. Service-binding is the trust
 *    anchor for the replay; apps/api resolves the credential server-side from
 *    these identity references.
 *  - no `scopes`: caller scopes are ingress authority and must not become a
 *    stored confused-deputy capability. The detached workflow delegates exact
 *    API procedure scopes from its code-owned endpoint map instead.
 *  - no `credentialMode`: it can STEER credential resolution
 *    (e.g. aih-m2m vs user vs tedi); letting apps/api re-derive it from the
 *    identity references server-side keeps the resolver authoritative.
 */
export interface CapturedCaller {
	authType?: string;
	userId?: string;
	tediId?: string;
	organizationId?: string;
	clientId?: string;
	kernel?: boolean;
	connectionLabel?: string;
}

export interface CreateGenericTaskInput {
	db: D1Database;
	taskId: string;
	orgId: string;
	appId: string;
	toolName: string;
	toolId?: string | null;
	requestId?: string | null;
	method?: string;
	/** Tool input snapshot — recorded so the executor can run out-of-band. */
	inputArgs?: Record<string, unknown>;
	/** Execution config snapshot — lets the workflow dispatch without ServerContext. */
	execConfig?: GenericTaskExecConfig;
	/**
	 * Durable caller-identity references (never a token) so the workflow can
	 * replay the caller's authority on the dispatch and apps/api can re-derive
	 * the credential leg + re-validate authority server-side.
	 */
	caller?: CapturedCaller;
	ttlMs?: number;
	pollIntervalMs?: number;
	workflowId?: string | null;
}

/** Build the `input_requests` JSON column from the input + exec-config snapshot. */
function buildInputRequests(
	input: CreateGenericTaskInput,
): ReturnType<typeof toJsonRecord> | null {
	if (!input.inputArgs && !input.execConfig && !input.caller) return null;
	return toJsonRecord({
		...(input.inputArgs ? { input: input.inputArgs } : {}),
		...(input.execConfig ? { execConfig: input.execConfig } : {}),
		...(input.caller ? { caller: input.caller } : {}),
	});
}

/** Insert a `working` generic task row. */
export async function createGenericTask(
	input: CreateGenericTaskInput,
): Promise<void> {
	const db = createDbClient(input.db);
	const now = new Date();
	const ttlMs = input.ttlMs ?? GENERIC_TASK_TTL_MS;
	const row: NewMcpTask = {
		id: crypto.randomUUID(),
		taskId: input.taskId,
		orgId: input.orgId,
		subjectUserId: input.caller?.userId ?? null,
		appId: input.appId,
		toolId: input.toolId ?? null,
		toolName: input.toolName,
		requestId: input.requestId ?? null,
		method: input.method ?? "tools/call",
		status: "working",
		ttlMs,
		pollIntervalMs: input.pollIntervalMs ?? GENERIC_TASK_POLL_INTERVAL_MS,
		inputRequests: buildInputRequests(input),
		inputResponses: null,
		result: null,
		error: null,
		workflowId: input.workflowId ?? null,
		cancelRequestedAt: null,
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
	};
	await db.insert(mcpTasks).values(row);
}

/**
 * Persist the Cloudflare Workflow instance id onto an existing generic-task
 * row. The id only exists after `workflow.create(...)`, so this is a follow-up
 * update to the `working` row written by {@link createGenericTask}. Best-effort
 * mirror — keeps the indexed `workflow_id` column populated so the workflow
 * writer and operators can correlate a task to its driving instance.
 */
export async function setGenericTaskWorkflowId(
	d1: D1Database,
	taskId: string,
	orgId: string,
	workflowId: string,
): Promise<void> {
	const db = createDbClient(d1);
	await db
		.update(mcpTasks)
		.set({ workflowId, updatedAt: new Date().toISOString() })
		.where(and(eq(mcpTasks.taskId, taskId), eq(mcpTasks.orgId, orgId)));
}

/**
 * Read the routing snapshot (`input_requests.input`) persisted on a task row,
 * org-scoped. Used by non-`generic-` task namespaces (e.g. `os-gadget-…`,
 * os-gadget-task.ts) that use this store purely as a durable ROUTING record
 * while the authoritative task state lives in a first-class ledger resolved
 * live at `tasks/get`. Missing/foreign rows and rows without a snapshot
 * project as null — the caller owns the not-found mapping.
 */
export async function readGenericTaskInputSnapshot(
	d1: D1Database,
	taskId: string,
	orgId: string,
): Promise<Record<string, unknown> | null> {
	const db = createDbClient(d1);
	const rows = await db
		.select()
		.from(mcpTasks)
		.where(eq(mcpTasks.taskId, taskId))
		.limit(1);
	const row = rows[0];
	if (!row || row.orgId !== orgId) return null;
	const snapshot = row.inputRequests as Record<string, unknown> | null;
	const input = snapshot?.input;
	return typeof input === "object" && input !== null && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: null;
}

function isExpired(expiresAt: string | null, status: McpTaskStatus): boolean {
	if (status !== "working" && status !== "input_required") return false;
	if (!expiresAt) return false;
	const ms = new Date(expiresAt).getTime();
	return Number.isFinite(ms) && ms <= Date.now();
}

/**
 * Project a stored generic task row to MCP task state, scoped by org. A row for
 * a different org (or an unknown id) projects as not-found (`-32602`).
 */
export async function getGenericTaskState(
	d1: D1Database,
	taskId: string,
	orgId: string,
	subjectUserId?: string,
): Promise<McpTaskState> {
	const db = createDbClient(d1);
	const rows = await db
		.select()
		.from(mcpTasks)
		.where(eq(mcpTasks.taskId, taskId))
		.limit(1);
	const row = rows[0];
	if (
		!row ||
		row.orgId !== orgId ||
		(row.subjectUserId !== null && row.subjectUserId !== subjectUserId)
	)
		throw McpTaskError.notFound(taskId);

	let status = row.status as McpTaskStatus;
	let statusMessage: string | undefined;

	// TTL expiry — a non-terminal task past its expiry projects as failed and is
	// flipped in the store so cleanup/readback is consistent.
	if (isExpired(row.expiresAt, status)) {
		status = "failed";
		statusMessage = "Task expired before completion.";
		await db
			.update(mcpTasks)
			.set({
				status: "failed",
				error: {
					code: -32_603,
					message: "Task expired before completion (TTL elapsed).",
				},
				updatedAt: new Date().toISOString(),
			})
			.where(eq(mcpTasks.taskId, taskId));
	}

	const state: McpTaskState = {
		taskId: row.taskId,
		status,
		createdAt: row.createdAt,
		lastUpdatedAt: row.updatedAt,
		ttlMs: row.ttlMs ?? null,
	};
	if (statusMessage) state.statusMessage = statusMessage;
	if (status === "working" || status === "input_required") {
		state.pollIntervalMs = row.pollIntervalMs ?? GENERIC_TASK_POLL_INTERVAL_MS;
	}
	if (status === "input_required" && row.inputRequests) {
		state.inputRequests = row.inputRequests;
	}
	if (status === "completed" && row.result) {
		state.result = row.result;
	}
	if (status === "failed") {
		const err = row.error as {
			code?: unknown;
			message?: unknown;
			data?: unknown;
		} | null;
		state.error = {
			code: typeof err?.code === "number" ? err.code : -32_603,
			message:
				typeof err?.message === "string"
					? err.message
					: (statusMessage ?? "Task failed"),
			...(err && "data" in err ? { data: err.data } : {}),
		};
	}
	return state;
}

/**
 * Cooperative cancellation — set `cancel_requested_at` and, if still working,
 * mark the task cancelled. The Workflow re-reads the marker before writing a
 * terminal result so a late-landing execution still loses to the cancel.
 */
export async function cancelGenericTask(
	d1: D1Database,
	taskId: string,
	orgId: string,
	subjectUserId?: string,
): Promise<McpTaskState> {
	const db = createDbClient(d1);
	const rows = await db
		.select()
		.from(mcpTasks)
		.where(eq(mcpTasks.taskId, taskId))
		.limit(1);
	const row = rows[0];
	if (
		!row ||
		row.orgId !== orgId ||
		(row.subjectUserId !== null && row.subjectUserId !== subjectUserId)
	)
		throw McpTaskError.notFound(taskId);

	const status = row.status as McpTaskStatus;
	if (status === "completed" || status === "failed" || status === "cancelled") {
		throw new McpTaskError(
			-32_000,
			`Task is already ${status}; nothing to cancel.`,
			{ taskId, status },
		);
	}

	const now = new Date().toISOString();
	await db
		.update(mcpTasks)
		.set({ status: "cancelled", cancelRequestedAt: now, updatedAt: now })
		.where(eq(mcpTasks.taskId, taskId));

	return getGenericTaskState(d1, taskId, orgId, subjectUserId);
}

/**
 * Store mid-flight input responses (MRTR). Records `input_responses` and, when
 * the task was awaiting input, returns it to `working` so the executor can
 * resume. Unknown/foreign tasks → not-found.
 */
export async function updateGenericTaskInput(
	d1: D1Database,
	taskId: string,
	orgId: string,
	inputResponses: Record<string, unknown>,
	subjectUserId?: string,
): Promise<void> {
	const db = createDbClient(d1);
	const rows = await db
		.select()
		.from(mcpTasks)
		.where(eq(mcpTasks.taskId, taskId))
		.limit(1);
	const row = rows[0];
	if (
		!row ||
		row.orgId !== orgId ||
		(row.subjectUserId !== null && row.subjectUserId !== subjectUserId)
	)
		throw McpTaskError.notFound(taskId);

	const status = row.status as McpTaskStatus;
	if (status === "completed" || status === "failed" || status === "cancelled") {
		throw new McpTaskError(
			-32_000,
			`Task is already ${status}; cannot submit input.`,
			{ taskId, status },
		);
	}

	const merged = {
		...row.inputResponses,
		...inputResponses,
	};
	await db
		.update(mcpTasks)
		.set({
			inputResponses: toJsonRecord(merged),
			// Resume work if we were blocked on input.
			...(status === "input_required" ? { status: "working" as const } : {}),
			updatedAt: new Date().toISOString(),
		})
		.where(eq(mcpTasks.taskId, taskId));
}
