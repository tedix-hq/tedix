/**
 * Centralized Widget Registration Helper
 *
 * Provides a unified API for registering MCP tools with associated widget resources,
 * following the Skybridge pattern for Apps SDK and MCP-App host profiles.
 *
 * This module centralizes the tool + widget resource registration logic that was
 * previously scattered in McpAgent, ensuring consistent resource URI derivation,
 * tool metadata, and CSP configuration across all tools.
 *
 * Key benefits:
 * - Atomic registration: Tool and resources are registered together
 * - Consistent URI derivation: outputTemplate always points to a registered resource
 * - Dual profile support: Apps SDK (text/html+skybridge) and MCP-App (text/html;profile=mcp-app)
 * - Fail-closed behavior: Returns null on any error to prevent orphan references
 *
 * @module @tedix/mcp/utils/register-widget
 */
import type {
	McpServer,
	StandardSchemaWithJSON,
	ToolAnnotations,
} from "@modelcontextprotocol/server";
import type { AppTool } from "@tedix/api-contract/schemas/app";
import {
	McpAppPermissionsSchema,
	type McpAppPermissions,
} from "@tedix/api-contract/schemas/widget";
import { MCP_RESULT_CACHE_HINT_META_KEY } from "@tedix/mcp-shared/transport";
import { createMcpLogger } from "../../log";
import {
	type ToolCallback,
	wrapToolCallTelemetry,
} from "../middleware/telemetry";
import type { ServerContext } from "../server-context";
import type { OpenAiWidgetCSP, OpenAiWidgetMeta } from "../types";
import type { ToolInputStandardSchema } from "./schema";

const log = createMcpLogger("mcp.widget.registration");

// =============================================================================
// TYPES
// =============================================================================

/**
 * App context required for widget registration
 * Contains the minimal app information needed for theming and routing
 */
export interface WidgetAppContext {
	/** App UUID (primary identifier) */
	id: string;
	/** App slug (for subdomain routing) */
	slug: string;
	/** App display name */
	name: string;
	/** Default widget domain (from MCP_UI_URL env) */
	defaultWidgetDomain: string;
}

/**
 * Analytics callback for resource read events
 */
export interface ResourceReadEvent {
	/** Resource URI being read */
	resourceUri: string;
	/** Resource type (apps-sdk or mcp-app) */
	resourceType: "apps-sdk" | "mcp-app";
	/** Widget key from tool config */
	widgetKey: string;
	/** Tool ID */
	toolId: string;
}

/**
 * Options for registering a widget tool with dual resources
 */
export interface RegisterWidgetOptions {
	/** MCP server instance to register with */
	server: McpServer;
	/** Per-request server context — used to wrap the handler with tool_call telemetry */
	serverCtx: ServerContext;
	/** Tool configuration from D1 */
	tool: AppTool;
	/** Widget route path (e.g., "/search-listings") */
	widgetRoute: string;
	/** Widget version for cache busting (e.g., "93a4f4be") */
	widgetVersion: string;
	/** App context for theming and routing */
	appContext: WidgetAppContext;
	/** MCP tool annotations (behavior hints) */
	annotations?: ToolAnnotations;
	/** Standard Schema input (raw D1 JSON Schema via jsonSchemaToInputSchema) */
	inputSchema: ToolInputStandardSchema;
	/** Optional output schema for the tool (raw D1 JSON Schema via fromJsonSchema) */
	outputSchema?: StandardSchemaWithJSON;
	/** Tool execution handler */
	handler: ToolCallback;
	/** Function to build CSP configuration for the tool */
	buildCsp: (tool: AppTool) => Promise<OpenAiWidgetCSP>;
	/** Function to fetch widget HTML from the widget server */
	fetchHtml: (
		route: string,
		description: string,
		hostType: "apps-sdk" | "mcp-app",
	) => Promise<string>;
	/** Optional callback for analytics tracking when a resource is read */
	onResourceRead?: (event: ResourceReadEvent) => void;
	/**
	 * Set of resource URIs already registered in this request lifecycle.
	 * When multiple tools share the same widgetKey, they produce identical
	 * resource URIs. Pass a shared Set so duplicate resource registration
	 * is skipped (the tool still registers and points to the shared resource).
	 */
	registeredResourceUris?: Set<string>;
	/** Per-tool securitySchemes for ChatGPT OAuth UI triggering */
	securitySchemes?: Array<{ type: string; scopes?: string[] }>;
}

/**
 * Result of successful widget tool registration
 */
export interface RegisterWidgetResult {
	/** Registered tool name (same as tool.toolId) */
	toolName: string;
	/** Registered resource URIs for both profiles */
	resourceUris: {
		/** Apps SDK resource URI (ui://widgets/apps-sdk/...) */
		appsSdk: string;
		/** MCP-App resource URI (ui://widgets/mcp-app/...) */
		mcpApp: string;
	};
	/** Output template URI (used in tool _meta) */
	outputTemplate: string;
}

/**
 * MIME types for widget resources
 */
export const WIDGET_MIME_TYPES = {
	/** MIME type for Apps SDK widgets (Skybridge) */
	APPS_SDK: "text/html+skybridge" as const,
	/** MIME type for MCP-App widgets */
	MCP_APP: "text/html;profile=mcp-app" as const,
};

/**
 * SEP-2549 result-level freshness hint for `resources/read` of static `ui://`
 * widget templates. The HTML is deploy-versioned (GIT_SHA via
 * {@link getWidgetVersion}) and identical for every caller of the app, so any
 * intermediary may cache it → `"public"`, 1 hour — mirroring the
 * `Cache-Control: public, max-age=3600` this edge already serves for its
 * static well-known payloads (well-known.ts).
 * Attached to the read result under `MCP_RESULT_CACHE_HINT_META_KEY`
 * (`@tedix/mcp-shared/transport`); the transport strips the marker and emits
 * the fields.
 */
export const WIDGET_RESOURCE_CACHE_HINT = {
	ttlMs: 3_600_000,
	cacheScope: "public",
} as const;

// =============================================================================
// URI BUILDERS
// =============================================================================

/**
 * Build resource URIs for both Apps SDK and MCP-App profiles
 *
 * URI pattern: ui://widgets/{profile}/{appSlug}/{widgetRoute}.html?v={version}
 *
 * @param appSlug - App slug for routing
 * @param widgetRoute - Widget route path (e.g., "/search-listings")
 * @param version - Widget version for cache busting
 * @returns Object with URIs for both profiles
 *
 * @example
 * ```typescript
 * const uris = buildResourceUris("acme", "/search-listings", "93a4f4be");
 * // Returns:
 * // {
 * //   appsSdk: "ui://widgets/apps-sdk/acme/search-listings.html",
 * //   mcpApp: "ui://widgets/mcp-app/acme/search-listings.html"
 * // }
 * ```
 */
export function buildResourceUris(
	appSlug: string,
	widgetRoute: string,
	_version: string,
): { appsSdk: string; mcpApp: string } {
	// Normalize widget route (remove leading slash for URI construction)
	const normalizedRoute = widgetRoute.replace(/^\//, "");

	// Resource URIs are version-agnostic. The ?v= cache-busting suffix is only
	// used in the outputTemplate (tool _meta) for browser-side caching.
	// ChatGPT may cache outputTemplate URIs across deploys and later call
	// resources/read with a stale version hash — omitting ?v= avoids mismatches.
	return {
		appsSdk: `ui://widgets/apps-sdk/${appSlug}/${normalizedRoute}.html`,
		mcpApp: `ui://widgets/mcp-app/${appSlug}/${normalizedRoute}.html`,
	};
}

// =============================================================================
// TOOL META BUILDERS
// =============================================================================

/**
 * Build tool _meta object with all OpenAI Apps SDK fields
 *
 * Constructs the metadata object that enables widget rendering in AI hosts.
 * Includes both Apps SDK fields (openai/*) and MCP-App fields (ui.*).
 *
 * @param tool - Tool configuration from D1
 * @param resourceUris - Generated resource URIs for both profiles
 * @returns OpenAiWidgetMeta object for tool registration
 *
 * @example
 * ```typescript
 * const meta = buildToolMeta(tool, {
 *   appsSdk: "ui://widgets/apps-sdk/acme/search-listings.html?v=93a4f4be",
 *   mcpApp: "ui://widgets/mcp-app/acme/search-listings.html?v=93a4f4be"
 * });
 * ```
 */
export function buildToolMeta(
	tool: AppTool,
	resourceUris: { appsSdk: string; mcpApp: string },
): OpenAiWidgetMeta {
	// Parse invocation status from dedicated column, falling back to config
	const invocationStatus = (tool.invocationStatus ??
		(tool.config as Record<string, unknown> | null)?.invocationStatus) as {
		invoking?: string;
		invoked?: string;
	} | null;

	// Parse file params from dedicated column, falling back to config
	const fileParams = (tool.fileParams ??
		(tool.config as Record<string, unknown> | null)?.fileParams) as
		| string[]
		| null;

	return {
		...(tool.meta && typeof tool.meta === "object" && !Array.isArray(tool.meta)
			? (tool.meta as Record<string, unknown>)
			: {}),

		// Output template points to Apps SDK resource
		"openai/outputTemplate": resourceUris.appsSdk,

		// Widget accessibility
		"openai/widgetAccessible": tool.widgetAccessible ?? true,

		// Visibility (user or public)
		...(tool.visibility && {
			"openai/visibility": tool.visibility as "public" | "private",
		}),

		// Invocation status messages
		...(invocationStatus?.invoking && {
			"openai/toolInvocation/invoking": invocationStatus.invoking,
		}),
		...(invocationStatus?.invoked && {
			"openai/toolInvocation/invoked": invocationStatus.invoked,
		}),

		// File parameters (for file upload tools)
		...(fileParams?.length && {
			"openai/fileParams": fileParams,
		}),

		// Indicates this tool can produce a widget
		"openai/resultCanProduceWidget": true,

		// MCP-App profile resource reference
		ui: {
			resourceUri: resourceUris.mcpApp,
			visibility: ["model", "app"] as const,
		},

		// Tedix namespace — tool provenance for the MCP plugin
		"com.tedix/hasWidget": true,
		"com.tedix/widgetDescription":
			tool.widgetDescription ?? tool.description ?? `Widget for ${tool.toolId}`,
		...(tool.widgetKey && { "com.tedix/widgetKey": tool.widgetKey }),
		"com.tedix/toolTypeId": tool.toolTypeId ?? "unknown",
	};
}

// =============================================================================
// RESOURCE META BUILDERS
// =============================================================================

/**
 * Build resource _meta for Apps SDK profile
 *
 * Apps SDK resources use openai/* prefixed metadata fields for CSP,
 * domain configuration, and widget description.
 *
 * @param tool - Tool configuration for widget metadata
 * @param csp - CSP configuration for the widget
 * @param widgetDomain - Widget domain for sandbox routing
 * @returns Metadata object for Apps SDK resource
 */
export function buildAppsSdkResourceMeta(
	tool: AppTool,
	csp: OpenAiWidgetCSP,
	widgetDomain: string,
): Record<string, unknown> {
	return {
		"openai/widgetDescription":
			tool.widgetDescription ?? tool.description ?? `Widget for ${tool.toolId}`,
		"openai/widgetPrefersBorder": tool.widgetPrefersBorder ?? true,
		"openai/widgetDomain": tool.widgetDomain ?? widgetDomain,
		"openai/widgetCSP": csp,
	};
}

/**
 * Build resource _meta for MCP-App profile.
 *
 * MCP Apps keeps security/rendering policy on the resource `_meta.ui` object.
 * Tool metadata only points at the resource with `_meta.ui.resourceUri`.
 *
 * @param tool - Tool configuration for widget metadata
 * @param csp - CSP configuration for the widget
 * @param widgetDomain - Widget domain for sandbox routing
 * @returns Metadata object for MCP-App resource
 */
export function buildMcpAppResourceMeta(
	tool: Pick<AppTool, "config" | "widgetDomain" | "widgetPrefersBorder"> | null,
	csp: OpenAiWidgetCSP,
	widgetDomain: string,
	options?: { prefersBorder?: boolean },
): Record<string, unknown> {
	const domain = tool?.widgetDomain ?? widgetDomain;
	return {
		ui: {
			csp: {
				baseUriDomains: [domain],
				connectDomains: csp.connect_domains,
				frameDomains: csp.frame_domains,
				resourceDomains: csp.resource_domains,
			},
			domain,
			permissions: resolveMcpAppPermissions(tool?.config),
			prefersBorder:
				options?.prefersBorder ?? tool?.widgetPrefersBorder ?? true,
		},
		"mcpui.dev/ui-preferred-frame-size": ["100%", "420px"],
	};
}

/** Parse per-tool permissions without ever widening host authority. */
export function resolveMcpAppPermissions(
	config: AppTool["config"] | undefined,
): McpAppPermissions {
	const parsed = McpAppPermissionsSchema.safeParse(
		config?.mcpAppPermissions ?? {},
	);
	return parsed.success ? parsed.data : {};
}

// =============================================================================
// MAIN REGISTRATION FUNCTION
// =============================================================================

/**
 * Register a widget tool with dual resources (Apps SDK + MCP-App)
 *
 * This is the main entry point for widget tool registration. It:
 * 1. Validates inputs
 * 2. Derives resource URIs
 * 3. Builds tool metadata
 * 4. Registers the tool with the MCP server
 * 5. Registers both Apps SDK and MCP-App resources
 *
 * **Fail-closed behavior**: If any step fails, returns null and logs the error.
 * This prevents orphan references (outputTemplate pointing to unregistered resources).
 *
 * @param options - Registration options
 * @returns RegisterWidgetResult on success, null on failure
 *
 * @example
 * ```typescript
 * const result = await registerWidgetTool({
 *   server,
 *   tool,
 *   widgetRoute: "/search-listings",
 *   widgetVersion: "93a4f4be",
 *   appContext: { id: "...", slug: "acme", name: "Acme", ... },
 *   inputSchema: jsonSchemaToInputSchema(tool.inputSchema, { toolId: tool.toolId, lenient: false }),
 *   handler: async (args) => { ... },
 *   buildCsp: async (tool) => { ... },
 *   fetchHtml: async (route, desc, hostType) => { ... },
 * });
 *
 * if (result) {
 *   console.log(`Registered: ${result.toolName}`);
 * }
 * ```
 */
export async function registerWidgetTool(
	options: RegisterWidgetOptions,
): Promise<RegisterWidgetResult | null> {
	const {
		server,
		serverCtx,
		tool,
		widgetRoute,
		widgetVersion,
		appContext,
		annotations,
		inputSchema,
		outputSchema,
		handler,
		buildCsp,
		fetchHtml,
		onResourceRead,
		registeredResourceUris,
		securitySchemes,
	} = options;

	try {
		// =======================================================================
		// STEP 1: Validate inputs
		// =======================================================================
		if (!tool.toolId) {
			log.error("Widget tool missing identifier", {
				event: "widget_registration.tool_id_missing",
				appId: appContext.id,
				outcome: "invalid",
			});
			return null;
		}

		if (!widgetRoute) {
			log.error("Widget tool missing route", {
				event: "widget_registration.route_missing",
				appId: appContext.id,
				toolName: tool.toolId,
				outcome: "invalid",
			});
			return null;
		}

		if (!appContext.slug) {
			log.error("Widget app slug missing", {
				event: "widget_registration.app_slug_missing",
				appId: appContext.id,
				toolName: tool.toolId,
				outcome: "invalid",
			});
			return null;
		}

		// =======================================================================
		// STEP 2: Build resource URIs
		// =======================================================================
		const resourceUris = buildResourceUris(
			appContext.slug,
			widgetRoute,
			widgetVersion,
		);

		// =======================================================================
		// STEP 3: Build tool metadata
		// =======================================================================
		const toolMeta: Record<string, unknown> = buildToolMeta(tool, resourceUris);

		// Inject securitySchemes into _meta for ChatGPT per-tool auth declarations
		if (securitySchemes) {
			toolMeta.securitySchemes = securitySchemes;
		}

		// Tedix namespace — app slug for provenance
		toolMeta["com.tedix/appSlug"] = appContext.slug;

		// =======================================================================
		// STEP 4: Register the tool
		// =======================================================================
		const registeredTool = server.registerTool(
			tool.toolId,
			{
				title: tool.title,
				description: tool.description ?? `Tool: ${tool.toolId}`,
				inputSchema,
				...(outputSchema && { outputSchema }),
				...(tool.icons ? { icons: tool.icons } : {}),
				annotations,
				_meta: toolMeta,
			},
			wrapToolCallTelemetry(
				tool.toolId,
				serverCtx,
				handler,
				tool,
			) as unknown as Parameters<typeof server.registerTool>[2],
		);

		if (!registeredTool) {
			log.error("Failed to register widget tool", {
				event: "widget_registration.tool_failed",
				appId: appContext.id,
				toolName: tool.toolId,
				outcome: "unavailable",
			});
			return null;
		}

		// =======================================================================
		// STEP 5: Register Apps SDK resource (skip if URI already registered)
		// =======================================================================
		const appsSdkResourceId = `widget-${tool.toolId}`;
		const widgetDescription =
			tool.widgetDescription ?? tool.description ?? `Widget for ${tool.toolId}`;
		const widgetDomain = appContext.defaultWidgetDomain;

		const appsSdkUriExists = registeredResourceUris?.has(resourceUris.appsSdk);

		if (!appsSdkUriExists) {
			const appsSdkResource = server.registerResource(
				appsSdkResourceId,
				resourceUris.appsSdk,
				{ description: widgetDescription },
				async () => {
					onResourceRead?.({
						resourceUri: resourceUris.appsSdk,
						resourceType: "apps-sdk",
						widgetKey: tool.widgetKey || tool.toolId,
						toolId: tool.toolId,
					});

					const [html, csp] = await Promise.all([
						fetchHtml(widgetRoute, widgetDescription, "apps-sdk"),
						buildCsp(tool),
					]);

					return {
						contents: [
							{
								uri: resourceUris.appsSdk,
								mimeType: WIDGET_MIME_TYPES.APPS_SDK,
								text: html,
								_meta: buildAppsSdkResourceMeta(tool, csp, widgetDomain),
							},
						],
						// Static deploy-versioned template → long public freshness hint
						// (consumed + stripped by the transport).
						_meta: {
							[MCP_RESULT_CACHE_HINT_META_KEY]: WIDGET_RESOURCE_CACHE_HINT,
						},
					};
				},
			);

			if (!appsSdkResource) {
				log.error("Failed to register Apps SDK resource", {
					event: "widget_registration.apps_sdk_resource_failed",
					appId: appContext.id,
					toolName: tool.toolId,
					outcome: "unavailable",
				});
				try {
					registeredTool.remove();
				} catch {
					// Ignore cleanup errors
				}
				return null;
			}

			registeredResourceUris?.add(resourceUris.appsSdk);
		}

		// =======================================================================
		// STEP 6: Register MCP-App resource (skip if URI already registered)
		// =======================================================================
		const mcpAppResourceId = `mcp-app-${tool.toolId}`;
		const mcpAppUriExists = registeredResourceUris?.has(resourceUris.mcpApp);

		if (!mcpAppUriExists) {
			const mcpAppResource = server.registerResource(
				mcpAppResourceId,
				resourceUris.mcpApp,
				{ description: `${widgetDescription} (mcp-app)` },
				async () => {
					onResourceRead?.({
						resourceUri: resourceUris.mcpApp,
						resourceType: "mcp-app",
						widgetKey: tool.widgetKey || tool.toolId,
						toolId: tool.toolId,
					});

					const [html, csp] = await Promise.all([
						fetchHtml(widgetRoute, widgetDescription, "mcp-app"),
						buildCsp(tool),
					]);

					return {
						contents: [
							{
								uri: resourceUris.mcpApp,
								mimeType: WIDGET_MIME_TYPES.MCP_APP,
								text: html,
								_meta: buildMcpAppResourceMeta(tool, csp, widgetDomain),
							},
						],
						// Static deploy-versioned template → long public freshness hint
						// (consumed + stripped by the transport).
						_meta: {
							[MCP_RESULT_CACHE_HINT_META_KEY]: WIDGET_RESOURCE_CACHE_HINT,
						},
					};
				},
			);

			if (!mcpAppResource) {
				log.error("Failed to register MCP App resource", {
					event: "widget_registration.mcp_app_resource_failed",
					appId: appContext.id,
					toolName: tool.toolId,
					outcome: "unavailable",
				});
				try {
					registeredTool.remove();
				} catch {
					// Ignore cleanup errors
				}
				return null;
			}

			registeredResourceUris?.add(resourceUris.mcpApp);
		}

		// =======================================================================
		// SUCCESS
		// =======================================================================
		return {
			toolName: tool.toolId,
			resourceUris,
			outputTemplate: resourceUris.appsSdk,
		};
	} catch (error) {
		log.error("Widget registration failed", {
			event: "widget_registration.failed",
			appId: appContext.id,
			toolName: tool.toolId,
			outcome: "unavailable",
			error,
		});
		return null;
	}
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get widget version hash for cache busting
 *
 * Uses the first 8 characters of GIT_SHA, or "dev" for local development.
 * Pattern learned from TheFork (live App Store app): ?v=93a4f4be
 *
 * @param env - Environment with optional GIT_SHA
 * @returns 8-character version string
 */
export function getWidgetVersion(env: { GIT_SHA?: string }): string {
	const sha = env.GIT_SHA || "dev";
	return sha.slice(0, 8);
}
