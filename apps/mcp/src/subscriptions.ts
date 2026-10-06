import { isRecord } from "@tedix/api-contract/utils/is-record";
import { contentFreeMcpException, createMcpLogger } from "./log";
import {
	InteractionEventSubscriptions,
	InteractionEventError,
} from "./interaction-events";

const log = createMcpLogger("mcp.subscription.poller");

const SUBSCRIPTION_ID_META_KEY = "io.modelcontextprotocol/subscriptionId";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";
const CLIENT_CAPABILITIES_META_KEY =
	"io.modelcontextprotocol/clientCapabilities";
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const TASK_NOTIFICATION_METHOD = "notifications/tasks";
const ACK_NOTIFICATION_METHOD = "notifications/subscriptions/acknowledged";
const TOOLS_LIST_CHANGED_METHOD = "notifications/tools/list_changed";
const PROMPTS_LIST_CHANGED_METHOD = "notifications/prompts/list_changed";
const RESOURCES_LIST_CHANGED_METHOD = "notifications/resources/list_changed";
const RESOURCE_UPDATED_METHOD = "notifications/resources/updated";
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_TASK_POLL_INTERVAL_MS = 2_500;
const KEEPALIVE_INTERVAL_MS = 15_000;
const TASK_STATUS_VALUES = new Set([
	"working",
	"input_required",
	"completed",
	"cancelled",
	"failed",
]);

/**
 * A `notifications/tasks` payload is a complete DetailedTask snapshot, not an
 * invalidation hint. Reject partial publisher records so the subscription do
 * resolves canonical state through `tasks/get` before emitting them.
 */
export function isCompleteTaskNotificationState(
	value: unknown,
): value is Record<string, unknown> {
	if (!isRecord(value)) return false;
	if (typeof value.taskId !== "string" || value.taskId.length === 0)
		return false;
	if (
		typeof value.status !== "string" ||
		!TASK_STATUS_VALUES.has(value.status)
	) {
		return false;
	}
	if (
		typeof value.createdAt !== "string" ||
		typeof value.lastUpdatedAt !== "string" ||
		!Number.isFinite(Date.parse(value.createdAt)) ||
		!Number.isFinite(Date.parse(value.lastUpdatedAt)) ||
		!(
			value.ttlMs === null ||
			(typeof value.ttlMs === "number" &&
				Number.isInteger(value.ttlMs) &&
				value.ttlMs >= 0)
		) ||
		!(
			value.pollIntervalMs === undefined ||
			(typeof value.pollIntervalMs === "number" &&
				Number.isInteger(value.pollIntervalMs) &&
				value.pollIntervalMs >= 0)
		)
	) {
		return false;
	}
	if (value.status === "completed" && !isRecord(value.result)) return false;
	if (value.status === "input_required") {
		if (!isRecord(value.inputRequests)) return false;
		if (Object.keys(value.inputRequests).length === 0) return false;
	}
	if (value.status === "failed") {
		if (!isRecord(value.error)) return false;
		if (
			typeof value.error.code !== "number" ||
			typeof value.error.message !== "string"
		) {
			return false;
		}
	}
	return true;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function subscriptionIdMeta(subscriptionId: unknown): Record<string, unknown> {
	return { [SUBSCRIPTION_ID_META_KEY]: subscriptionId };
}

function sseJson(message: Record<string, unknown>): Uint8Array {
	return new TextEncoder().encode(`data: ${JSON.stringify(message)}\n\n`);
}

function sseComment(comment = "keepalive"): Uint8Array {
	return new TextEncoder().encode(`: ${comment}\n\n`);
}

type NormalizedNotificationFilter = {
	acknowledged: Record<string, unknown>;
	toolsListChanged: boolean;
	promptsListChanged: boolean;
	resourcesListChanged: boolean;
	resourceSubscriptions: string[];
	tasksRequested: boolean;
	taskIds: string[];
	closeWhenTasksTerminal: boolean;
};

function normalizeNotificationFilter(
	params: Record<string, unknown>,
): NormalizedNotificationFilter {
	const requested = isRecord(params.notifications) ? params.notifications : {};
	const acknowledgedNotifications: Record<string, unknown> = {};

	const toolsListChanged = requested.toolsListChanged === true;
	const promptsListChanged = requested.promptsListChanged === true;
	const resourcesListChanged = requested.resourcesListChanged === true;
	if (toolsListChanged) acknowledgedNotifications.toolsListChanged = true;
	if (promptsListChanged) acknowledgedNotifications.promptsListChanged = true;
	if (resourcesListChanged)
		acknowledgedNotifications.resourcesListChanged = true;

	const resourceSubscriptions = asStringArray(requested.resourceSubscriptions);
	if (resourceSubscriptions.length > 0) {
		acknowledgedNotifications.resourceSubscriptions = resourceSubscriptions;
	}

	const taskIdsRequested = Array.isArray(requested.taskIds);
	const uniqueTaskIds = [...new Set(asStringArray(requested.taskIds))].slice(
		0,
		25,
	);
	const tasksRequested = taskIdsRequested && uniqueTaskIds.length > 0;
	if (tasksRequested) {
		acknowledgedNotifications.taskIds = uniqueTaskIds;
	}

	return {
		acknowledged: acknowledgedNotifications,
		toolsListChanged,
		promptsListChanged,
		resourcesListChanged,
		resourceSubscriptions: [...new Set(resourceSubscriptions)].slice(0, 100),
		tasksRequested,
		taskIds: uniqueTaskIds,
		closeWhenTasksTerminal:
			tasksRequested &&
			uniqueTaskIds.length > 0 &&
			Object.keys(acknowledgedNotifications).every((key) => key === "taskIds"),
	};
}

function buildRequestMeta(
	params: Record<string, unknown>,
): Record<string, unknown> {
	const current = isRecord(params._meta) ? params._meta : {};
	return {
		...current,
		[PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
		[CLIENT_INFO_META_KEY]: isRecord(current[CLIENT_INFO_META_KEY])
			? current[CLIENT_INFO_META_KEY]
			: { name: "tedix-mcp-subscriptions", version: "1.0.0" },
		[CLIENT_CAPABILITIES_META_KEY]: isRecord(
			current[CLIENT_CAPABILITIES_META_KEY],
		)
			? current[CLIENT_CAPABILITIES_META_KEY]
			: { extensions: { "io.modelcontextprotocol/tasks": {} } },
	};
}

async function parseJsonResponse(
	response: Response,
): Promise<Record<string, unknown>> {
	try {
		return (await response.json()) as Record<string, unknown>;
	} catch {
		return {};
	}
}

export type SubscriptionRequest = {
	requestId: unknown;
	params: Record<string, unknown>;
	mcpUrl: string;
	authHeaders: Record<string, string>;
	corsOrigin: string;
	organizationId?: string | null;
};

export type McpSubscriptionPublishEvent = {
	organizationId?: string | null;
	method:
		| typeof TASK_NOTIFICATION_METHOD
		| typeof TOOLS_LIST_CHANGED_METHOD
		| typeof PROMPTS_LIST_CHANGED_METHOD
		| typeof RESOURCES_LIST_CHANGED_METHOD
		| typeof RESOURCE_UPDATED_METHOD;
	taskId?: string;
	state?: Record<string, unknown>;
	uri?: string;
	params?: Record<string, unknown>;
};

type ActiveSubscription = {
	id: string;
	input: SubscriptionRequest;
	filter: NormalizedNotificationFilter;
	requestMeta: Record<string, unknown>;
	controller: ReadableStreamDefaultController<Uint8Array>;
	latestTaskFingerprints: Map<string, string>;
	terminalTaskIds: Set<string>;
	keepaliveTimer?: ReturnType<typeof setInterval>;
	taskPollTimer?: ReturnType<typeof setInterval>;
	closed: boolean;
};

function taskFingerprint(state: Record<string, unknown>): string {
	return JSON.stringify({
		status: state.status,
		statusMessage: state.statusMessage,
		lastUpdatedAt: state.lastUpdatedAt,
		result: state.result,
		error: state.error,
		inputRequests: state.inputRequests,
	});
}

/**
 * Tenancy gate for subscription fan-out. The subscription Durable Object is
 * sharded by `appId` (`subscription-publisher.ts`, `index.ts`), so a single
 * instance holds subscribers from every organization connected to a shared or
 * aggregate app. This comparison is therefore the only tenant boundary inside
 * the do, and it must fail closed.
 *
 * It previously read `if (event.organizationId && subscription.input.organizationId)`,
 * which skipped the check entirely whenever either side was null — and
 * `publishMcpInventoryListChanged` omitted the org, so every `*_list_changed`
 * publish was delivered cross-tenant. Treat a missing org as a distinct value
 * rather than a wildcard: an org-scoped subscriber never receives an unscoped
 * event, and an unscoped subscriber (anonymous caller on an app with no
 * organization boundary) never receives an org-scoped one.
 */
function subscriptionTenancyMatches(
	subscription: ActiveSubscription,
	event: McpSubscriptionPublishEvent,
): boolean {
	return (
		(event.organizationId ?? null) ===
		(subscription.input.organizationId ?? null)
	);
}

function taskMatchesSubscription(
	subscription: ActiveSubscription,
	event: McpSubscriptionPublishEvent,
): boolean {
	if (!subscription.filter.tasksRequested) return false;
	if (!subscriptionTenancyMatches(subscription, event)) return false;
	if (!event.taskId) return subscription.filter.taskIds.length === 0;
	return (
		subscription.filter.taskIds.length === 0 ||
		subscription.filter.taskIds.includes(event.taskId)
	);
}

function eventMatchesSubscription(
	subscription: ActiveSubscription,
	event: McpSubscriptionPublishEvent,
): boolean {
	if (!subscriptionTenancyMatches(subscription, event)) return false;
	switch (event.method) {
		case TASK_NOTIFICATION_METHOD:
			return taskMatchesSubscription(subscription, event);
		case TOOLS_LIST_CHANGED_METHOD:
			return subscription.filter.toolsListChanged;
		case PROMPTS_LIST_CHANGED_METHOD:
			return subscription.filter.promptsListChanged;
		case RESOURCES_LIST_CHANGED_METHOD:
			return subscription.filter.resourcesListChanged;
		case RESOURCE_UPDATED_METHOD:
			return (
				typeof event.uri === "string" &&
				subscription.filter.resourceSubscriptions.includes(event.uri)
			);
	}
}

export class McpSubscriptionDurableObject {
	readonly state: DurableObjectState;
	env: CloudflareEnv;
	#subscriptions = new Map<string, ActiveSubscription>();

	constructor(state: DurableObjectState, env: CloudflareEnv) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const url = new URL(request.url);
		if (url.pathname.startsWith("/events/")) {
			try {
				const input = await request.json();
				const events = new InteractionEventSubscriptions(
					this.state.storage,
					this.env,
				);
				const result =
					url.pathname === "/events/subscribe"
						? await events.subscribe(
								input as Parameters<typeof events.subscribe>[0],
							)
						: url.pathname === "/events/unsubscribe"
							? await events.unsubscribe(
									input as Parameters<typeof events.unsubscribe>[0],
								)
							: url.pathname === "/events/publish"
								? {
										accepted: await events.publish(
											input as Parameters<typeof events.publish>[0],
										),
									}
								: null;
				return Response.json(
					result ?? {
						error: { code: -32601, message: "Unknown events route" },
					},
				);
			} catch (error) {
				return Response.json({
					error: {
						code: error instanceof InteractionEventError ? error.code : -32603,
						message:
							error instanceof InteractionEventError
								? error.message
								: "Event operation unavailable",
						...(error instanceof InteractionEventError && error.data
							? { data: error.data }
							: {}),
					},
				});
			}
		}
		if (url.pathname.endsWith("/publish")) {
			return this.handlePublish(request);
		}

		let input: SubscriptionRequest;
		try {
			input = (await request.json()) as SubscriptionRequest;
		} catch {
			return new Response("Bad Request", { status: 400 });
		}

		return this.openSubscription(input, request.signal);
	}

	async alarm(): Promise<void> {
		await new InteractionEventSubscriptions(
			this.state.storage,
			this.env,
		).alarm();
	}

	private async handlePublish(request: Request): Promise<Response> {
		let event: McpSubscriptionPublishEvent;
		try {
			event = (await request.json()) as McpSubscriptionPublishEvent;
		} catch {
			return new Response(JSON.stringify({ ok: false, error: "Bad Request" }), {
				status: 400,
				headers: { "Content-Type": "application/json" },
			});
		}
		const delivered = await this.publishEvent(event);
		return new Response(JSON.stringify({ ok: true, delivered }), {
			headers: { "Content-Type": "application/json" },
		});
	}

	private cleanup(subscription: ActiveSubscription): void {
		if (subscription.closed) return;
		subscription.closed = true;
		if (subscription.keepaliveTimer) clearInterval(subscription.keepaliveTimer);
		if (subscription.taskPollTimer) clearInterval(subscription.taskPollTimer);
		this.#subscriptions.delete(subscription.id);
	}

	private safeEnqueue(
		subscription: ActiveSubscription,
		chunk: Uint8Array,
	): void {
		if (subscription.closed) return;
		try {
			subscription.controller.enqueue(chunk);
		} catch {
			this.cleanup(subscription);
		}
	}

	private closeGracefully(subscription: ActiveSubscription): void {
		if (subscription.closed) return;
		this.safeEnqueue(
			subscription,
			sseJson({
				jsonrpc: "2.0",
				id: subscription.input.requestId,
				result: {
					resultType: "complete",
					_meta: subscriptionIdMeta(subscription.input.requestId),
				},
			}),
		);
		this.cleanup(subscription);
		subscription.controller.close();
	}

	private async emitTaskState(
		subscription: ActiveSubscription,
		state: Record<string, unknown>,
	): Promise<boolean> {
		const taskId = typeof state.taskId === "string" ? state.taskId : undefined;
		if (!taskId) return false;
		const fingerprint = taskFingerprint(state);
		if (subscription.latestTaskFingerprints.get(taskId) === fingerprint) {
			return false;
		}
		subscription.latestTaskFingerprints.set(taskId, fingerprint);
		this.safeEnqueue(
			subscription,
			sseJson({
				jsonrpc: "2.0",
				method: TASK_NOTIFICATION_METHOD,
				params: {
					_meta: subscriptionIdMeta(subscription.input.requestId),
					...state,
				},
			}),
		);
		if (TERMINAL_TASK_STATUSES.has(String(state.status))) {
			subscription.terminalTaskIds.add(taskId);
		}
		if (
			subscription.filter.closeWhenTasksTerminal &&
			subscription.terminalTaskIds.size === subscription.filter.taskIds.length
		) {
			this.closeGracefully(subscription);
		}
		return true;
	}

	private async publishEvent(
		event: McpSubscriptionPublishEvent,
	): Promise<number> {
		let delivered = 0;
		for (const subscription of [...this.#subscriptions.values()]) {
			if (
				subscription.closed ||
				!eventMatchesSubscription(subscription, event)
			) {
				continue;
			}
			if (event.method === TASK_NOTIFICATION_METHOD) {
				const state = isCompleteTaskNotificationState(event.state)
					? event.state
					: event.taskId
						? await this.fetchTaskState(
								subscription.input,
								subscription.requestMeta,
								event.taskId,
							)
						: null;
				if (state && (await this.emitTaskState(subscription, state)))
					delivered++;
				continue;
			}

			const params = {
				_meta: subscriptionIdMeta(subscription.input.requestId),
				...(event.method === RESOURCE_UPDATED_METHOD && event.uri
					? { uri: event.uri }
					: {}),
				...(isRecord(event.params) ? event.params : {}),
			};
			this.safeEnqueue(
				subscription,
				sseJson({ jsonrpc: "2.0", method: event.method, params }),
			);
			delivered++;
		}
		return delivered;
	}

	private openSubscription(
		input: SubscriptionRequest,
		signal: AbortSignal,
	): Response {
		const filter = normalizeNotificationFilter(input.params);
		const requestMeta = buildRequestMeta(input.params);
		const id = crypto.randomUUID();

		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				const subscription: ActiveSubscription = {
					id,
					input,
					filter,
					requestMeta,
					controller,
					latestTaskFingerprints: new Map(),
					terminalTaskIds: new Set(),
					closed: false,
				};
				this.#subscriptions.set(id, subscription);

				this.safeEnqueue(
					subscription,
					sseJson({
						jsonrpc: "2.0",
						method: ACK_NOTIFICATION_METHOD,
						params: {
							_meta: subscriptionIdMeta(input.requestId),
							notifications: filter.acknowledged,
						},
					}),
				);

				const pollTasks = async () => {
					if (
						subscription.closed ||
						!filter.tasksRequested ||
						filter.taskIds.length === 0
					) {
						return;
					}
					for (const taskId of filter.taskIds) {
						if (subscription.closed) return;
						try {
							const state = await this.fetchTaskState(
								input,
								requestMeta,
								taskId,
							);
							if (state) await this.emitTaskState(subscription, state);
						} catch (error) {
							log.warn("MCP subscription task poll failed", {
								event: "mcp.subscription.task_poll_failed",
								taskId,
								outcome: "unavailable",
								error: contentFreeMcpException(error),
							});
						}
					}
				};

				subscription.keepaliveTimer = setInterval(
					() => this.safeEnqueue(subscription, sseComment()),
					KEEPALIVE_INTERVAL_MS,
				);
				if (filter.tasksRequested && filter.taskIds.length > 0) {
					void pollTasks();
					subscription.taskPollTimer = setInterval(
						() => void pollTasks(),
						DEFAULT_TASK_POLL_INTERVAL_MS,
					);
				}
				signal.addEventListener("abort", () => this.cleanup(subscription), {
					once: true,
				});
			},
			cancel: () => {
				const subscription = this.#subscriptions.get(id);
				if (subscription) this.cleanup(subscription);
			},
		});

		return new Response(stream, {
			status: 200,
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache, no-transform",
				"X-Accel-Buffering": "no",
				// Caller-resolved origin value; policy is decided upstream, not here.
				"Access-Control-Allow-Origin": input.corsOrigin,
			},
		});
	}

	private async fetchTaskState(
		input: SubscriptionRequest,
		requestMeta: Record<string, unknown>,
		taskId: string,
	): Promise<Record<string, unknown> | null> {
		const response = await fetch(input.mcpUrl, {
			method: "POST",
			headers: {
				...input.authHeaders,
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": MODERN_PROTOCOL_VERSION,
				"Mcp-Method": "tasks/get",
				"Mcp-Name": taskId,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: crypto.randomUUID(),
				method: "tasks/get",
				params: { taskId, _meta: requestMeta },
			}),
		});
		const payload = await parseJsonResponse(response);
		if (isCompleteTaskNotificationState(payload.result)) return payload.result;
		if (isRecord(payload.error)) {
			return {
				taskId,
				status: "failed",
				createdAt: new Date().toISOString(),
				lastUpdatedAt: new Date().toISOString(),
				ttlMs: null,
				error: payload.error,
			};
		}
		return null;
	}
}
