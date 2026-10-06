import {
	ProtocolError,
	ProtocolErrorCode,
	ResourceTemplate,
	type GetPromptResult,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import { callRpc, serviceBindingFetch } from "@tedix/api-client/internal";
import { guardedFetch, SsrfBlockedError } from "@tedix/ssrf-guard";
import {
	parseAdapterScope,
	type ResultStrategy,
} from "@tedix/api-contract/schemas/tools";
import type {
	CatalogMcpResource,
	CatalogMcpResourceTemplate,
	CatalogMcpPrompt,
	ServerContext,
} from "../server-context";
import { isTedixManagedMcpUrl } from "../managed-mcp-auth";
import { executeTool } from "../tool-execution";
import {
	buildCallerTelemetryFields,
	emitMcpAuditEvent,
	type McpEvent,
	mergeMcpMetadata,
	trackMcpEvent,
} from "../utils/analytics";
import {
	getToolLayoutSpec,
	resolveToolWidgetRoute,
	getToolBundleHtml,
} from "../utils/render-widget";
import { buildMcpAppResourceMeta } from "../utils/register-widget";
import { resolveWidgetAppSlug } from "../utils/widget-app";

function trackResourceRead(
	agent: ServerContext,
	metadata: NonNullable<McpEvent["metadata"]>,
): void {
	const callerFields = buildCallerTelemetryFields(agent.callerIdentity);
	const event: McpEvent = {
		timestamp: new Date().toISOString(),
		eventType: "resource_read",
		appId: agent.appId,
		appSlug: agent.appSlug,
		organizationId: agent.app?.organizationId,
		...callerFields,
		traceId: agent.traceId,
		success: true,
		metadata: mergeMcpMetadata(callerFields.metadata, metadata),
	};
	trackMcpEvent(agent.env, event);
	emitMcpAuditEvent(agent.env, event, agent.ctx.waitUntil.bind(agent.ctx));
}

type ResourceReadContent =
	| {
			uri: string;
			text: string;
			mimeType?: string;
			_meta?: Record<string, unknown>;
	  }
	| {
			uri: string;
			blob: string;
			mimeType?: string;
			_meta?: Record<string, unknown>;
	  };
type ResourceReadResult = {
	contents: ResourceReadContent[];
	_meta?: Record<string, unknown>;
};

function jsonContent(uri: URL, value: unknown, pretty = false) {
	return {
		contents: [
			{
				uri: uri.toString(),
				mimeType: "application/json",
				text: JSON.stringify(value, null, pretty ? 2 : undefined),
			},
		],
	};
}

function resourceVariable(value: string | string[] | undefined): string {
	return Array.isArray(value) ? value.join("/") : String(value ?? "");
}

function normalizeGeneratedWidgetRoute(widgetPath: string): string | null {
	const cleanPath = widgetPath.replace(/^\/+/, "");
	if (!cleanPath.startsWith("r/") || !cleanPath.endsWith(".html")) {
		return null;
	}
	return `/${cleanPath.slice(0, -".html".length)}`;
}

/**
 * Older Gadget manifests can retain the route originally recorded on a tool,
 * while the current canonical route is derived from its `layoutId`. Resource
 * reads must recognize that stored route too: a valid, existing Gadget should
 * never degrade to the generic loading layout merely because its tool was
 * later normalized around `layoutId`.
 */
export function normalizeConfiguredWidgetRoute(
	widgetRoute: string | null | undefined,
): string | null {
	if (typeof widgetRoute !== "string") return null;
	const cleanRoute = widgetRoute.trim().replace(/^\/+/, "");
	if (!cleanRoute.startsWith("r/") || cleanRoute.length === "r/".length) {
		return null;
	}
	return `/${cleanRoute.replace(/\.html$/i, "")}`;
}

function isAppSlug(value: string): boolean {
	return /^[a-z][a-z0-9-]{1,63}$/i.test(value);
}

function resolveGeneratedWidgetTool(
	agent: ServerContext,
	appSlug: string,
	route: string,
): ReturnType<ServerContext["loadedTools"]["get"]> {
	const matchingTools = Array.from(agent.loadedTools.values())
		.filter(
			(tool) =>
				resolveWidgetAppSlug(agent, tool) === appSlug &&
				(resolveToolWidgetRoute(tool) === route ||
					normalizeConfiguredWidgetRoute(tool.widgetRoute) === route),
		)
		.sort(
			(a, b) =>
				(a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
					(b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
				a.toolId.localeCompare(b.toolId),
		);

	return (
		matchingTools.find((tool) => getToolLayoutSpec(tool)) ?? matchingTools[0]
	);
}

export function resourceNotFound(
	uri: URL,
	data?: Record<string, unknown>,
): never {
	throw new ProtocolError(
		ProtocolErrorCode.InvalidParams,
		"Resource not found",
		{
			reason: "resource_not_found",
			uri: uri.toString(),
			resourceUri: uri.toString(),
			...data,
		},
	);
}

function stripHtmlTags(value: string): string {
	return value.replace(/<[^>]*>/g, "").trim();
}

function generatedWidgetUnavailableReason(html: string): string | null {
	if (!/<h1>\s*Widget Unavailable\s*<\/h1>/i.test(html)) {
		return null;
	}
	const paragraphs = Array.from(
		html.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi),
		(match) => stripHtmlTags(match[1] ?? ""),
	).filter(Boolean);
	return paragraphs.at(-1) ?? "Widget unavailable";
}

function isWidgetResourceNotFoundReason(reason: string): boolean {
	return /\b404\b|not found/i.test(reason);
}

async function executeJsonResourceTool(
	agent: ServerContext,
	toolId: string,
	args: Record<string, unknown>,
) {
	const tool = agent.loadedTools.get(toolId);
	if (!tool) return { tool: null, result: null };

	const result = await executeTool(agent, tool, args, {
		adapterScope: parseAdapterScope(tool.adapterScope),
		resultStrategy: (tool.resultStrategy as ResultStrategy) ?? "merge",
	});
	const text =
		result.content[0]?.text ?? JSON.stringify(result.structuredContent);
	return { tool, result: text };
}

function safeResourceId(prefix: string, value: string): string {
	return `${prefix}-${value}`
		.replace(/[^a-zA-Z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 120);
}

/** Catalog storage is intentionally lossless; only expose spec-valid audience
 * values on the MCP wire. The original observation remains in the catalog. */
export function protocolSafeResourceAnnotations(
	annotations:
		| CatalogMcpResource["annotations"]
		| CatalogMcpResourceTemplate["annotations"],
):
	| {
			audience?: Array<"user" | "assistant">;
			priority?: number;
			lastModified?: string;
	  }
	| undefined {
	if (!annotations) return undefined;
	const audience = annotations.audience?.filter(
		(value): value is "user" | "assistant" =>
			value === "user" || value === "assistant",
	);
	const normalized = {
		...(audience?.length ? { audience } : {}),
		...(typeof annotations.priority === "number"
			? { priority: annotations.priority }
			: {}),
		...(typeof annotations.lastModified === "string"
			? { lastModified: annotations.lastModified }
			: {}),
	};
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

async function fetchCatalogConnectionToken(
	agent: ServerContext,
	connectionId: string,
	scope: "tenant" | "user",
	scopes: string[] | null | undefined,
): Promise<string | null> {
	const organizationId =
		agent.callerIdentity?.organizationId ?? agent.app.organizationId;
	if (!organizationId) return null;

	const useServiceBinding = !!agent.env.API_SERVICE;
	const baseUrl = useServiceBinding ? "https://api" : agent.env.API_URL;
	const fetcher = useServiceBinding
		? serviceBindingFetch(agent.env.API_SERVICE!)
		: globalThis.fetch;

	const rpcInput: Record<string, unknown> = {
		organizationId,
		providerId: connectionId,
		scope,
	};
	if (scopes?.length) rpcInput.scopes = scopes;
	if (agent.callerIdentity?.userId) {
		rpcInput.userId = agent.callerIdentity.userId;
	}

	try {
		const data = await callRpc<{ accessToken?: string }>(
			"connections/fetchOrgToken",
			rpcInput,
			{
				apiUrl: baseUrl,
				fetch: fetcher,
				headers: {
					...(useServiceBinding ? { "X-Service-Binding": "true" } : {}),
					"X-Tedix-Org-Id": organizationId,
				},
			},
		);
		return data.accessToken ?? null;
	} catch {
		return null;
	}
}

async function buildCatalogResourceHeaders(
	agent: ServerContext,
	resource: CatalogMcpResource | CatalogMcpResourceTemplate | CatalogMcpPrompt,
): Promise<Record<string, string>> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	const connectionId =
		resource.connectionProviderId ?? resource.catalogMcp?.scanConnectionId;
	if (!connectionId) return headers;

	const requestedScope = resource.connectionScope ?? "tenant";
	const scopes = resource.connectionScopes ?? null;
	const scopeOrder =
		requestedScope === "hybrid"
			? (["user", "tenant"] as const)
			: ([requestedScope] as const);
	for (const scope of scopeOrder) {
		const token = await fetchCatalogConnectionToken(
			agent,
			connectionId,
			scope,
			scopes,
		);
		if (token) {
			const header =
				resource.catalogMcp?.scanConnectionHeader ?? "Authorization";
			const template =
				resource.catalogMcp?.scanConnectionTemplate ?? "Bearer {token}";
			headers[header] = template.replace("{token}", token);
			break;
		}
	}
	return headers;
}

async function readUpstreamCatalogResource(
	agent: ServerContext,
	resource: CatalogMcpResource | CatalogMcpResourceTemplate,
	uri: URL,
): Promise<ResourceReadResult> {
	const endpoint =
		resource.catalogMcp?.mcpEndpointNormalized ?? resource.catalogMcp?.baseUrl;
	if (!endpoint) {
		return jsonContent(uri, {
			uri: uri.toString(),
			name: "name" in resource ? resource.name : null,
			title: resource.title,
			description: resource.description,
			mimeType: resource.mimeType,
			sourceAppSlug: resource.sourceAppSlug,
			error: "No upstream MCP endpoint is stored for this catalog resource.",
		});
	}

	const headers = await buildCatalogResourceHeaders(agent, resource);
	// SSRF guard: the endpoint is a D1-sourced URL and the headers can carry a
	// Token Vault credential. Managed `*.mcp.tedix.dev`-style origins are
	// same-org config, so they keep working (allowInternalHosts), but private
	// IPs, localhost, and http downgrades stay blocked outside local dev.
	const isDev = agent.env.ENVIRONMENT === "development";
	let response: Response;
	try {
		response = await guardedFetch(
			endpoint,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: crypto.randomUUID(),
					method: "resources/read",
					params: { uri: uri.toString() },
				}),
			},
			{
				allowHttp: isDev,
				allowInternalHosts: isDev || isTedixManagedMcpUrl(endpoint),
			},
		);
	} catch (error) {
		if (error instanceof SsrfBlockedError) {
			throw new ProtocolError(
				ProtocolErrorCode.InvalidParams,
				`Upstream MCP endpoint blocked by SSRF protection: ${error.reason}`,
				{
					reason: "upstream_endpoint_blocked",
					resourceUri: uri.toString(),
					sourceAppSlug: resource.sourceAppSlug,
				},
			);
		}
		throw error;
	}
	const json = (await response.json().catch(() => null)) as {
		result?: { contents?: unknown[]; _meta?: Record<string, unknown> };
		error?: { message?: string; code?: number };
	} | null;
	if (!response.ok || json?.error || !json?.result?.contents) {
		throw new ProtocolError(
			response.status === 404
				? ProtocolErrorCode.InvalidParams
				: ProtocolErrorCode.InternalError,
			json?.error?.message ??
				`Upstream resource read failed (${response.status})`,
			{
				reason: "upstream_resource_read_failed",
				resourceUri: uri.toString(),
				sourceAppSlug: resource.sourceAppSlug,
				status: response.status,
				upstreamCode: json?.error?.code,
			},
		);
	}
	const contents = json.result.contents.flatMap(
		(content): ResourceReadContent[] => {
			if (!content || typeof content !== "object" || Array.isArray(content)) {
				return [];
			}
			const record = content as Record<string, unknown>;
			const contentUri =
				typeof record.uri === "string" ? record.uri : uri.toString();
			const mimeType =
				typeof record.mimeType === "string" ? record.mimeType : undefined;
			const meta =
				record._meta &&
				typeof record._meta === "object" &&
				!Array.isArray(record._meta)
					? (record._meta as Record<string, unknown>)
					: undefined;
			if (typeof record.text === "string") {
				return [{ uri: contentUri, text: record.text, mimeType, _meta: meta }];
			}
			if (typeof record.blob === "string") {
				return [{ uri: contentUri, blob: record.blob, mimeType, _meta: meta }];
			}
			return [];
		},
	);
	if (contents.length === 0) resourceNotFound(uri);
	return {
		contents,
		...(json.result._meta ? { _meta: json.result._meta } : {}),
	};
}

export function isSelfObservedCatalogResource(input: {
	appSlug: string;
	sourceAppSlug?: string | null;
}): boolean {
	return input.sourceAppSlug?.toLowerCase() === input.appSlug.toLowerCase();
}

const GENERATED_MCP_APP_WIDGET_TEMPLATE =
	"ui://widgets/mcp-app/{appSlug}/{+widgetPath}";

export function isTedixOwnedResourceTemplate(uriTemplate: string): boolean {
	return uriTemplate === GENERATED_MCP_APP_WIDGET_TEMPLATE;
}

function registerCatalogMcpResources(agent: ServerContext): void {
	const registered = new Set<string>();
	for (const resource of agent.catalogResources) {
		// Catalog inventory is an observation of the already-rendered MCP surface.
		// Re-registering a row observed from this same app feeds runtime resources
		// back into their source and collides with canonical bootstrap resources.
		// Aggregate/upstream resources retain a different source slug and remain.
		if (
			isSelfObservedCatalogResource({
				appSlug: agent.appSlug,
				sourceAppSlug: resource.sourceAppSlug,
			})
		)
			continue;
		if (registered.has(resource.uri)) continue;
		registered.add(resource.uri);
		const id = safeResourceId("catalog-resource", resource.uri);
		agent.server.registerResource(
			id,
			// MCP SDK runtime supports fixed URI strings and lists these under
			// resources/list. Its current declaration only exposes the template
			// overload, so contain that mismatch at this call boundary.
			resource.uri as never,
			{
				title: resource.title ?? undefined,
				description: resource.description ?? undefined,
				mimeType: resource.mimeType ?? undefined,
				icons: resource.icons ?? undefined,
				annotations: protocolSafeResourceAnnotations(resource.annotations),
				_meta: resource.meta ?? undefined,
			},
			async (uri: URL) => readUpstreamCatalogResource(agent, resource, uri),
		);
		agent.appResourceIds.add(id);
	}

	for (const template of agent.catalogResourceTemplates) {
		// The edge owns this generic template below. Catalog scans observe it on
		// every provider; replaying one observation here lets registration order
		// route an arbitrary generated Tedix view back to that provider.
		if (isTedixOwnedResourceTemplate(template.uriTemplate)) continue;
		if (
			isSelfObservedCatalogResource({
				appSlug: agent.appSlug,
				sourceAppSlug: template.sourceAppSlug,
			})
		)
			continue;
		if (registered.has(template.uriTemplate)) continue;
		registered.add(template.uriTemplate);
		const id = safeResourceId("catalog-resource-template", template.name);
		agent.server.registerResource(
			id,
			new ResourceTemplate(template.uriTemplate, { list: undefined }),
			{
				title: template.title ?? undefined,
				description: template.description ?? undefined,
				mimeType: template.mimeType ?? undefined,
				icons: template.icons ?? undefined,
				annotations: protocolSafeResourceAnnotations(template.annotations),
				_meta: template.meta ?? undefined,
			},
			async (uri: URL) => readUpstreamCatalogResource(agent, template, uri),
		);
		agent.appResourceIds.add(id);
	}
}

function promptArgumentSchema(
	args: CatalogMcpPrompt["arguments"],
): Record<string, z.ZodType> {
	return Object.fromEntries(
		(args ?? []).map((arg) => {
			const schema = z.string().describe(arg.description ?? arg.name);
			return [arg.name, arg.required === false ? schema.optional() : schema];
		}),
	) as Record<string, z.ZodType>;
}

async function getUpstreamCatalogPrompt(
	agent: ServerContext,
	prompt: CatalogMcpPrompt,
	args: Record<string, string>,
) {
	const endpoint =
		prompt.catalogMcp?.mcpEndpointNormalized ?? prompt.catalogMcp?.baseUrl;
	if (!endpoint) {
		throw new ProtocolError(
			ProtocolErrorCode.InternalError,
			"No upstream MCP endpoint is stored for this catalog prompt.",
		);
	}
	const isDev = agent.env.ENVIRONMENT === "development";
	let response: Response;
	try {
		response = await guardedFetch(
			endpoint,
			{
				method: "POST",
				headers: await buildCatalogResourceHeaders(agent, prompt),
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: crypto.randomUUID(),
					method: "prompts/get",
					params: {
						name: prompt.upstreamPromptName ?? prompt.promptName,
						arguments: args,
					},
				}),
			},
			{
				allowHttp: isDev,
				allowInternalHosts: isDev || isTedixManagedMcpUrl(endpoint),
			},
		);
	} catch (error) {
		if (error instanceof SsrfBlockedError) {
			throw new ProtocolError(
				ProtocolErrorCode.InvalidParams,
				`Upstream MCP endpoint blocked by SSRF protection: ${error.reason}`,
				{ reason: "upstream_endpoint_blocked", promptName: prompt.promptName },
			);
		}
		throw error;
	}
	const json = (await response.json().catch(() => null)) as {
		result?: {
			description?: string;
			messages?: unknown[];
			_meta?: Record<string, unknown>;
		};
		error?: { message?: string; code?: number };
	} | null;
	if (!response.ok || json?.error || !Array.isArray(json?.result?.messages)) {
		throw new ProtocolError(
			ProtocolErrorCode.InternalError,
			json?.error?.message ??
				`Upstream prompt fetch failed (${response.status})`,
			{
				reason: "upstream_prompt_get_failed",
				promptName: prompt.promptName,
				status: response.status,
				upstreamCode: json?.error?.code,
			},
		);
	}
	return json.result as GetPromptResult;
}

function registerCatalogMcpPrompts(agent: ServerContext): void {
	for (const prompt of agent.catalogPrompts) {
		const argsSchema = promptArgumentSchema(prompt.arguments);
		const registered = agent.server.registerPrompt(
			prompt.promptName,
			{
				title: prompt.title ?? undefined,
				description: prompt.description ?? undefined,
				argsSchema: z.object(argsSchema),
				icons: prompt.icons ?? undefined,
				_meta: prompt.meta ?? undefined,
			},
			(args) =>
				getUpstreamCatalogPrompt(
					agent,
					prompt,
					(args ?? {}) as Record<string, string>,
				),
		);
		agent.registeredPrompts.set(prompt.promptName, registered);
	}
}

/**
 * Register MCP resource templates for live tedi/app/tool data.
 *
 * Templates use URI patterns with variables resolved at read time:
 * - `tedi://{tediSlug}/status` → calls `get_tedi_status`
 * - `app://{appSlug}/health` → calls `get_app_health`
 * - `tool://{toolId}/schema` → returns D1 tool input/output schema
 */
export function registerResourceTemplates(agent: ServerContext): void {
	registerCatalogMcpResources(agent);
	registerCatalogMcpPrompts(agent);

	agent.server.registerResource(
		"tedi-status",
		new ResourceTemplate("tedi://{tediSlug}/status", { list: undefined }),
		{ description: "Live tedi runtime status. URI: tedi://{tediSlug}/status" },
		async (uri, variables) => {
			const tediSlug = String(variables.tediSlug ?? "");
			try {
				const { tool, result } = await executeJsonResourceTool(
					agent,
					"get_tedi_status",
					{ slug: tediSlug },
				);
				if (!tool) {
					return jsonContent(uri, {
						error: "get_tedi_status tool not available",
						slug: tediSlug,
					});
				}
				return {
					contents: [
						{ uri: uri.toString(), mimeType: "application/json", text: result },
					],
				};
			} catch (error) {
				return jsonContent(uri, {
					error: error instanceof Error ? error.message : String(error),
					slug: tediSlug,
				});
			}
		},
	);

	agent.server.registerResource(
		"app-health",
		new ResourceTemplate("app://{appSlug}/health", { list: undefined }),
		{ description: "App health and status. URI: app://{appSlug}/health" },
		async (uri, variables) => {
			const appSlug = String(variables.appSlug ?? "");
			try {
				const { tool, result } = await executeJsonResourceTool(
					agent,
					"get_app_health",
					{ slug: appSlug },
				);
				if (!tool) {
					const isCurrentApp = appSlug === agent.appSlug;
					return jsonContent(
						uri,
						isCurrentApp
							? {
									slug: agent.appSlug,
									name: agent.app.name,
									toolCount: agent.loadedTools.size,
									status: "running",
								}
							: { error: "get_app_health tool not available", slug: appSlug },
					);
				}
				return {
					contents: [
						{ uri: uri.toString(), mimeType: "application/json", text: result },
					],
				};
			} catch (error) {
				return jsonContent(uri, {
					error: error instanceof Error ? error.message : String(error),
					slug: appSlug,
				});
			}
		},
	);

	agent.server.registerResource(
		"tool-schema",
		new ResourceTemplate("tool://{toolId}/schema", { list: undefined }),
		{
			description:
				"Tool input/output schema from D1. URI: tool://{toolId}/schema",
		},
		async (uri, variables) => {
			const toolId = String(variables.toolId ?? "");
			const tool = agent.loadedTools.get(toolId);
			if (!tool) {
				return jsonContent(uri, {
					error: `Tool not found: ${toolId}`,
					availableTools: Array.from(agent.loadedTools.keys()),
				});
			}

			return jsonContent(
				uri,
				{
					toolId: tool.toolId,
					title: tool.title,
					description: tool.description,
					toolTypeId: tool.toolTypeId,
					inputSchema: tool.inputSchema,
					outputSchema: tool.outputSchema,
					annotations: tool.annotations,
				},
				true,
			);
		},
	);

	agent.server.registerResource(
		"generated-mcp-app-widget",
		new ResourceTemplate(GENERATED_MCP_APP_WIDGET_TEMPLATE, {
			list: undefined,
		}),
		{
			description:
				"Generated MCP-App widget shell. URI: ui://widgets/mcp-app/{appSlug}/r/{layoutId}.html",
		},
		async (uri, variables) => {
			const appSlug = resourceVariable(variables.appSlug);
			const widgetPath = resourceVariable(variables.widgetPath);
			const route = normalizeGeneratedWidgetRoute(widgetPath);
			if (!isAppSlug(appSlug) || !route) {
				resourceNotFound(uri, {
					resourceType: "mcp-app",
					expectedTemplate: "ui://widgets/mcp-app/{appSlug}/r/{layoutId}.html",
				});
			}

			trackResourceRead(agent, {
				resourceUri: uri.toString(),
				resourceType: "mcp-app",
				sourceAppSlug: appSlug,
				widgetKey: route,
			});
			const matchingTool = resolveGeneratedWidgetTool(agent, appSlug, route);

			// Bundle-tier widget: the tool carries a committed self-contained HTML
			// document. Serve it verbatim under the same CSP envelope instead of
			// the json-render shell; the host injects execution data through the
			// existing tedix-tool-data seam exactly as for generated widgets.
			const bundleHtml = matchingTool ? getToolBundleHtml(matchingTool) : null;
			if (bundleHtml) {
				const bundleCsp = await agent.buildAppCsp();
				return {
					contents: [
						{
							uri: uri.toString(),
							mimeType: "text/html;profile=mcp-app",
							text: bundleHtml,
							_meta: buildMcpAppResourceMeta(
								matchingTool ?? null,
								bundleCsp,
								agent.getWidgetDomain(),
								{ prefersBorder: false },
							),
						},
					],
				};
			}

			const layoutSpec = matchingTool ? getToolLayoutSpec(matchingTool) : null;
			const extraHeaders = layoutSpec
				? { "X-Tedix-Layout-Spec": JSON.stringify(layoutSpec) }
				: undefined;

			const [html, csp] = await Promise.all([
				agent.fetchWidgetHtmlForAppSlug(
					appSlug,
					route,
					"Generated MCP-App widget",
					"mcp-app",
					extraHeaders,
				),
				agent.buildAppCsp(),
			]);
			const unavailableReason = generatedWidgetUnavailableReason(html);
			if (!html.trim() || unavailableReason) {
				if (
					!unavailableReason ||
					isWidgetResourceNotFoundReason(unavailableReason)
				) {
					resourceNotFound(uri, {
						resourceType: "mcp-app",
						sourceAppSlug: appSlug,
						widgetRoute: route,
					});
				}
				throw new ProtocolError(
					ProtocolErrorCode.InternalError,
					`Resource ${uri.toString()} unavailable: ${unavailableReason}`,
					{
						reason: "resource_unavailable",
						resourceUri: uri.toString(),
						resourceType: "mcp-app",
						sourceAppSlug: appSlug,
						widgetRoute: route,
					},
				);
			}
			const widgetDomain = agent.getWidgetDomain();

			return {
				contents: [
					{
						uri: uri.toString(),
						mimeType: "text/html;profile=mcp-app",
						text: html,
						_meta: buildMcpAppResourceMeta(
							matchingTool ?? null,
							csp,
							widgetDomain,
							{ prefersBorder: false },
						),
					},
				],
			};
		},
	);

	console.log(
		"[MCP] Registered 4 resource templates: tedi-status, app-health, tool-schema, generated-mcp-app-widget",
	);
}
