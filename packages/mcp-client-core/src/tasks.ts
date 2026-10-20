import {
	CLIENT_CAPABILITIES_META_KEY,
	CLIENT_INFO_META_KEY,
	PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/client";
import { MCP_MODERN_PROTOCOL_VERSION } from "@tedix/mcp-shared/protocol";
import { pollMcpTask } from "@tedix/mcp-shared/task-polling";
import { extractMcpTaskId, type McpTaskState } from "@tedix/mcp-shared/tasks";
import type { McpServerConfig } from "./types";
import { createAgentElicitationResolver } from "./elicitation-resolver";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { createStatelessTransport } from "./stateless-transport";
import type { TaskSubscription } from "./connections";
import { guardedMcpFetch, isManagedMcpHostname } from "./managed-fetch";
import {
	MODERN_CLIENT_INFO,
	statelessClientCapabilities,
} from "./client-capabilities";

export function createTaskClient(
	transport: ReturnType<typeof createStatelessTransport>,
	taskServerConfig: (serverId: string) => McpServerConfig,
	outboundTraceContext: () => {
		headers: Record<string, string>;
		meta: Record<string, unknown>;
	},
) {
	const { rawMcpPost, resolveStatelessRequestContext, modernRequestHeaders } =
		transport;
	/** Read a persisted MCP Task without replaying the originating tool call. */
	async function getTask(
		serverId: string,
		taskId: string,
	): Promise<McpTaskState> {
		const config = taskServerConfig(serverId);
		return (await rawMcpPost(config, "tasks/get", {
			taskId,
		})) as McpTaskState;
	}

	/**
	 * Resume polling a task id persisted by the host across reloads or reconnects.
	 * Uses the same bounded polling and MRTR input resolver as a new tool call.
	 */
	async function resumeTask(
		serverId: string,
		taskId: string,
		options?: {
			signal?: AbortSignal;
			onTaskInputRequired?: McpServerConfig["onTaskInputRequired"] | null;
		},
	): Promise<unknown> {
		const signal = options?.signal;
		const originalResolver =
			options?.onTaskInputRequired ?? createAgentElicitationResolver({});
		const config = {
			...taskServerConfig(serverId),
			onTaskInputRequired: async (
				input: Parameters<
					NonNullable<McpServerConfig["onTaskInputRequired"]>
				>[0],
			) => {
				signal?.throwIfAborted();
				const result = await originalResolver(input);
				signal?.throwIfAborted();
				return result;
			},
		};
		return resolveTaskResult(
			config,
			{ resultType: "task", taskId },
			options?.signal,
		);
	}

	/** Submit MRTR input responses for a persisted task. */
	async function updateTask(
		serverId: string,
		taskId: string,
		inputResponses: Record<string, unknown>,
	): Promise<void> {
		const config = taskServerConfig(serverId);
		await rawMcpPost(config, "tasks/update", {
			taskId,
			inputResponses,
		});
	}

	/** Cancel a persisted task explicitly. Unlike abort cleanup, errors surface. */
	async function cancelTask(serverId: string, taskId: string): Promise<void> {
		const config = taskServerConfig(serverId);
		await rawMcpPost(config, "tasks/cancel", { taskId });
	}

	/**
	 * MCP 2026-07-28 Tasks (client side). If a tool result is a
	 * `resultType: "task"` envelope, drive it through the shared
	 * `@tedix/mcp-shared/task-polling` policy (backoff, not-found, abort →
	 * `tasks/cancel`, `input_required` via `onTaskInputRequired`) and return the
	 * completed tool result; any other outcome surfaces the task state.
	 */
	async function resolveTaskResult(
		config: McpServerConfig,
		result: unknown,
		signal?: AbortSignal,
	): Promise<unknown> {
		const taskId = extractMcpTaskId(result);
		if (!taskId) return result;

		const subscription = await openTaskSubscription(config, taskId, signal);
		try {
			const outcome = await pollMcpTask({
				taskId,
				request: (method, params, requestSignal) =>
					rawMcpPost(
						config,
						method,
						params,
						undefined,
						undefined,
						requestSignal,
					),
				signal,
				push: subscription,
				maxAttempts: config.taskPolling?.maxAttempts ?? 30,
				maxIntervalMs: config.taskPolling?.maxIntervalMs,
				resolveInput: config.onTaskInputRequired,
			});
			if (outcome.status === "completed") return outcome.result;
			// failed / cancelled / unanswerable input_required surface the task
			// state; an exhausted budget surfaces the last observed state.
			return outcome.state ?? result;
		} finally {
			subscription?.close();
		}
	}

	/**
	 * Open the finalized 2026 task-notification stream for a Tedix-hosted MCP
	 * endpoint. External and legacy servers keep the bounded polling path. The
	 * stream is only a wake-up/complete-state optimization: any setup, parse, or
	 * reconnect failure fails closed to `tasks/get` on the next loop.
	 */
	async function openTaskSubscription(
		config: McpServerConfig,
		taskId: string,
		signal?: AbortSignal,
	): Promise<TaskSubscription | null> {
		let hostname = "";
		try {
			hostname = new URL(config.url).hostname.toLowerCase();
		} catch {
			return null;
		}
		if (!isManagedMcpHostname(hostname)) return null;

		const context = await resolveStatelessRequestContext(config);
		if (!context.negotiation.modern) return null;
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal?.reason);
		if (signal?.aborted) return null;
		signal?.addEventListener("abort", onAbort, { once: true });
		const setupTimeout = setTimeout(() => controller.abort(), 2_500);
		const trace = outboundTraceContext();

		try {
			const response = await guardedMcpFetch(config.url, {
				method: "POST",
				headers: {
					...context.headers,
					...trace.headers,
					...modernRequestHeaders("subscriptions/listen", undefined, true),
					"Accept-Encoding": "identity",
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: crypto.randomUUID(),
					method: "subscriptions/listen",
					params: {
						notifications: { taskIds: [taskId] },
						_meta: {
							...trace.meta,
							[PROTOCOL_VERSION_META_KEY]: MCP_MODERN_PROTOCOL_VERSION,
							[CLIENT_INFO_META_KEY]: MODERN_CLIENT_INFO,
							[CLIENT_CAPABILITIES_META_KEY]:
								statelessClientCapabilities(config),
						},
					},
				}),
				signal: controller.signal,
			});
			clearTimeout(setupTimeout);
			if (
				!response.ok ||
				!response.body ||
				!response.headers.get("content-type")?.includes("text/event-stream")
			) {
				controller.abort();
				signal?.removeEventListener("abort", onAbort);
				return null;
			}

			const states: Record<string, unknown>[] = [];
			const waiters: Array<(state: Record<string, unknown> | null) => void> =
				[];
			let closed = false;
			const finish = () => {
				if (closed) return;
				closed = true;
				controller.abort();
				signal?.removeEventListener("abort", onAbort);
				for (const resolve of waiters.splice(0)) resolve(null);
			};
			void (async () => {
				const reader = response.body!.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				try {
					while (!closed) {
						const chunk = await reader.read();
						if (chunk.done) break;
						buffer += decoder.decode(chunk.value, { stream: true });
						let boundary = buffer.indexOf("\n\n");
						while (boundary >= 0) {
							const event = buffer.slice(0, boundary);
							buffer = buffer.slice(boundary + 2);
							const data = event
								.split("\n")
								.filter((line) => line.startsWith("data:"))
								.map((line) => line.slice(5).trimStart())
								.join("\n");
							if (data) {
								try {
									const message = JSON.parse(data) as Record<string, unknown>;
									if (
										message.method === "notifications/tasks" &&
										isRecord(message.params) &&
										message.params.taskId === taskId
									) {
										const waiter = waiters.shift();
										if (waiter) waiter(message.params);
										else states.push(message.params);
									}
								} catch {
									// Ignore one malformed event; polling remains authoritative.
								}
							}
							boundary = buffer.indexOf("\n\n");
						}
					}
				} catch {
					// Disconnects fall back to bounded polling.
				} finally {
					finish();
				}
			})();

			return {
				next: async (timeoutMs) => {
					const state = states.shift();
					if (state) return state;
					if (closed || timeoutMs <= 0) return null;
					return new Promise((resolve) => {
						const waiter = (value: Record<string, unknown> | null) => {
							clearTimeout(timer);
							resolve(value);
						};
						const timer = setTimeout(() => {
							const index = waiters.indexOf(waiter);
							if (index >= 0) waiters.splice(index, 1);
							resolve(null);
						}, timeoutMs);
						waiters.push(waiter);
					});
				},
				close: finish,
			};
		} catch {
			clearTimeout(setupTimeout);
			controller.abort();
			signal?.removeEventListener("abort", onAbort);
			return null;
		}
	}

	return { getTask, resumeTask, updateTask, cancelTask, resolveTaskResult };
}
