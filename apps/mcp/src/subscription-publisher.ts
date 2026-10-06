import type { McpTaskState } from "@tedix/mcp-shared/tasks";
import { contentFreeMcpException, createMcpLogger } from "./log";
import type { McpSubscriptionPublishEvent } from "./subscriptions";

const log = createMcpLogger("mcp.subscription.publisher");

type SubscriptionPublisherEnv = CloudflareEnv & {
	MCP_SUBSCRIPTIONS?: DurableObjectNamespace;
};

async function publishToSubscriptionDo(
	env: CloudflareEnv,
	appId: string,
	event: McpSubscriptionPublishEvent,
): Promise<number> {
	const binding = (env as SubscriptionPublisherEnv).MCP_SUBSCRIPTIONS;
	if (!binding) return 0;
	try {
		const response = await binding
			.get(binding.idFromName(appId))
			.fetch("https://mcp-subscriptions.internal/publish", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(event),
			});
		if (!response.ok) {
			log.warn("MCP subscription publish rejected", {
				event: "mcp.subscription.publish_rejected",
				appId,
				step: event.method,
				status: response.status,
				outcome: "unavailable",
			});
			return 0;
		}
		const payload = (await response.json().catch(() => ({}))) as {
			delivered?: unknown;
		};
		return typeof payload.delivered === "number" ? payload.delivered : 0;
	} catch (error) {
		log.warn("MCP subscription publish failed", {
			event: "mcp.subscription.publish_failed",
			appId,
			step: event.method,
			outcome: "unavailable",
			error: contentFreeMcpException(error),
		});
		return 0;
	}
}

export async function publishMcpTaskNotification(input: {
	env: CloudflareEnv;
	appId: string;
	organizationId?: string | null;
	state: McpTaskState | Record<string, unknown>;
}): Promise<number> {
	const taskId =
		typeof input.state.taskId === "string" ? input.state.taskId : undefined;
	if (!taskId) return 0;
	return publishToSubscriptionDo(input.env, input.appId, {
		organizationId: input.organizationId ?? null,
		method: "notifications/tasks",
		taskId,
		state: input.state as Record<string, unknown>,
	});
}

export async function publishMcpListChanged(input: {
	env: CloudflareEnv;
	appId: string;
	organizationId?: string | null;
	kind: "tools" | "prompts" | "resources";
}): Promise<number> {
	const method =
		input.kind === "tools"
			? "notifications/tools/list_changed"
			: input.kind === "prompts"
				? "notifications/prompts/list_changed"
				: "notifications/resources/list_changed";
	return publishToSubscriptionDo(input.env, input.appId, {
		organizationId: input.organizationId ?? null,
		method,
	});
}

type ListChangedKind = "tools" | "prompts" | "resources";

/**
 * Config-driven endpoints (D1 `app_tools.config.endpoint`) whose successful
 * dispatch mutates an app's tool/prompt/resource inventory. Keyed by the exact
 * endpoint string the ToolHandler dispatches to (see
 * `PLATFORM_OPERATOR_TOOL_DEFINITIONS` in `mcp/platform-operator-tools.ts`).
 *
 * apps/api's appTools CRUD router already publishes
 * `notifications/tools/list_changed` itself
 * (`apps/api/src/rpc/routers/app-tools.ts`), so the appTools/* entries add only
 * the prompt/resource projections of the same `app_tools` row change: prompt
 * rows (`toolTypeId: "prompt"`) surface in `prompts/list`, and every tool row
 * derives a `ui://` widget-template resource in `resources/list`. The catalog
 * entries have no apps/api-side publish at all, so they emit all applicable
 * kinds from this seam.
 */
const INVENTORY_MUTATION_ENDPOINT_KINDS: Record<
	string,
	readonly ListChangedKind[]
> = {
	"appTools/create": ["prompts", "resources"],
	"appTools/update": ["prompts", "resources"],
	"appTools/delete": ["prompts", "resources"],
	"appTools/enable": ["prompts", "resources"],
	"appTools/disable": ["prompts", "resources"],
	"appTools/reorder": ["prompts", "resources"],
	"catalog/syncCatalogToolsToApp": ["tools", "prompts", "resources"],
	"catalog/runOpenApiImport": ["tools", "resources"],
};

export function mcpInventoryListChangedKinds(
	endpoint: string | undefined,
): readonly ListChangedKind[] {
	return endpoint ? (INVENTORY_MUTATION_ENDPOINT_KINDS[endpoint] ?? []) : [];
}

/**
 * Publish `notifications/{kind}/list_changed` nudges for a tool-inventory mutation
 * dispatched through the config-driven handler pipeline. No-op when the
 * endpoint is not an inventory mutation or the `MCP_SUBSCRIPTIONS` binding is
 * absent. Returns total delivered notifications across kinds and apps.
 */
export async function publishMcpInventoryListChanged(input: {
	env: CloudflareEnv;
	endpoint: string | undefined;
	appIds: Array<string | null | undefined>;
	organizationId?: string | null;
}): Promise<number> {
	const kinds = mcpInventoryListChangedKinds(input.endpoint);
	if (kinds.length === 0) return 0;
	const uniqueAppIds = [
		...new Set(
			input.appIds.filter(
				(id): id is string => typeof id === "string" && id.length > 0,
			),
		),
	];
	let delivered = 0;
	for (const appId of uniqueAppIds) {
		for (const kind of kinds) {
			delivered += await publishMcpListChanged({
				env: input.env,
				appId,
				organizationId: input.organizationId ?? null,
				kind,
			});
		}
	}
	return delivered;
}
