/**
 * Aggregate MCP tasks handlers (`io.modelcontextprotocol/tasks`) for any
 * tenant aggregator surface — the `*-unified` apps (e.g. `tedix-unified`,
 * `acme-unified`) and any app that exposes the home/kernel surface
 * (`shouldExposeHomeSurface`: the operator slug or any app with
 * `aggregateApps`). This is not specific to `tedix-unified`.
 *
 * Tenants that talk to a tedi directly (`{slug}.tedi.<domain>/mcp`) or to the
 * kernel without an aggregator are served by those surfaces' own task handlers
 * (apps/tedi `buildTediRunTaskHandlers`, home `buildHomeTaskHandlers`); this
 * handler only adds the aggregator's cross-surface routing.
 *
 * The aggregate serves two kinds of task ids through one `tasks/get|cancel`:
 *  - **Kernel runs** — bare ids (the `ask` tool returns `task.id = the
 *    kernel runId`), resolved by the kernel-run handler
 *    (`buildHomeTaskHandlers` → kernelRuntime.readRun/cancelRun; the "home"
 *    naming is the legacy MCP-surface label — the runtime is the kernel).
 *  - **Tedi runs** — namespaced `tedi:<tediId>:<runId>` ids. Aggregate tedi
 *    tools (e.g. `cto.run_tedi_turn`) emit a tedi-run linkage; handler.ts
 *    namespaces it with the owning tedi so this surface can route the poll to
 *    the per-tedi run projection (cognitiveRuntime.listEvents over
 *    `tedi_runtime_events`), mirroring apps/tedi's per-tedi task handlers.
 *
 * This makes kernel→tedi (delegation child runs) and tedi→tedi (proxied
 * `run_tedi_turn`) flows pollable end to end through the aggregate, not only at
 * each per-tedi server.
 */

import { delegatedMachineScopes } from "@tedix/mcp-shared/auth/scopes";
import {
	eventsFromApi,
	McpTaskError,
	type McpTaskHandlers,
	type McpTaskState,
	runEventsToTaskState,
} from "@tedix/mcp-shared/tasks";
import { callApiRpc } from "../lib/rpc";
import { publishMcpTaskNotification } from "../subscription-publisher";
import type { CallerIdentity } from "./caller-identity";
import {
	cancelGenericTask,
	getGenericTaskState,
	isGenericTaskId,
	updateGenericTaskInput,
} from "./generic-task-store";
import {
	type BuildHomeTaskHandlersInput,
	buildHomeTaskHandlers,
} from "./home-task-handlers";
import {
	getOsGadgetTaskState,
	isOsGadgetTaskId,
	OS_GADGET_RUN_ENDPOINT,
} from "./os-gadget-task";
import { isRecord } from "@tedix/api-contract/utils/is-record";

const TEDI_TASK_PREFIX = "tedi:";
const GRAPH_GDS_TASK_PREFIX = "graph-gds-";
const AGG_TASK_RPC_TIMEOUT_MS = 10_000;
const AGG_TASK_EVENT_LIMIT = 200;

/** Parse a namespaced `tedi:<tediId>:<runId>` task id. tediId is a UUID (no
 * colon); the run id is everything after the second separator (it may itself
 * contain colons, e.g. `agent:main:...`). */
function parseTediTaskId(
	taskId: string,
): { tediId: string; runId: string } | null {
	if (!taskId.startsWith(TEDI_TASK_PREFIX)) return null;
	const rest = taskId.slice(TEDI_TASK_PREFIX.length);
	const sep = rest.indexOf(":");
	if (sep <= 0) return null;
	const tediId = rest.slice(0, sep);
	const runId = rest.slice(sep + 1);
	if (!tediId || !runId) return null;
	return { tediId, runId };
}

/** Restore only a bounded task receipt after the MCP edge strips inbound
 * trust headers. The caller must have passed service-binding authentication;
 * public OAuth/API-key ingress never retains a forged receipt. */
export function reassertTrustedWorkflowTediTaskId(
	headers: Headers,
	inboundTaskId: string | null,
	authType: string,
): void {
	const name = "X-Tedix-Workflow-Tedi-Task-Id";
	headers.delete(name);
	if (
		authType === "service-binding" &&
		inboundTaskId &&
		inboundTaskId.length <= 512 &&
		parseTediTaskId(inboundTaskId)
	) {
		headers.set(name, inboundTaskId);
	}
}

function isGraphGdsTaskId(taskId: string): boolean {
	return taskId.startsWith(GRAPH_GDS_TASK_PREFIX);
}

/** Minimal oRPC client against apps/api `cognitiveRuntime` (mirrors the
 * service-binding mechanics in home-task-handlers.ts::callKernelRuntime). */
async function callCognitiveRuntime(
	env: CloudflareEnv,
	organizationId: string,
	endpoint:
		| "cognitiveRuntime/listEvents"
		| "cognitiveRuntime/stopRun"
		| "cognitiveRuntime/readMessages",
	params: Record<string, unknown>,
	delegatedHeaders: Record<string, string> = {},
): Promise<{ data: unknown; status: number }> {
	try {
		return await callApiRpc(env, endpoint, params, {
			headers: { "X-Tedix-Org-Id": organizationId, ...delegatedHeaders },
			timeoutMs: AGG_TASK_RPC_TIMEOUT_MS,
		});
	} catch (error) {
		if (error instanceof Error && error.message.includes("timed out")) {
			throw new McpTaskError(
				-32_603,
				`cognitive runtime request timed out after ${AGG_TASK_RPC_TIMEOUT_MS}ms`,
			);
		}
		const message = error instanceof Error ? error.message : String(error);
		throw new McpTaskError(
			-32_603,
			`cognitive runtime request failed: ${message}`,
		);
	}
}

async function callGraphMaintenance(
	env: CloudflareEnv,
	organizationId: string,
	callerIdentity: CallerIdentity | undefined,
	bearerToken: string | undefined,
	endpoint:
		| "memoryGraph/graph/maintenanceTaskStatus"
		| "memoryGraph/graph/maintenanceTaskCancel",
	taskId: string,
): Promise<{ data: unknown; status: number }> {
	const requiresCredentialReplay = callerIdentity?.authType === "apiKey";
	const useServiceBinding =
		Boolean(env.API_SERVICE) && !requiresCredentialReplay;
	const headers: Record<string, string> = {
		"X-Tedix-Org-Id": organizationId,
	};
	if (
		callerIdentity?.authType === "user" ||
		callerIdentity?.authType === "oauth"
	) {
		if (!bearerToken) {
			throw new McpTaskError(
				-32_603,
				"Graph maintenance task authority cannot be revalidated",
			);
		}
		if (useServiceBinding) {
			headers["X-Forwarded-Authorization"] = `Bearer ${bearerToken}`;
			headers["X-Tedix-Caller-Type"] = "mcp-edge-user";
		} else {
			headers.Authorization = `Bearer ${bearerToken}`;
		}
	} else if (
		(callerIdentity?.authType === "tedi" ||
			callerIdentity?.authType === "service") &&
		callerIdentity.tediId
	) {
		if (!useServiceBinding) {
			throw new McpTaskError(
				-32_603,
				"Graph maintenance tedi authority requires the API service binding",
			);
		}
		headers["X-Tedix-Tedi-Id"] = callerIdentity.tediId;
		if ((callerIdentity.scopes ?? []).length > 0) {
			headers["X-Tedix-Tedi-Scopes"] = [
				...new Set([
					...callerIdentity.scopes!,
					...delegatedMachineScopes(callerIdentity.scopes!),
				]),
			].join(" ");
		}
	} else if (callerIdentity?.authType === "external_agent") {
		throw new McpTaskError(
			-32_603,
			"External agents cannot run graph projection maintenance",
		);
	} else if (requiresCredentialReplay) {
		if (!bearerToken) {
			throw new McpTaskError(
				-32_603,
				"Graph maintenance task credential cannot be replayed",
			);
		}
		headers.Authorization = `Bearer ${bearerToken}`;
	} else {
		throw new McpTaskError(
			-32_603,
			"Graph maintenance task authority cannot be revalidated",
		);
	}
	try {
		return await callApiRpc(
			env,
			endpoint,
			{ taskId },
			{
				headers,
				serviceBinding: useServiceBinding,
				timeoutMs: AGG_TASK_RPC_TIMEOUT_MS,
			},
		);
	} catch (error) {
		if (error instanceof Error && error.message.includes("timed out")) {
			throw new McpTaskError(
				-32_603,
				`graph maintenance request timed out after ${AGG_TASK_RPC_TIMEOUT_MS}ms`,
			);
		}
		throw new McpTaskError(
			-32_603,
			`graph maintenance request failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function graphGdsTaskState(taskId: string, value: unknown): McpTaskState {
	if (!isRecord(value) || value.id !== taskId) {
		throw McpTaskError.notFound(taskId);
	}
	const rawStatus = typeof value.status === "string" ? value.status : "queued";
	const status =
		rawStatus === "completed" && isRecord(value.result)
			? "completed"
			: rawStatus === "completed" || rawStatus === "failed"
				? "failed"
				: rawStatus === "cancelled"
					? "cancelled"
					: "working";
	const createdAt =
		typeof value.createdAt === "string"
			? value.createdAt
			: new Date().toISOString();
	const lastUpdatedAt =
		typeof value.lastUpdatedAt === "string" ? value.lastUpdatedAt : createdAt;
	const base = {
		taskId,
		status,
		createdAt,
		lastUpdatedAt,
		ttlMs: null,
		pollIntervalMs:
			typeof value.pollIntervalMs === "number" ? value.pollIntervalMs : 2_500,
	};
	if (status === "completed") {
		return {
			...base,
			status,
			result: isRecord(value.result)
				? { workflowId: value.workflowId, ...value.result }
				: { workflowId: value.workflowId },
		};
	}
	if (status === "failed") {
		return {
			...base,
			status,
			error: {
				code: -32_603,
				message:
					rawStatus === "completed"
						? "Graph GDS refresh completed without a valid atomic receipt"
						: typeof value.error === "string"
							? value.error
							: "Graph GDS refresh failed",
				data: { workflowId: value.workflowId },
			},
		};
	}
	if (status === "cancelled") return { ...base, status };
	return {
		...base,
		status: "working",
		statusMessage:
			rawStatus === "cancel_requested"
				? "Cancellation requested; waiting for the next safe GDS phase boundary."
				: "Graph GDS refresh is running in a durable Cloudflare Workflow.",
	};
}

/**
 * Inline the tedi run's final assistant content into a COMPLETED task state so
 * `tasks/get` is self-sufficient — a Tasks client no longer needs a follow-up
 * `messages_read`. The pure projection (`runEventsToTaskState`) only has the
 * durable events, so it leaves a `readWith: "messages_read"` pointer with the
 * `outputMessageId`; here (where we have `env`) we resolve that message and add
 * `result.assistant.content`, matching the shape the in-band `run_tedi_turn`
 * reply returns. Best-effort: on any failure the pointer stays, so a client can
 * still recover manually.
 */
async function inlineCompletedTediRunOutput(
	env: CloudflareEnv,
	organizationId: string,
	tediId: string,
	state: McpTaskState,
	delegatedHeaders: Record<string, string> = {},
): Promise<void> {
	if (state.status !== "completed" || !isRecord(state.result)) return;
	const result = state.result;
	if (isRecord(result.assistant)) return; // already inlined
	const conversationId =
		typeof result.conversationId === "string" ? result.conversationId : "";
	const outputMessageId =
		typeof result.outputMessageId === "string" ? result.outputMessageId : "";
	if (!conversationId) return;
	try {
		const { data, status } = await callCognitiveRuntime(
			env,
			organizationId,
			"cognitiveRuntime/readMessages",
			{ tediId, conversationId, limit: 50 },
			delegatedHeaders,
		);
		if (status >= 400 || !isRecord(data)) return;
		const messages = Array.isArray(data.messages) ? data.messages : [];
		const assistantRows = messages.filter(
			(m): m is Record<string, unknown> =>
				isRecord(m) && m.role === "assistant",
		);
		// Prefer the exact output message; fall back to the latest assistant row.
		const match =
			(outputMessageId &&
				assistantRows.find((m) => m.id === outputMessageId)) ||
			assistantRows[assistantRows.length - 1] ||
			null;
		const content =
			match && typeof match.content === "string" ? match.content : "";
		if (content) {
			result.assistant = {
				role: "assistant",
				content,
				messageId: typeof match?.id === "string" ? match.id : outputMessageId,
			};
			result.content = content;
		}
	} catch {
		// best-effort — leave the readWith pointer for manual recovery
	}
}

export interface BuildAggregateTaskHandlersInput extends BuildHomeTaskHandlersInput {
	/** App id that owns this task surface, used to fan out subscription events. */
	appId?: string;
	/**
	 * Whether this surface exposes the home/kernel runtime. When false (a plain
	 * app that only has generic async tools), bare ids are not routed to the
	 * kernel runtime — only `generic-<uuid>` ids are served, everything else is
	 * not-found.
	 */
	includeHomeSurface?: boolean;
	callerIdentity?: CallerIdentity;
	bearerToken?: string;
	/** Exact task receipt carried by the trusted skill-runtime bridge after its
	 * own run_tedi_turn call. External ingress strips this header. */
	delegatedTediTaskId?: string;
}

export function hasAggregateTaskCapableTool(
	tools: ReadonlyArray<{ config?: Record<string, unknown> | null }>,
): boolean {
	return tools.some(
		(tool) =>
			tool.config?._asyncTask === true ||
			tool.config?.endpoint === "memoryGraph/graph/maintenance" ||
			tool.config?.endpoint === OS_GADGET_RUN_ENDPOINT,
	);
}

/**
 * Build the aggregate task handlers over one `tasks/get|update|cancel` surface:
 *  - `generic-<uuid>` ids → the durable `mcp_tasks` store (config-driven async
 *    tools without a first-class run ledger).
 *  - `tedi:<tediId>:<runId>` ids → per-tedi run projection.
 *  - bare ids → home/kernel run projection (only when `includeHomeSurface`).
 */
export function buildAggregateTaskHandlers(
	input: BuildAggregateTaskHandlersInput,
): McpTaskHandlers {
	const includeHomeSurface = input.includeHomeSurface !== false;
	const home = buildHomeTaskHandlers({
		...input,
		callerScopes: input.callerIdentity?.scopes,
	});
	const { appId, env, organizationId } = input;

	function taskReadHeaders(taskId: string): Record<string, string> {
		const caller = input.callerIdentity;
		if (
			caller?.authType === "service" &&
			caller.tediId &&
			caller.skillRunId &&
			input.delegatedTediTaskId === taskId
		) {
			// The workflow bridge received this exact id from run_tedi_turn.
			// The API still enforces the organization's tedi boundary.
			return { "X-Tedix-Tedi-Scopes": "tedis:read" };
		}
		if (
			(caller?.authType === "oauth" || caller?.authType === "user") &&
			input.bearerToken
		) {
			return {
				"X-Tedix-Caller-Type": "mcp-edge-user",
				"X-Forwarded-Authorization": `Bearer ${input.bearerToken}`,
			};
		}
		return {};
	}

	function homeNotFound(taskId: string): McpTaskState {
		throw McpTaskError.notFound(taskId);
	}

	async function readTediRunEvents(
		taskId: string,
		tediId: string,
		runId: string,
	) {
		const { data, status } = await callCognitiveRuntime(
			env,
			organizationId,
			"cognitiveRuntime/listEvents",
			{ tediId, runId, limit: AGG_TASK_EVENT_LIMIT },
			taskReadHeaders(taskId),
		);
		if (status >= 400) {
			throw new McpTaskError(-32_603, "cognitive runtime listEvents failed", {
				taskId,
				status,
			});
		}
		return eventsFromApi(data);
	}

	return {
		async get({ taskId }) {
			if (isGenericTaskId(taskId)) {
				return getGenericTaskState(
					env.DB,
					taskId,
					organizationId,
					input.callerIdentity?.userId,
				);
			}
			if (isOsGadgetTaskId(taskId)) {
				// Governed gadget execution: routing triple from the store row,
				// authoritative state from the org-scoped execution receipt
				// (osWorkspaces/executions/get), terminal receipts inlined.
				return getOsGadgetTaskState({ env, organizationId, taskId });
			}
			if (isGraphGdsTaskId(taskId)) {
				const { data, status } = await callGraphMaintenance(
					env,
					organizationId,
					input.callerIdentity,
					input.bearerToken,
					"memoryGraph/graph/maintenanceTaskStatus",
					taskId,
				);
				if (status === 404) throw McpTaskError.notFound(taskId);
				if (status >= 400) {
					throw new McpTaskError(
						-32_603,
						"Graph GDS task status request failed",
						{ taskId, status },
					);
				}
				return graphGdsTaskState(taskId, data);
			}
			const tedi = parseTediTaskId(taskId);
			if (!tedi) {
				return includeHomeSurface ? home.get({ taskId }) : homeNotFound(taskId);
			}
			const events = await readTediRunEvents(taskId, tedi.tediId, tedi.runId);
			// Foreign tedi/org/unknown run ids project as an empty page → not found.
			if (events.length === 0) throw McpTaskError.notFound(taskId);
			const state = runEventsToTaskState(tedi.runId, events);
			// Keep the namespaced id the client polls with; the bare run id stays
			// in state.result.runId.
			state.taskId = taskId;
			// Make tasks/get self-sufficient: inline the assistant reply on
			// completion so a Tasks client (skill-runtime bridge, mcp-client-core)
			// gets content without a follow-up messages_read.
			await inlineCompletedTediRunOutput(
				env,
				organizationId,
				tedi.tediId,
				state,
				taskReadHeaders(taskId),
			);
			return state;
		},

		async update(updateInput) {
			const { taskId } = updateInput;
			if (isGenericTaskId(taskId)) {
				await updateGenericTaskInput(
					env.DB,
					taskId,
					organizationId,
					updateInput.inputResponses,
					input.callerIdentity?.userId,
				);
				if (appId) {
					await publishMcpTaskNotification({
						env,
						appId,
						organizationId,
						state: await getGenericTaskState(
							env.DB,
							taskId,
							organizationId,
							input.callerIdentity?.userId,
						),
					});
				}
				return undefined;
			}
			if (isOsGadgetTaskId(taskId)) {
				throw new McpTaskError(
					-32_000,
					"Gadget-run approvals do not flow through tasks/update. List pending approvals with permissions_list_open and resolve them with permissions_respond.",
					{
						taskId,
						listWith: "permissions_list_open",
						respondWith: "permissions_respond",
					},
				);
			}
			if (isGraphGdsTaskId(taskId)) {
				throw new McpTaskError(
					-32_000,
					"Graph GDS refresh tasks do not accept mid-flight input.",
					{ taskId },
				);
			}
			const tedi = parseTediTaskId(taskId);
			if (!tedi) {
				if (includeHomeSurface) return home.update(updateInput);
				throw McpTaskError.notFound(taskId);
			}
			throw new McpTaskError(
				-32_000,
				"Tedi runtime approvals do not flow through tasks/update. List pending approvals with permissions_list_open and resolve them with permissions_respond (requires the tedi:permissions.write scope).",
				{
					taskId,
					listWith: "permissions_list_open",
					respondWith: "permissions_respond",
				},
			);
		},

		async cancel({ taskId }) {
			if (isGenericTaskId(taskId)) {
				const state = await cancelGenericTask(
					env.DB,
					taskId,
					organizationId,
					input.callerIdentity?.userId,
				);
				if (appId) {
					await publishMcpTaskNotification({
						env,
						appId,
						organizationId,
						state,
					});
				}
				return undefined;
			}
			if (isOsGadgetTaskId(taskId)) {
				throw new McpTaskError(
					-32_000,
					"Gadget executions expose no cancel verb: the receipt settles from the governed skill run's evidence. Poll tasks/get for the terminal receipt.",
					{ taskId },
				);
			}
			if (isGraphGdsTaskId(taskId)) {
				const { status } = await callGraphMaintenance(
					env,
					organizationId,
					input.callerIdentity,
					input.bearerToken,
					"memoryGraph/graph/maintenanceTaskCancel",
					taskId,
				);
				if (status === 404) throw McpTaskError.notFound(taskId);
				if (status >= 400) {
					throw new McpTaskError(
						-32_000,
						"Graph GDS task cancellation failed",
						{ taskId, status },
					);
				}
				return undefined;
			}
			const tedi = parseTediTaskId(taskId);
			if (!tedi) {
				if (includeHomeSurface) return home.cancel({ taskId });
				throw McpTaskError.notFound(taskId);
			}

			const events = await readTediRunEvents(taskId, tedi.tediId, tedi.runId);
			if (events.length === 0) throw McpTaskError.notFound(taskId);
			const pre = runEventsToTaskState(tedi.runId, events);
			if (
				pre.status === "completed" ||
				pre.status === "failed" ||
				pre.status === "cancelled"
			) {
				throw new McpTaskError(
					-32_000,
					`Tedi run is already ${pre.status}; nothing to cancel.`,
					{ taskId, status: pre.status },
				);
			}

			const conversationId = events.find(
				(event) => typeof event.conversationId === "string",
			)?.conversationId;
			const stop = await callCognitiveRuntime(
				env,
				organizationId,
				"cognitiveRuntime/stopRun",
				{
					tediId: tedi.tediId,
					runId: tedi.runId,
					...(typeof conversationId === "string" ? { conversationId } : {}),
					reason: "Canceled via MCP tasks/cancel",
				},
			);
			if (stop.status === 404) throw McpTaskError.notFound(taskId);
			if (stop.status >= 400) {
				throw new McpTaskError(-32_000, "cognitive runtime stopRun failed", {
					taskId,
				});
			}
		},
	};
}
