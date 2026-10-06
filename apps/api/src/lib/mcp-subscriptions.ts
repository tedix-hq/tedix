import type { DbClient } from "@tedix/db/client";
import { listMcpSubscriptionTargetsForCatalogApp } from "@tedix/db/queries/mcp-subscription-targets";

type InteractionResponseEvent = {
	kind: "interaction_response";
	organizationId: string;
	requestId: string;
	responseId: string;
	respondedAt: string;
};

/**
 * Publish a committed reply to its exact request subscription owner. Acceptance
 * is not webhook delivery. The D1 commit and this call are not atomic: failures
 * leave the reply readable from the canonical Interaction ledger.
 */
export async function publishMcpInteractionResponse(
	env: CloudflareEnv,
	input: Omit<InteractionResponseEvent, "kind">,
	options: { timeoutMs?: number } = {},
): Promise<"accepted" | "unavailable"> {
	if (!env.MCP_SERVICE) return "unavailable";
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		// Project each field explicitly: response text, metadata and caller
		// credentials must never leak into an event notification.
		const body: InteractionResponseEvent = {
			kind: "interaction_response",
			organizationId: input.organizationId,
			requestId: input.requestId,
			responseId: input.responseId,
			respondedAt: input.respondedAt,
		};
		const accepted = await Promise.race([
			(async () => {
				const response = await env.MCP_SERVICE.fetch(
					new Request("https://mcp/__internal/subscriptions/publish", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Service-Binding": "true",
						},
						body: JSON.stringify(body),
						signal: controller.signal,
					}),
				);
				const result = (await response.json()) as { ok?: unknown };
				return response.ok && result?.ok === true;
			})(),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => {
					controller.abort();
					resolve(false);
				}, options.timeoutMs ?? 2_000);
			}),
		]);
		if (accepted) return "accepted";
	} catch {
		// Never turn a saved answer into an API error or log provider payloads.
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
	console.warn("[MCP events] committed reply notification unavailable", {
		event: "interaction_response.publish_unavailable",
	});
	return "unavailable";
}

type McpSubscriptionPublishInput = {
	appId?: string;
	appIds?: string[];
	organizationId?: string | null;
	method:
		| "notifications/tools/list_changed"
		| "notifications/prompts/list_changed"
		| "notifications/resources/list_changed"
		| "notifications/resources/updated"
		| "notifications/tasks";
	taskId?: string;
	state?: Record<string, unknown>;
	uri?: string;
	params?: Record<string, unknown>;
};

export async function publishMcpSubscriptionEvent(
	env: CloudflareEnv,
	input: McpSubscriptionPublishInput,
): Promise<void> {
	const service = env.MCP_SERVICE;
	if (!service) return;
	try {
		const response = await service.fetch(
			new Request("https://mcp/__internal/subscriptions/publish", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Service-Binding": "true",
				},
				body: JSON.stringify(input),
			}),
		);
		if (!response.ok) {
			console.warn("[MCP subscriptions] publish failed", {
				status: response.status,
				method: input.method,
				appId: input.appId,
				appIds: input.appIds,
			});
		}
	} catch (error) {
		console.warn("[MCP subscriptions] publish failed", {
			method: input.method,
			appId: input.appId,
			appIds: input.appIds,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export function publishMcpSubscriptionEventSoon(
	waitUntil: ((promise: Promise<unknown>) => void) | undefined,
	env: CloudflareEnv,
	input: McpSubscriptionPublishInput,
): void {
	const promise = publishMcpSubscriptionEvent(env, input);
	if (waitUntil) waitUntil(promise);
}

export type McpListChangedMethod =
	| "notifications/tools/list_changed"
	| "notifications/prompts/list_changed"
	| "notifications/resources/list_changed";

type McpSubscriptionTarget = Pick<
	McpSubscriptionPublishInput,
	"appId" | "appIds" | "organizationId"
> & {
	appResolutionKeys?: string[];
};

async function invalidateMcpInventory(
	env: CloudflareEnv,
	target: McpSubscriptionTarget,
): Promise<boolean> {
	// Callers that do not own the app routing record cannot safely guess cache
	// keys. They retain the legacy notification-only behavior until their
	// mutation seam can supply the exact slug/domain identities.
	if (target.appResolutionKeys === undefined) return true;
	if (!env.MCP_SERVICE) return false;
	const requests = [
		...(target.appId
			? [
					new Request("https://mcp/__internal/purge-discovery-cache", {
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"X-Service-Binding": "true",
						},
						body: JSON.stringify({
							appId: target.appId,
							appResolutionKeys: target.appResolutionKeys ?? [],
						}),
					}),
				]
			: []),
		new Request("https://mcp/__internal/purge-aggregate-cache", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Service-Binding": "true",
			},
			body: JSON.stringify({ reason: "inventory-list-changed" }),
		}),
	];
	try {
		for (const request of requests) {
			const response = await env.MCP_SERVICE.fetch(request);
			const result = (await response.json().catch(() => null)) as {
				ok?: boolean;
			} | null;
			if (!response.ok || result?.ok !== true) return false;
		}
		return true;
	} catch (error) {
		console.warn("[MCP inventory cache] purge failed", {
			appId: target.appId,
			message: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

/**
 * Best-effort invalidation for durable aggregate surfaces after an app's
 * aggregateApps configuration changes. The MCP Worker owns every cache layer;
 * API callers use this service-binding route instead of reaching into R2.
 */
export async function purgeMcpAggregateCache(
	env: CloudflareEnv,
	reason: string,
): Promise<void> {
	if (!env.MCP_SERVICE) return;
	try {
		const response = await env.MCP_SERVICE.fetch(
			new Request("https://mcp/__internal/purge-aggregate-cache", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Service-Binding": "true",
				},
				body: JSON.stringify({ reason }),
			}),
		);
		const result = (await response.json().catch(() => null)) as {
			ok?: boolean;
		} | null;
		if (!response.ok || result?.ok === false) {
			console.warn("[MCP aggregate cache] purge failed", {
				status: response.status,
				reason,
			});
		}
	} catch (error) {
		console.warn("[MCP aggregate cache] purge failed", {
			reason,
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Publish a batch of list_changed notifications for one inventory mutation.
 * Same no-op-when-binding-absent contract as publishMcpSubscriptionEvent.
 */
export async function publishMcpListChangedEvents(
	env: CloudflareEnv,
	target: McpSubscriptionTarget,
	methods: readonly McpListChangedMethod[],
): Promise<void> {
	if (!(await invalidateMcpInventory(env, target))) return;
	for (const method of methods) {
		const { appResolutionKeys: _appResolutionKeys, ...publishTarget } = target;
		await publishMcpSubscriptionEvent(env, { ...publishTarget, method });
	}
}

/**
 * Fire-and-forget variant of publishMcpListChangedEvents for request-path
 * mutation seams (mirrors publishMcpSubscriptionEventSoon).
 */
export function publishMcpListChangedEventsSoon(
	waitUntil: ((promise: Promise<unknown>) => void) | undefined,
	env: CloudflareEnv,
	target: McpSubscriptionTarget,
	methods: readonly McpListChangedMethod[],
): void {
	const promise = publishMcpListChangedEvents(env, target, methods);
	if (waitUntil) waitUntil(promise);
}

export async function publishMcpCatalogInventoryEvents(input: {
	db: DbClient;
	env: CloudflareEnv;
	catalogAppId: string;
	resourceListChanged?: boolean;
	promptListChanged?: boolean;
}): Promise<void> {
	if (!input.resourceListChanged && !input.promptListChanged) return;
	const appRows = await listMcpSubscriptionTargetsForCatalogApp(
		input.db,
		input.catalogAppId,
	);
	if (appRows.length === 0) return;
	for (const row of appRows) {
		if (input.resourceListChanged) {
			await publishMcpSubscriptionEvent(input.env, {
				appId: row.id,
				organizationId: row.organizationId,
				method: "notifications/resources/list_changed",
			});
		}
		if (input.promptListChanged) {
			await publishMcpSubscriptionEvent(input.env, {
				appId: row.id,
				organizationId: row.organizationId,
				method: "notifications/prompts/list_changed",
			});
		}
	}
}
