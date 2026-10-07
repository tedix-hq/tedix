import {
	MCP_CAPABILITY_SCOPES,
	MCP_GRANULAR_CAPABILITY_SCOPES,
} from "@tedix/api-contract/schemas/mcp-capability-scopes";
import {
	CatalogueTransportConfigSchema,
	catalogueInputDeclarationMatches,
	ToolInputJsonSchemaSchema,
	ToolJsonSchemaSchema,
} from "@tedix/api-contract/schemas/tools";
import { resolveMcpToolRequiredScopes } from "@tedix/mcp-shared/auth/tool-scopes";
/**
 * Bootstrap tool + resource registration.
 *
 * Always-on tools that don't come from D1 `app_tools`:
 * - `get_info` — server identity (name, slug, tool count, capabilities)
 * - `__track_widget_analytics` — internal widget event reporter
 * - `app-info` resource — same identity payload, addressable as a resource
 *
 * Called from `buildMcpServer()` once per request. Skill resources
 * (`list_skills`, `read_skill`, `skill://`) live in their own registration
 * path — see `tool-registration.ts::registerAppSkills`.
 */

import * as z from "zod";
import {
	McpNativeBootstrapSchema,
	McpNativeDescriptorSchema,
	McpNativeContextSchema,
} from "@tedix/api-contract/schemas/mcp-native-transport";
import { shouldBypassCodeModeForCaller } from "../caller-identity";
import { evaluateMcpToolScopeAuthorization } from "../codemode-auth";

import type { AppTool } from "../server-context";
import { createMcpLogger } from "../../log";
import type { ServerContext } from "../server-context";
import { registerAccountProfile } from "./account-profile";

export function isConfiguredCatalogTool(
	tool: AppTool,
	mcpConfig: Record<string, unknown> | undefined,
): boolean {
	const configured = CatalogueTransportConfigSchema.safeParse(tool.config);
	if (
		!tool.enabled ||
		mcpConfig?.enforcePolicies === true ||
		!configured.success ||
		!catalogueInputDeclarationMatches(
			configured.data.endpoint,
			tool.inputSchema,
		)
	)
		return false;
	if (
		!ToolInputJsonSchemaSchema.safeParse(tool.inputSchema).success ||
		(tool.outputSchema !== null &&
			tool.outputSchema !== undefined &&
			!ToolJsonSchemaSchema.safeParse(tool.outputSchema).success)
	)
		return false;
	const scopes = mcpConfig?.toolScopes;
	if (
		!scopes ||
		typeof scopes !== "object" ||
		!Object.hasOwn(scopes, tool.toolId)
	)
		return false;
	const own = (scopes as Record<string, unknown>)[tool.toolId];
	if (
		!Array.isArray(own) ||
		!own.length ||
		own.some(
			(scope) =>
				typeof scope !== "string" ||
				(!Object.hasOwn(MCP_CAPABILITY_SCOPES, scope) &&
					!Object.hasOwn(MCP_GRANULAR_CAPABILITY_SCOPES, scope)),
		)
	)
		return false;
	try {
		return (
			resolveMcpToolRequiredScopes(tool, "", {
				...mcpConfig,
				enforcePolicies: false,
				toolScopes: { [tool.toolId]: own },
			}).length > 0
		);
	} catch {
		return false;
	}
}

const log = createMcpLogger("mcp.registration.bootstrap");

/**
 * Register minimal bootstrap tools (fallback when no D1 tools exist).
 * Satisfies OpenAI Apps SDK requirement of ≥1 tool during initialize handshake.
 */
/** Literal wire identity and caller-relative eligibility; never an execution grant. */
export function nativeDescriptor(
	agent: ServerContext,
	tool: AppTool,
	registry: ReadonlyArray<AppTool> = [...agent.loadedTools.values()],
) {
	const unique =
		registry.filter((row) => row.toolId === tool.toolId).length === 1;
	let authorized = false;
	try {
		authorized = evaluateMcpToolScopeAuthorization(
			agent,
			tool,
			String(tool.config?._aggregateNamespace ?? agent.appSlug),
		).authorized;
	} catch {
		/* Missing mapping is an explicit refusal. */
	}
	const endpoint =
		typeof tool.config?.endpoint === "string" ? tool.config.endpoint : null;
	if (!endpoint || !tool.id) return null;
	const parsed = McpNativeDescriptorSchema.safeParse({
		name: tool.toolId,
		toolRowId: tool.id,
		endpoint,
		eligible:
			unique &&
			shouldBypassCodeModeForCaller(
				agent.callerIdentity,
				tool.toolId,
				registry,
			),
		authorized,
		schemaFreshness: {
			source: tool.schemaSource ?? null,
			sourceRef: tool.schemaSourceRef ?? null,
			sourceHash: tool.schemaSourceHash ?? null,
			syncedAt: tool.schemaSyncedAt ?? null,
		},
	});
	return parsed.success ? parsed.data : null;
}

export function buildNativeBootstrap(
	agent: ServerContext,
	registry: ReadonlyArray<AppTool> = [...agent.loadedTools.values()],
) {
	const caller = agent.callerIdentity;
	const org = agent.app?.organizationId;
	const authenticated =
		caller &&
		caller.authType !== "anonymous" &&
		typeof org === "string" &&
		caller.organizationId === org;
	const parsedContext = McpNativeContextSchema.safeParse(
		authenticated
			? {
					version: 1 as const,
					surface: "mcp-gateway" as const,
					appId: agent.appId,
					appSlug: agent.appSlug,
					organizationId: org,
					actor: { authType: caller.authType },
					nativeTransportAvailable:
						!caller.forceCodeMode &&
						registry.some(
							(tool) => nativeDescriptor(agent, tool, registry)?.eligible,
						),
				}
			: null,
	);
	const nativeContext = parsedContext.success ? parsedContext.data : null;
	const select = (endpoint: string) => {
		const matches = registry.filter(
			(tool) =>
				tool.config?.transport === "catalog" &&
				tool.config?.endpoint === endpoint,
		);
		if (
			matches.length !== 1 ||
			!isConfiguredCatalogTool(matches[0]!, agent.appMetadata?.mcpConfig)
		)
			return null;
		const configured = CatalogueTransportConfigSchema.parse(matches[0]!.config);
		return configured.endpoint === endpoint
			? nativeDescriptor(agent, matches[0]!, registry)
			: null;
	};
	const search = select("catalog/search"),
		describe = select("catalog/describe");
	const usable = !!(
		nativeContext?.nativeTransportAvailable &&
		search?.eligible &&
		search.authorized &&
		describe?.eligible &&
		describe.authorized &&
		search.name !== describe.name
	);
	return McpNativeBootstrapSchema.parse({
		nativeContext,
		nativeCatalog: {
			status: usable ? "usable" : "unavailable",
			search: usable ? search : null,
			describe: usable ? describe : null,
		},
	});
}

export function buildBootstrapInfo(
	agent: ServerContext,
	registry?: ReadonlyArray<AppTool>,
) {
	return {
		name: agent.app?.name ?? "Unknown App",
		slug: agent.appSlug ?? "unknown",
		description: agent.app?.description ?? null,
		domain: agent.app?.domain ?? null,
		logoUrl: agent.app?.logoUrl ?? null,
		serverVersion: agent.getServerVersion(),
		toolCount: agent.registeredTools.size,
		capabilities: agent.appCapabilities,
		...buildNativeBootstrap(agent, registry),
	};
}

export function registerGetInfoTool(
	agent: ServerContext,
	registry?: ReadonlyArray<AppTool>,
): void {
	const appName = agent.app?.name ?? "Unknown App";

	const getInfoTool = agent.server.registerTool(
		"get_info",
		{
			title: `${appName} Info`,
			description: `Get metadata about the ${appName} MCP server itself (name, version, tool count). Only use when the user asks about this server's identity or capabilities — NOT for answering general questions.`,
			inputSchema: z.object({}),
			annotations: {
				readOnlyHint: true,
				openWorldHint: false,
				destructiveHint: false,
			},
		},
		async () => {
			const info = buildBootstrapInfo(agent, registry);

			const text = [
				`${info.name} MCP Server v${info.serverVersion}`,
				info.description ? `\n${info.description}` : "",
				`\nTools: ${info.toolCount}`,
				info.domain ? `Domain: ${info.domain}` : "",
			]
				.filter(Boolean)
				.join("\n");

			return {
				content: [{ type: "text" as const, text }],
				structuredContent: info,
			};
		},
	);

	agent.registeredTools.set("get_info", getInfoTool);
	console.log("[MCP] Registered bootstrap tool: get_info");
}

export function registerBootstrapTools(
	agent: ServerContext,
	registry?: ReadonlyArray<AppTool>,
): void {
	registerAccountProfile(agent);
	registerGetInfoTool(agent, registry);

	// ------------------------------------------------------------------
	// __track_widget_analytics — internal widget interaction tracking
	// ------------------------------------------------------------------
	const trackWidgetAnalyticsTool = agent.server.registerTool(
		"__track_widget_analytics",
		{
			title: "Track Widget Analytics",
			description:
				"Internal tool for widgets to report user interaction events. Not intended for direct AI use.",
			inputSchema: z.object({
				eventType: z
					.enum([
						"item_impression",
						"item_click",
						"external_cta_click",
						"checkout_start",
						"filter",
						"sort",
						"select_item",
					])
					.describe("Event type"),
				itemId: z
					.string()
					.max(256)
					.optional()
					.describe("Item ID for item_click/select_item events"),
				itemPosition: z
					.number()
					.int()
					.min(0)
					.max(10000)
					.optional()
					.describe("Zero-based item position in list"),
				widgetKey: z
					.string()
					.max(128)
					.optional()
					.describe("Widget layout key (e.g. search_listings)"),
				displayMode: z
					.enum(["inline", "fullscreen", "pip", "modal"])
					.optional()
					.describe("Current display mode"),
				metadata: z
					.string()
					.max(4096)
					.optional()
					.describe(
						"Optional JSON metadata (filter field/value, sort key, etc.)",
					),
			}),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				openWorldHint: false,
			},
		},
		async ({
			eventType,
			itemId,
			itemPosition,
			widgetKey,
			displayMode,
			metadata,
		}) => {
			let parsedMetadata: Record<string, unknown> | undefined;
			if (metadata) {
				try {
					parsedMetadata = JSON.parse(metadata) as Record<string, unknown>;
				} catch {
					parsedMetadata = { raw: metadata };
				}
			}
			const event = {
				id: crypto.randomUUID(),
				appId: agent.appId,
				sessionId: agent.traceId,
				eventType,
				itemId,
				itemPosition,
				widgetKey,
				displayMode,
				metadata: parsedMetadata,
				createdAt: new Date().toISOString(),
			};

			agent.ctx.waitUntil(
				agent.apiClient.analytics
					.trackWidgetEvents({
						events: [event],
						// Defense-in-depth: server validates every event.appId === expectedAppId
						expectedAppId: agent.appId,
					})
					.catch((err: unknown) => {
						log.error("Failed to track widget event", {
							event: "widget_analytics.track_failed",
							appId: agent.appId,
							traceId: agent.traceId,
							outcome: "unavailable",
							error: err,
						});
					}),
			);

			return {
				content: [{ type: "text" as const, text: '{"success":true}' }],
				structuredContent: { success: true },
			};
		},
	);

	agent.registeredTools.set(
		"__track_widget_analytics",
		trackWidgetAnalyticsTool,
	);
	console.log("[MCP] Registered bootstrap tool: __track_widget_analytics");
}

/**
 * Register minimal bootstrap resources (fallback).
 */
export function registerBootstrapResources(agent: ServerContext): void {
	const appSlug = agent.appSlug || "unknown";
	const infoResourceUri = `info://${appSlug}/app-info.json`;

	const infoResource = agent.server.registerResource(
		"app-info",
		infoResourceUri,
		{ description: `${agent.app?.name ?? "App"} information and capabilities` },
		async () => {
			const info = {
				name: agent.app?.name ?? "Unknown App",
				slug: appSlug,
				description: agent.app?.description ?? null,
				domain: agent.app?.domain ?? null,
				logoUrl: agent.app?.logoUrl ?? null,
				serverVersion: agent.getServerVersion(),
				toolCount: agent.registeredTools.size,
				capabilities: agent.appCapabilities,
			};

			return {
				contents: [
					{
						uri: infoResourceUri,
						mimeType: "application/json",
						text: JSON.stringify(info, null, 2),
					},
				],
			};
		},
	);

	agent.registeredResources.set("app-info", infoResource);
	console.log("[MCP] Registered bootstrap resource: app-info");
}
