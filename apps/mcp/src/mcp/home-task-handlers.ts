/**
 * MCP tasks extension (`io.modelcontextprotocol/tasks`) handlers backed by
 * the kernel runtime (docs/product/tedix-os.md "Home MCP Contract").
 *
 * Why: `ask` turns can run 40–60s while many MCP callers time out at
 * ~15s. The protocol-shaped recovery is the tasks extension — `ask`
 * returns `task.id = homeRunId` (see `_emitTaskLinkage` in home-surface.ts +
 * handler.ts), and callers poll `tasks/get` until the run is terminal.
 *
 * Identity / scoping model mirrors the `home__*` surface tools exactly:
 *  - Handlers are built per request with the same org resolution the home
 *    tools use (`callerIdentity.organizationId ?? app.organizationId`) and
 *    only on the platform-operator surface (see wiring in `src/index.ts`).
 *  - Calls ride the apps/api service binding with `X-Service-Binding` +
 *    `X-Tedix-Org-Id` headers; `kernelRuntime.readRun` / `kernelRuntime.cancelRun`
 *    scope every query by that org server-side, so a task id from another org
 *    is indistinguishable from a missing one → `Task not found`.
 *  - Approvals stay on the durable approval path: `tasks/update` returns a
 *    structured error directing callers to `respond_home_approval`, with
 *    `approve_home_plan` reserved for proposed-plan assignment approval.
 */

import type { HomeRun } from "@tedix/api-contract/schemas/kernel-runtime";
import { delegatedMachineScopes } from "@tedix/mcp-shared/auth/scopes";
import {
	McpTaskError,
	type McpTaskHandlers,
	type McpTaskState,
	type McpTaskStatus,
} from "@tedix/mcp-shared/tasks";
import { callApiRpc } from "../lib/rpc";
import { isRecord } from "@tedix/api-contract/utils/is-record";

/** Home run status (D1 `kernel_runtime_runs`) → MCP task status. */
const HOME_RUN_TASK_STATUS: Record<string, McpTaskStatus> = {
	queued: "working",
	running: "working",
	requires_approval: "input_required",
	completed: "completed",
	failed: "failed",
	canceled: "cancelled",
};

const TERMINAL_TASK_STATUSES: ReadonlySet<McpTaskStatus> = new Set([
	"completed",
	"failed",
	"cancelled",
]);

/** Suggested poll cadence while a Home run is still working. */
const HOME_TASK_POLL_INTERVAL_MS = 2_500;

/** Same ceiling class as the home-surface RPC tools — apps/api is a service
 * binding hop away, these are single-row reads/patches. */
const HOME_TASK_RPC_TIMEOUT_MS = 10_000;
const HOME_APPROVAL_TOOL = "respond_home_approval";
const HOME_PLAN_APPROVAL_TOOL = "approve_home_plan";

export interface BuildHomeTaskHandlersInput {
	env: CloudflareEnv;
	/** Caller org — resolved exactly like the `home__*` tools (handler.ts):
	 * `callerIdentity.organizationId ?? app.organizationId`. */
	organizationId: string;
	/** Verified caller scopes delegated across the service-binding hop. */
	callerScopes?: readonly string[];
}

/**
 * Minimal oRPC client against the apps/api `kernelRuntime` router, mirroring
 * the canonical dynamic API transport (service binding preferred and
 * `X-Tedix-Org-Id` org scoping).
 */
async function callKernelRuntime(
	env: CloudflareEnv,
	organizationId: string,
	callerScopes: readonly string[],
	endpoint: "kernelRuntime/readRun" | "kernelRuntime/cancelRun",
	params: Record<string, unknown>,
): Promise<{ data: unknown; status: number }> {
	try {
		const delegatedScopes = [
			...new Set([
				...callerScopes,
				...delegatedMachineScopes([...callerScopes]),
			]),
		];
		return await callApiRpc(env, endpoint, params, {
			headers: {
				"X-Tedix-Org-Id": organizationId,
				...(delegatedScopes.length > 0
					? { "X-Tedix-Tedi-Scopes": delegatedScopes.join(" ") }
					: {}),
			},
			timeoutMs: HOME_TASK_RPC_TIMEOUT_MS,
		});
	} catch (error) {
		if (error instanceof Error && error.message.includes("timed out")) {
			throw new McpTaskError(
				-32_603,
				`kernel runtime request timed out after ${HOME_TASK_RPC_TIMEOUT_MS}ms`,
			);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new McpTaskError(
			-32_603,
			`kernel runtime request failed: ${message}`,
		);
	}
}

function upstreamErrorMessage(data: unknown, status: number): string {
	if (isRecord(data)) {
		if (typeof data.message === "string" && data.message) return data.message;
		if (typeof data.error === "string" && data.error) return data.error;
	}
	return `kernel runtime request failed with status ${status}`;
}

/** Loose structural check — the contract (`HomeRunSchema`) guarantees shape;
 * we only assert the fields the mapping depends on. */
function extractRun(data: unknown): HomeRun | undefined {
	if (!isRecord(data)) return undefined;
	const run = data.run;
	if (!isRecord(run)) return undefined;
	if (typeof run.id !== "string" || typeof run.status !== "string") {
		return undefined;
	}
	return run as unknown as HomeRun;
}

/**
 * Map a Home run row to MCP task state:
 * queued|running → working, requires_approval → input_required,
 * completed → completed, failed → failed, canceled → cancelled.
 */
export function homeRunToTaskState(run: HomeRun): McpTaskState {
	// Unknown (future) statuses degrade to "working" rather than erroring —
	// the contract enum is the source of truth (TediRunStatusSchema).
	const metadata: Record<string, unknown> = isRecord(run.metadata)
		? run.metadata
		: {};
	// Home persists the run envelope before the asynchronous turn body finishes.
	// During that window the row can already say `completed`, while the route,
	// answer, usage, and execution result have not been written yet. Exposing that
	// provisional row as a terminal MCP Task makes clients stop polling and render
	// an empty answer. `bodyExecutionResult` fences local turn completion.
	const hasCompletedTurnBody = isRecord(metadata.bodyExecutionResult);
	// Explicit delegation skips the local turn body. Its completion comes from
	// the durable child event ledger, reconciled by kernelRuntime.readRun along
	// with the classified child status and answer preview. An output-message
	// pointer alone is insufficient: it can precede the completion message write.
	const hasCompletedDelegation = Boolean(
		run.delegatedTediId &&
		run.childRunId &&
		metadata.childRunStatus === "completed" &&
		metadata.childRunTerminalEventKind === "run.completed",
	);
	const mappedStatus = HOME_RUN_TASK_STATUS[run.status] ?? "working";
	const status =
		mappedStatus === "completed" &&
		!hasCompletedTurnBody &&
		!hasCompletedDelegation
			? "working"
			: mappedStatus;
	const terminal = TERMINAL_TASK_STATUSES.has(status);

	const state: McpTaskState = {
		taskId: run.id,
		status,
		createdAt: run.createdAt,
		lastUpdatedAt:
			run.updatedAt ?? run.completedAt ?? run.startedAt ?? run.createdAt,
		ttlMs: null,
	};

	if (!terminal) {
		state.pollIntervalMs = HOME_TASK_POLL_INTERVAL_MS;
	}

	const progressDetail = run.progress?.detail ?? run.progress?.label;
	if (status === "input_required") {
		state.statusMessage =
			"Home run requires approval before it can continue. Approvals are durable — respond via respond_home_approval, not tasks/update.";
		state.inputRequests = {
			approval: {
				homeRunId: run.id,
				approveWith: HOME_APPROVAL_TOOL,
				rejectWith: HOME_APPROVAL_TOOL,
				planOnlyApproveWith: HOME_PLAN_APPROVAL_TOOL,
			},
		};
	} else if (progressDetail) {
		state.statusMessage = progressDetail;
	}

	if (terminal) {
		// Cheaply available from the run row: route metadata + pointers to the
		// assistant output. Full assistant content lives on the transcript —
		// read_home_run / read_home_messages retrieve it.
		const result: Record<string, unknown> = {
			homeRunId: run.id,
			conversationId: run.conversationId,
			runStatus: run.status,
			readWith: "read_home_run / read_home_messages",
		};
		if (run.outputMessageId != null) {
			result.outputMessageId = run.outputMessageId;
		}
		if (run.delegatedTediId != null) {
			result.delegatedTediId = run.delegatedTediId;
		}
		if (run.childRunId != null) result.childRunId = run.childRunId;
		if (run.completedAt != null) result.completedAt = run.completedAt;
		if (metadata.kernelRoute !== undefined) {
			result.kernelRoute = metadata.kernelRoute;
		}
		const kernelRoute = isRecord(metadata.kernelRoute)
			? metadata.kernelRoute
			: {};
		const bodyExecutionResult = isRecord(metadata.bodyExecutionResult)
			? metadata.bodyExecutionResult
			: {};
		const assistantText = [
			kernelRoute.answer,
			kernelRoute.clarifyingQuestion,
			bodyExecutionResult.summary,
			metadata.childRunPreview,
		].find((value) => typeof value === "string" && value.trim());
		if (typeof assistantText === "string") result.assistantText = assistantText;
		if (typeof metadata.childRunPreview === "string") {
			result.childRunPreview = metadata.childRunPreview;
		}
		state.result = result;

		if (status === "failed") {
			state.error = {
				code: -32_603,
				message:
					typeof metadata.error === "string" && metadata.error
						? metadata.error
						: "Home run failed",
				data: { homeRunId: run.id },
			};
		}
	}

	return state;
}

/**
 * Build org-scoped `tasks/get|update|cancel` handlers for `mountMcp()`.
 * Task id = homeRunId (the `run.id` returned by `ask`).
 */
export function buildHomeTaskHandlers(
	input: BuildHomeTaskHandlersInput,
): McpTaskHandlers {
	const { env, organizationId } = input;
	const callerScopes = input.callerScopes ?? [];

	return {
		async get({ taskId }) {
			const { data, status } = await callKernelRuntime(
				env,
				organizationId,
				callerScopes,
				"kernelRuntime/readRun",
				{ runId: taskId },
			);
			// Cross-org task ids surface as 404 — readRun's query is org-scoped,
			// so "exists in another org" and "does not exist" are identical here.
			if (status === 404) throw McpTaskError.notFound(taskId);
			if (status >= 400) {
				throw new McpTaskError(-32_603, upstreamErrorMessage(data, status), {
					taskId,
				});
			}
			const run = extractRun(data);
			if (!run) {
				throw new McpTaskError(
					-32_603,
					"kernel runtime returned an unexpected readRun payload",
					{ taskId },
				);
			}
			return homeRunToTaskState(run);
		},

		async update({ taskId }) {
			// Approvals stay on the durable approval path — there is no
			// tasks/update seam into Home approval by design.
			throw new McpTaskError(
				-32_000,
				"Home approvals do not flow through tasks/update. Use respond_home_approval to approve or reject the pending Home approval; approve_home_plan is only for proposed plan assignment approval.",
				{
					taskId,
					approveWith: HOME_APPROVAL_TOOL,
					rejectWith: HOME_APPROVAL_TOOL,
					planOnlyApproveWith: HOME_PLAN_APPROVAL_TOOL,
				},
			);
		},

		async cancel({ taskId }) {
			const { data, status } = await callKernelRuntime(
				env,
				organizationId,
				callerScopes,
				"kernelRuntime/cancelRun",
				{ runId: taskId, reason: "Canceled via MCP tasks/cancel" },
			);
			if (status === 404) throw McpTaskError.notFound(taskId);
			if (status >= 400) {
				// e.g. CONFLICT when the run is already terminal — surface the
				// upstream message as a structured task error.
				throw new McpTaskError(-32_000, upstreamErrorMessage(data, status), {
					taskId,
				});
			}
			const run = extractRun(data);
			if (!run) {
				throw new McpTaskError(
					-32_603,
					"kernel runtime returned an unexpected cancelRun payload",
					{ taskId },
				);
			}
		},
	};
}
