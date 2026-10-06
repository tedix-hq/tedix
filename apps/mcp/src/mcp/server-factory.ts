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
 * Stateless MCP Server Factory
 *
 * Builds a new McpServer per request from cached app/tool data.
 * Worker-level Map caches D1 data (60s TTL). Server instances are not
 * cached — the MCP SDK transport owns per-request connection state and guards
 * against reusing a connected server instance.
 *
 * Tool handler closures capture per-request ServerContext (fresh callerIdentity).
 *
 * @module @tedix/mcp/mcp/server-factory
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type {
	AppCapabilities,
	AppMetadata,
} from "@tedix/api-contract/schemas/app";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { mapAppBrandingToProfile } from "@tedix/api-contract/schemas/widget-theme";
import { createMcpServer } from "@tedix/mcp-shared/server";
import type { McpResultCacheHint } from "@tedix/mcp-shared/transport";
import { createMcpLogger } from "../log";
import { type ApiClient, getApiClient } from "../lib/api-client";
import { setBoundedCacheEntry } from "../lib/bounded-cache";
import { joinInFlightLoad } from "../lib/step-budget";
import { withUpstreamRetry } from "../upstream";
import {
	type CallerAuthType,
	shouldBypassCodeModeForCaller,
} from "./caller-identity";
import { ToolHandler } from "./handler";
import { registerResourceTemplates } from "./registration/resource-templates";
import type {
	AppTool,
	CallerIdentity,
	CatalogMcpMetadata,
	CatalogMcpResource,
	CatalogMcpResourceTemplate,
	CatalogMcpPrompt,
	ServerContext,
} from "./server-context";
import {
	getCachedSkillSummaries,
	getCachedSkillSummariesForApps,
	mapWithConcurrency,
} from "./skill-cache";
import {
	enrichToolsWithSkills,
	registerAppPrompts,
	registerAppSkills,
	registerAppTools,
	registerBootstrapResources,
	registerBootstrapTools,
	registerDynamicTool,
	registerGenUiAuthoringTools,
} from "./tool-registration";
import type { McpApp, OpenAiWidgetCSP } from "./types";
import { registerAccountProfile } from "./registration/account-profile";
import { buildCallerTelemetryFields, trackMcpEvent } from "./utils/analytics";
import {
	buildWidgetThemePayload,
	createWidgetCSP,
	getAppsSDKCompatibleHtml,
} from "./utils/widget";

/** Catalog rows need their own configured capability, never a wildcard/namespace fallback. */
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

const log = createMcpLogger("mcp.server_factory");

// =============================================================================
// CONSTANTS
// =============================================================================

/**
 * The session Code Mode lane's native (non-Code-Mode) tool surface: `code`
 * plus exactly these home-surface tool ids. The stateless fast path
 * (`compactCodeModeTools` in index.ts) instead advertises `code` + `get_info`
 * — deliberately no `ask`, because `ask` creates a durable Home turn and
 * requires an authenticated org context the stateless lane does not resolve.
 * The outer-surface lane conformance test pins both lists to this decision.
 */
export const SESSION_NATIVE_HOME_TOOL_IDS = ["ask"] as const;

const DEFAULT_APP_CAPABILITIES: AppCapabilities = {
	checkout: { enabled: false },
	cart: { enabled: false },
	wishlist: { enabled: false },
	compare: { enabled: false },
	map: { enabled: false },
	externalCta: { enabled: true },
};

/** Max size for server instructions to prevent unbounded growth */
const MAX_INSTRUCTIONS_CHARS = 8_000;
/** Max skills to include in instruction catalog */
const MAX_SKILL_SUMMARIES = 50;

// =============================================================================
// DATA CACHE — Worker-level, shared across requests in same isolate
// =============================================================================

export interface CachedAppData {
	app: McpApp;
	tools: AppTool[];
	catalogMcp?: CatalogMcpMetadata | null;
	catalogResources?: CatalogMcpResource[];
	catalogResourceTemplates?: CatalogMcpResourceTemplate[];
	catalogPrompts?: CatalogMcpPrompt[];
	metadata: AppMetadata | null;
	capabilities: AppCapabilities;
	organizationId: string | undefined;
	expiresAt: number;
}

const appContextCache = new Map<string, CachedAppData>();
const appContextInFlight = new Map<string, Promise<CachedAppData>>();
const CACHE_TTL_MS = 60_000;
const MAX_APP_CONTEXT_CACHE_ENTRIES = 500;
const MAX_INSTRUCTIONS_CACHE_ENTRIES = 500;

/**
 * SEP-2549 CacheableResult freshness hints for the list surfaces this edge
 * serves (`tools/list`, `prompts/list`, `resources/list`,
 * `resources/templates/list`).
 *
 * `listTtlMs` mirrors the cache actually backing the mount: plain per-app
 * servers rebuild from the 60s D1 app-data cache in this file
 * (`CACHE_TTL_MS`, the default); aggregate surfaces pass their own
 * `AGGREGATE_SURFACE_CACHE_TTL_MS` (120s L1 surface cache in index.ts) so
 * clients key freshness off the protocol hint instead of timers.
 *
 * `cacheScope` is `"private"`: every list is org/app-scoped D1 data, and
 * `tools/list` is additionally caller-filtered (`isMcpToolVisibleToCaller`),
 * so a shared cache must never serve these results across users.
 * Prompt/resource catalogs are fixed in each stateless server snapshot; the
 * edge refreshes them from D1 on the cache TTL and does not advertise
 * listChanged notifications it cannot deliver to an already-ended request.
 *
 * `resources/read` keeps the transport's per-method default; per-result
 * overrides (skill index, static ui:// templates) ride the
 * `MCP_RESULT_CACHE_HINT_META_KEY` marker instead.
 */
export function buildEdgeListCacheHints(
	listTtlMs: number = CACHE_TTL_MS,
): Record<string, McpResultCacheHint> {
	const hint: McpResultCacheHint = { ttlMs: listTtlMs, cacheScope: "private" };
	return {
		"tools/list": hint,
		"prompts/list": hint,
		"resources/list": hint,
		"resources/templates/list": hint,
		// SEP-2640: skills/list carries the base protocol's list-caching
		// attributes on 2026-07-28, same semantics as the other list surfaces.
		"skills/list": hint,
	};
}

export interface AppContextPreload {
	app: {
		id: string;
		organizationId?: string;
		name: string;
		slug: string;
		domain?: string | null;
		primaryDomain?: string | null;
		description?: string | null;
		logoUrl?: string | null;
		customMcpDomain?: string | null;
		openaiChallengeToken?: string | null;
		openaiAppId?: string | null;
		appStoreStatus?: string | null;
		visibility?: "public" | "private" | "disabled" | null;
		discoveryStatus?: string | null;
		metadata?: AppMetadata | null;
	};
	metadata?: AppMetadata | null;
	tools: AppTool[];
	catalogMcp?: CatalogMcpMetadata | null;
	catalogResources?: CatalogMcpResource[];
	catalogResourceTemplates?: CatalogMcpResourceTemplate[];
	catalogPrompts?: CatalogMcpPrompt[];
}

function buildCachedAppData(
	source: AppContextPreload,
	expiresAt: number,
): CachedAppData {
	const metadata = source.metadata ?? source.app.metadata ?? null;
	const capabilities: AppCapabilities = {
		...DEFAULT_APP_CAPABILITIES,
		...metadata?.capabilities,
	};

	return {
		app: {
			id: source.app.id,
			organizationId: source.app.organizationId,
			name: source.app.name,
			slug: source.app.slug,
			domain: source.app.primaryDomain ?? source.app.domain ?? null,
			description: source.app.description ?? null,
			logoUrl: source.app.logoUrl ?? null,
			customMcpDomain: source.app.customMcpDomain ?? null,
			openaiChallengeToken: source.app.openaiChallengeToken ?? null,
			openaiAppId: source.app.openaiAppId ?? null,
			appStoreStatus: source.app.appStoreStatus ?? null,
			visibility: source.app.visibility ?? undefined,
			discoveryStatus: source.app.discoveryStatus ?? undefined,
		},
		tools: source.tools,
		catalogMcp: source.catalogMcp ?? null,
		catalogResources: source.catalogResources ?? [],
		catalogResourceTemplates: source.catalogResourceTemplates ?? [],
		catalogPrompts: source.catalogPrompts ?? [],
		metadata,
		capabilities,
		organizationId: source.app.organizationId,
		expiresAt,
	};
}

function cacheAppContext(entry: CachedAppData): CachedAppData {
	setBoundedCacheEntry(
		appContextCache,
		entry.app.id,
		entry,
		MAX_APP_CONTEXT_CACHE_ENTRIES,
	);
	return entry;
}

// =============================================================================
// INSTRUCTIONS CACHE — Worker-level, keyed by appId
// Avoids a live cognitive.skills.listByApp call on every MCP server build.
// =============================================================================

interface CachedInstructions {
	instructions: string | undefined;
	cachedAt: number;
}

const instructionsCache = new Map<string, CachedInstructions>();

function cacheInstructions(key: string, value: CachedInstructions): void {
	setBoundedCacheEntry(
		instructionsCache,
		key,
		value,
		MAX_INSTRUCTIONS_CACHE_ENTRIES,
	);
}

// =============================================================================
// TOOL HANDLER SINGLETON — ToolHandler is stateless; reuse across requests
// =============================================================================

const sharedToolHandler = new ToolHandler();

/**
 * Get app context from cache or fetch from API.
 * Cache miss: 1 D1 query via API_SERVICE binding (~5ms).
 */
export async function getAppContext(
	appId: string,
	appSlug: string,
	env: CloudflareEnv,
	preload?: AppContextPreload,
): Promise<CachedAppData> {
	const cached = appContextCache.get(appId);
	if (cached && cached.expiresAt > Date.now()) return cached;

	if (preload?.app.id === appId) {
		return cacheAppContext(
			buildCachedAppData(preload, Date.now() + CACHE_TTL_MS),
		);
	}

	const inFlight = appContextInFlight.get(appId);
	if (inFlight)
		return joinInFlightLoad(appContextInFlight, appId, inFlight, {
			step: "app_context_join",
			budgetMs: 30_000,
			resource: appSlug,
		});

	const client = getApiClient({
		serviceFetch: env.API_SERVICE,
	});

	// Bounded retry inside the shared in-flight resolver (same rationale as
	// resolveAppFromHostname): absorbs a warming/transiently-dropped apps/api.
	// `App not found` is a plain Error (not 5xx / network-lost) so it is never
	// retried.
	const resolver = withUpstreamRetry(
		async () => {
			const result = await client.apps.getBySlugWithTools({ slug: appSlug });

			if (!result?.app) {
				throw new Error(`App not found: ${appSlug}`);
			}

			return buildCachedAppData(
				{
					app: result.app,
					metadata: result.app.metadata as AppMetadata | null,
					tools: result.tools,
					catalogMcp: result.catalogMcp ?? null,
					catalogResources: result.catalogResources ?? [],
					catalogResourceTemplates: result.catalogResourceTemplates ?? [],
					catalogPrompts: result.catalogPrompts ?? [],
				},
				Date.now() + CACHE_TTL_MS,
			);
		},
		{ operation: "load_app_context", resource: appSlug },
	).then(cacheAppContext);

	appContextInFlight.set(appId, resolver);
	try {
		return await joinInFlightLoad(appContextInFlight, appId, resolver, {
			step: "app_context_join",
			budgetMs: 30_000,
			resource: appSlug,
		});
	} finally {
		if (appContextInFlight.get(appId) === resolver)
			appContextInFlight.delete(appId);
	}
}

// =============================================================================
// CALLER IDENTITY — extracted from request headers (set by edge auth)
// =============================================================================

export function extractCallerIdentity(
	request: Request,
): CallerIdentity | undefined {
	const authType = request.headers.get("x-tedix-auth-type");
	if (!authType) return undefined;
	const trustedWorkflowHeaders = authType === "service";
	const parsePositiveIntegerHeader = (name: string): number | undefined => {
		const raw = request.headers.get(name);
		if (!raw || !/^[1-9]\d{0,14}$/.test(raw)) return undefined;
		const value = Number(raw);
		return Number.isSafeInteger(value) && value > 0 ? value : undefined;
	};
	const parseNonNegativeIntegerHeader = (name: string): number | undefined => {
		const raw = request.headers.get(name);
		if (!raw || !/^(?:0|[1-9]\d{0,14})$/.test(raw)) return undefined;
		const value = Number(raw);
		return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
	};
	const tokenHeader = (name: string): string | undefined => {
		const raw = request.headers.get(name);
		return raw && raw.length <= 200 && /^[A-Za-z0-9._:-]+$/.test(raw)
			? raw
			: undefined;
	};
	const decodeHeader = (name: string): string | undefined => {
		const raw = request.headers.get(name);
		if (!raw || raw.length > 2_048) return undefined;
		try {
			const value = decodeURIComponent(raw);
			const hasControlCharacter = [...value].some((character) => {
				const code = character.charCodeAt(0);
				return code <= 31 || code === 127;
			});
			return value.length <= 512 && !hasControlCharacter ? value : undefined;
		} catch {
			return undefined;
		}
	};
	return {
		authType: authType as CallerAuthType,
		userId: request.headers.get("x-tedix-auth-user-id") ?? undefined,
		organizationId: request.headers.get("x-tedix-auth-org-id") ?? undefined,
		email: request.headers.get("x-tedix-auth-email") ?? undefined,
		tediId: request.headers.get("x-tedix-auth-tedi-id") ?? undefined,
		externalAgentPrincipalId:
			request.headers.get("x-tedix-auth-external-principal-id") ?? undefined,
		externalAgentSessionId:
			request.headers.get("x-tedix-auth-external-session-id") ?? undefined,
		externalAgentClientRecordId:
			request.headers.get("x-tedix-auth-external-client-record-id") ??
			undefined,
		externalAgentHarness:
			request.headers.get("x-tedix-auth-external-harness") ?? undefined,
		externalAgentModel:
			request.headers.get("x-tedix-auth-external-model") ?? undefined,
		clientId: request.headers.get("x-tedix-auth-client-id") ?? undefined,
		credentialMode:
			request.headers.get("x-tedix-auth-credential-mode") ?? undefined,
		scopes: (request.headers.get("x-tedix-auth-scopes") ?? "")
			.split(" ")
			.filter(Boolean),
		// Skill workflow run identity (set by skill-runtime; preserved through
		// the service-binding header rewrite in apps/mcp/src/index.ts).
		skillRunId: trustedWorkflowHeaders
			? tokenHeader("x-tedix-skill-run-id")
			: undefined,
		// Run-starter identity for operator-consent attestation. Set by the skill-runtime bridge from the run row's
		// createdBy; trusted for the same reason skillRunId is — these headers
		// only exist on the service-binding hop.
		skillRunCreatedBy: trustedWorkflowHeaders
			? tokenHeader("x-tedix-run-created-by")
			: undefined,
		skillId: trustedWorkflowHeaders
			? tokenHeader("x-tedix-skill-id")
			: undefined,
		workflowStepId: trustedWorkflowHeaders
			? tokenHeader("x-tedix-workflow-step-id")
			: undefined,
		workflowStepName: trustedWorkflowHeaders
			? decodeHeader("x-tedix-workflow-step-name")
			: undefined,
		workflowStepCount: trustedWorkflowHeaders
			? parsePositiveIntegerHeader("x-tedix-workflow-step-count")
			: undefined,
		workflowStepAttempt: trustedWorkflowHeaders
			? parsePositiveIntegerHeader("x-tedix-workflow-step-attempt")
			: undefined,
		workflowExecutionEpoch: trustedWorkflowHeaders
			? parseNonNegativeIntegerHeader("x-tedix-workflow-execution-epoch")
			: undefined,
		workflowCallId: trustedWorkflowHeaders
			? tokenHeader("x-tedix-workflow-call-id")
			: undefined,
		workflowIdempotencyKey: trustedWorkflowHeaders
			? tokenHeader("x-tedix-workflow-idempotency-key")
			: undefined,
		forceCodeMode:
			request.headers.get("x-tedix-code-mode")?.toLowerCase() === "force",
		// Tenant control-plane marker (kernel). Only the post-auth
		// service-binding rewrite in index.ts can set this header (the
		// x-tedix-auth-* namespace is stripped from all incoming MCP requests).
		kernel: request.headers.get("x-tedix-auth-kernel") === "true" || undefined,
	};
}

// =============================================================================
// CSP BUILDING
// =============================================================================

function toWss(url: string): string {
	return url.replace(/^https:/, "wss:");
}

function buildCoreCspDomains(env: {
	MCP_UI_URL: string;
	MCP_URL: string;
	API_URL: string;
	ENVIRONMENT?: string;
}): { connectDomains: string[]; resourceDomains: string[] } {
	const isProd = env.ENVIRONMENT === "production";
	const allowDomain = (url: string) => !isProd || url.includes("tedix.dev");

	const widgetUrl = allowDomain(env.MCP_UI_URL) ? env.MCP_UI_URL : "";
	const mcpUrl = allowDomain(env.MCP_URL) ? env.MCP_URL : "";
	const apiUrl = allowDomain(env.API_URL) ? env.API_URL : "";

	if (isProd && (!widgetUrl || !mcpUrl || !apiUrl)) {
		console.warn(
			"[MCP] Core CSP domains filtered in production. Check MCP_UI_URL/MCP_URL/API_URL envs.",
		);
	}

	return {
		connectDomains: [
			widgetUrl,
			widgetUrl ? toWss(widgetUrl) : "",
			mcpUrl,
			mcpUrl ? toWss(mcpUrl) : "",
			apiUrl,
		].filter((domain): domain is string => Boolean(domain)),
		resourceDomains: [widgetUrl].filter((domain): domain is string =>
			Boolean(domain),
		),
	};
}

async function buildCspForApp(
	cachedData: CachedAppData,
	tool: AppTool | undefined,
	env: CloudflareEnv,
): Promise<OpenAiWidgetCSP> {
	const coreCsp = buildCoreCspDomains(env);

	if (!cachedData.app.id) {
		return createWidgetCSP({
			connect_domains: coreCsp.connectDomains,
			resource_domains: coreCsp.resourceDomains,
		});
	}

	const connectDomains: string[] = [...coreCsp.connectDomains];
	const resourceDomains: string[] = [...coreCsp.resourceDomains];
	const frameDomains: string[] = [];
	const redirectDomains: string[] = [];

	const applyDomains = (
		domains: { domainType: string; domainUrl: string }[],
	) => {
		for (const domain of domains) {
			switch (domain.domainType) {
				case "connect":
					connectDomains.push(domain.domainUrl);
					break;
				case "frame":
					frameDomains.push(domain.domainUrl);
					break;
				case "redirect":
					redirectDomains.push(domain.domainUrl);
					break;
				case "resource":
					resourceDomains.push(domain.domainUrl);
					break;
				default:
					resourceDomains.push(domain.domainUrl);
					break;
			}
		}
	};

	// Source 1: mcpConfig.widgetCSP (inline config, always available)
	const widgetCSP = cachedData.metadata?.mcpConfig?.widgetCSP as
		| {
				connect_domains?: string[];
				resource_domains?: string[];
				frame_domains?: string[];
				redirect_domains?: string[];
		  }
		| undefined;
	if (widgetCSP) {
		connectDomains.push(...(widgetCSP.connect_domains ?? []));
		resourceDomains.push(...(widgetCSP.resource_domains ?? []));
		frameDomains.push(...(widgetCSP.frame_domains ?? []));
		redirectDomains.push(...(widgetCSP.redirect_domains ?? []));
	}

	// Source 2: Per-tool CSP domains (from app_tool_csp_domains)
	if (tool?.toolCspDomains?.length) {
		const toolDomains = tool.toolCspDomains
			.filter((d) => d.active !== false)
			.map((domain) => ({
				domainType: domain.domainType,
				domainUrl: domain.domainUrl,
			}));
		applyDomains(toolDomains);
	}

	return createWidgetCSP({
		connect_domains: [...new Set(connectDomains)],
		resource_domains: [...new Set(resourceDomains)],
		...(frameDomains.length > 0 && {
			frame_domains: [...new Set(frameDomains)],
		}),
		...(redirectDomains.length > 0 && {
			redirect_domains: [...new Set(redirectDomains)],
		}),
	});
}

// =============================================================================
// WIDGET HTML
// =============================================================================

export function buildThemePayload(cachedData: CachedAppData) {
	const branding = mapAppBrandingToProfile(cachedData.metadata?.branding);
	return buildWidgetThemePayload(
		{
			id: cachedData.app.id,
			slug: cachedData.app.slug,
			name: cachedData.app.name,
		},
		branding,
		cachedData.metadata?.widgetConfig as Record<string, JsonValue> | undefined,
	);
}

function humanizeSlug(slug: string): string {
	return slug
		.split(/[-_]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export async function fetchWidgetHtmlForApp(
	cachedData: CachedAppData,
	route: string,
	_description: string,
	_hostType: "apps-sdk" | "mcp-app",
	env: CloudflareEnv,
	extraHeaders?: Record<string, string>,
	appSlug = cachedData.app.slug,
): Promise<string> {
	const widgetUrl = env.MCP_UI_URL;
	const fullRoute = `/${appSlug}${route}`;
	const isCurrentApp = appSlug === cachedData.app.slug;
	const theme = isCurrentApp
		? buildThemePayload(cachedData)
		: buildWidgetThemePayload(
				{ id: appSlug, slug: appSlug, name: humanizeSlug(appSlug) },
				mapAppBrandingToProfile(undefined),
			);

	try {
		const html = await getAppsSDKCompatibleHtml(widgetUrl, fullRoute, {
			theme,
			extraHeaders,
		});
		return html;
	} catch (error) {
		log.error("Failed to fetch widget", {
			event: "server_factory.widget_fetch_failed",
			appId: cachedData.app.id,
			appSlug,
			outcome: "unavailable",
			error,
		});
		return `<!DOCTYPE html>
<html><head><title>Error</title></head>
<body style="font-family: sans-serif; padding: 1rem;">
<h1>Widget Unavailable</h1>
<p>Failed to load widget from ${widgetUrl}${fullRoute}</p>
<p style="color: #666;">${error instanceof Error ? error.message : "Unknown error"}</p>
</body></html>`;
	}
}

// =============================================================================
// SERVER CONTEXT BUILDER — per-request, fresh identity
// =============================================================================

/**
 * Build a per-request ServerContext. Tool handler closures close over this.
 * CRITICAL: This must be called per-request, not cached.
 */
export function buildServerContext(
	server: McpServer,
	cachedData: CachedAppData,
	callerIdentity: CallerIdentity | undefined,
	env: CloudflareEnv,
	execCtx: ExecutionContext,
	connectionLabel?: string,
	traceId?: string,
	tracestate?: string,
	upstreamAppId?: string,
	bearerToken?: string,
	requestMeta?: Record<string, unknown>,
	requestedCodeModeNamespaces?: ReadonlySet<string> | null,
): ServerContext {
	const apiClient = getApiClient({
		serviceFetch: env.API_SERVICE,
		orgId: cachedData.organizationId,
	});

	const toolHandler = sharedToolHandler;

	const context: ServerContext = {
		catalogTransport: async (config, input) => {
			const { executeCatalogOperation } = await import("./codemode");
			return executeCatalogOperation(context, config, input);
		},
		server,
		env,
		ctx: execCtx,
		appId: cachedData.app.id,
		appSlug: cachedData.app.slug,
		app: cachedData.app,
		appMetadata: cachedData.metadata,
		appCapabilities: cachedData.capabilities,
		apiClient,
		toolHandler,
		callerIdentity,
		traceId: traceId || crypto.randomUUID(),
		tracestate,
		requestMeta,
		requestedCodeModeNamespaces: requestedCodeModeNamespaces ?? null,
		connectionLabel,
		upstreamAppId,
		bearerToken,
		registeredTools: new Map(),
		registeredResources: new Map(),
		registeredPrompts: new Map(),
		loadedTools: new Map(),
		catalogResources: [...(cachedData.catalogResources ?? [])],
		catalogResourceTemplates: [...(cachedData.catalogResourceTemplates ?? [])],
		catalogPrompts: [...(cachedData.catalogPrompts ?? [])],
		appToolIds: new Set(),
		appResourceIds: new Set(),
		authRequiredTools: new Set(),
		toolOutputTemplates: new Map(),
		toolSkillMap: new Map(),
		getServerVersion: () =>
			cachedData.metadata?.mcpConfig?.serverVersion ?? "1.0.0",
		getWidgetDomain: () =>
			cachedData.metadata?.mcpConfig?.widgetDomain ?? env.MCP_UI_URL,
		buildAppCsp: (tool) => buildCspForApp(cachedData, tool, env),
		fetchWidgetHtml: (route, description, hostType, extraHeaders) =>
			fetchWidgetHtmlForApp(
				cachedData,
				route,
				description,
				hostType,
				env,
				extraHeaders,
			),
		fetchWidgetHtmlForAppSlug: (
			appSlug,
			route,
			description,
			hostType,
			extraHeaders,
		) =>
			fetchWidgetHtmlForApp(
				cachedData,
				route,
				description,
				hostType,
				env,
				extraHeaders,
				appSlug,
			),
	};
	return context;
}

// =============================================================================
// MCP SERVER BUILDER — new per request
// =============================================================================

/**
 * Build server instructions from config + skill catalog.
 * Results are cached per (org, app, tedi) for CACHE_TTL_MS (60s) to avoid a
 * live API call on every MCP initialize handshake. The org must be in the key:
 * skill lookups are org-scoped and shared base apps serve many orgs, so an
 * appId-only key would leak one org's skill names into another org's
 * server instructions.
 */
async function buildServerInstructions(
	cachedData: CachedAppData,
	apiClient: ApiClient,
	callerIdentity: CallerIdentity | undefined,
	upstreamAppId?: string,
): Promise<string | undefined> {
	const appId = cachedData.app.id;
	const orgId = cachedData.organizationId;
	const instructionsCacheKey = `${orgId ?? "no-org"}:${appId}:${callerIdentity?.tediId ?? ""}`;

	// Cache hit — return early without any API call
	const cached = instructionsCache.get(instructionsCacheKey);
	if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
		return cached.instructions;
	}

	const mcpConfig = cachedData.metadata?.mcpConfig;
	const parts: string[] = [];

	if (mcpConfig?.serverInstructions) {
		parts.push(mcpConfig.serverInstructions);
	}

	const autoAppend = mcpConfig?.autoAppendSkillInstructions !== false;
	if (autoAppend && appId) {
		try {
			let summaries = await getCachedSkillSummaries({
				apiClient,
				appId,
				orgId,
				tediId: callerIdentity?.tediId,
				limit: MAX_SKILL_SUMMARIES,
			});

			// Skill inheritance: fall back to reference app's skills
			if (summaries.length === 0 && upstreamAppId) {
				summaries = await getCachedSkillSummaries({
					apiClient,
					appId: upstreamAppId,
					orgId,
					tediId: callerIdentity?.tediId,
					limit: MAX_SKILL_SUMMARIES,
				});
			}

			if (summaries.length > 0) {
				const names = summaries
					.map((s) => s.slug ?? s.title ?? s.id)
					.join(", ");
				parts.push(
					`## Skills\n\nThis server has ${summaries.length} skill(s). Use \`list_skills\` to discover available skills and \`read_skill\` to load full procedures.\nSkills are also available as \`skill://{name}/SKILL.md\` resources via \`resources/read\`.\n\nAvailable: ${names}`,
				);
			}

			// Aggregated app skill discovery — lightweight hint for cross-app skill awareness.
			// Collects unique _sourceAppId values from tools and checks each for skills.
			// Only emits a one-liner so bootstrap awareness doesn't become a context bomb.
			const sourceAppIds = new Set<string>();
			for (const tool of cachedData.tools) {
				const config = tool.config as Record<string, unknown> | null;
				const sourceAppId = config?._sourceAppId as string | undefined;
				if (sourceAppId && sourceAppId !== appId) {
					sourceAppIds.add(sourceAppId);
				}
			}

			if (sourceAppIds.size > 0) {
				// One batched call, not one per app. A cold apps/api invocation costs
				// seconds of CPU because the `worker-app` graph is evaluated per
				// isolate, so a per-app fan-out meant one cold isolate per app per
				// rebuild; batching collapses that to one.
				const summariesByApp = await getCachedSkillSummariesForApps({
					apiClient,
					appIds: Array.from(sourceAppIds),
					orgId,
					tediId: callerIdentity?.tediId,
					limit: MAX_SKILL_SUMMARIES,
				});
				const appSkillCounts = Array.from(sourceAppIds).map((srcAppId) => {
					const count = (summariesByApp.get(srcAppId) ?? []).length;
					if (count === 0) return null;
					// Find a representative tool name for this source app
					const sampleTool = cachedData.tools.find(
						(t) =>
							(t.config as Record<string, unknown> | null)?._sourceAppId ===
							srcAppId,
					);
					const prefix =
						sampleTool?.toolId?.split("__")[0] ?? srcAppId.slice(0, 8);
					return { prefix, count };
				});

				const withSkills = appSkillCounts.filter(
					(x): x is { prefix: string; count: number } => x !== null,
				);
				if (withSkills.length > 0) {
					const appList = withSkills
						.map((a) => `${a.prefix} (${a.count})`)
						.join(", ");
					parts.push(
						`Aggregated apps with skills: ${appList}. Tool descriptions include \`📋 Skills\` pointers — use \`read_skill({ skillId })\` where available, or \`mcp_read_resource\` for skill:// resources.`,
					);
				}
			}
		} catch (error) {
			console.warn(
				"[MCP] Failed to load skill summaries for instructions:",
				error instanceof Error ? error.message : error,
			);
		}
	}

	const instructions = (() => {
		if (parts.length === 0) return undefined;
		let text = parts.join("\n\n");
		if (text.length > MAX_INSTRUCTIONS_CHARS) {
			text = `${text.slice(0, MAX_INSTRUCTIONS_CHARS - 100)}\n\n... (truncated — use \`list_skills\` for full catalog)`;
			console.warn(
				`[MCP] Server instructions truncated to ${MAX_INSTRUCTIONS_CHARS} chars`,
			);
		}
		return text;
	})();

	cacheInstructions(instructionsCacheKey, {
		instructions,
		cachedAt: Date.now(),
	});
	return instructions;
}

/**
 * Build a fully configured McpServer from cached data.
 * Registers all tools, resources, and skills.
 * Returns the server ready for mountMcp() (@tedix/mcp-shared/transport).
 */
export async function buildMcpServer(
	cachedData: CachedAppData,
	callerIdentity: CallerIdentity | undefined,
	env: CloudflareEnv,
	execCtx: ExecutionContext,
	connectionLabel?: string,
	traceId?: string,
	tracestate?: string,
	upstreamAppId?: string,
	bearerToken?: string,
	requestedToolName?: string,
	requestMeta?: Record<string, unknown>,
	requestedCodeModeNamespaces?: ReadonlySet<string> | null,
): Promise<McpServer> {
	const startTime = Date.now();

	// Create org-scoped API client for skill fetching
	const orgApiClient = getApiClient({
		serviceFetch: env.API_SERVICE,
		orgId: cachedData.organizationId,
	});

	const serverName =
		cachedData.metadata?.mcpConfig?.serverName ?? `${cachedData.app.name} MCP`;
	const serverVersion =
		cachedData.metadata?.mcpConfig?.serverVersion ?? "1.0.0";

	const instructions = await buildServerInstructions(
		cachedData,
		orgApiClient,
		callerIdentity,
		upstreamAppId,
	);

	const server = createMcpServer(
		{ name: serverName, version: serverVersion },
		{
			...(instructions ? { instructions } : {}),
			capabilities: {
				extensions: {
					"io.modelcontextprotocol/apps": {},
					"io.modelcontextprotocol/ui": {},
					// Same declared shape as the modern server/discover path in
					// src/index.ts — the transport serves resources/directory/read on
					// both handshakes, so legacy clients must be told they may call it.
					"io.modelcontextprotocol/skills": { directoryRead: true },
				},
			},
		},
	);

	// Build per-request context — closures capture this, not cached data
	const serverCtx = buildServerContext(
		server,
		cachedData,
		callerIdentity,
		env,
		execCtx,
		connectionLabel,
		traceId,
		tracestate,
		upstreamAppId,
		bearerToken,
		requestMeta,
		requestedCodeModeNamespaces,
	);

	// Pre-populate loadedTools from cached data.
	// When a chatgptToolAllowlist is configured and the caller is unauthenticated
	// (i.e. ChatGPT connecting without OAuth yet), only expose the allowlisted tools.
	// Authenticated callers (tedis, service bindings, OAuth users) always see all tools.
	const chatgptAllowlist = cachedData.metadata?.mcpConfig
		?.chatgptToolAllowlist as string[] | undefined;
	const isUnauthenticated = !callerIdentity;
	const shouldFilter =
		chatgptAllowlist && chatgptAllowlist.length > 0 && isUnauthenticated;
	const allowSet = shouldFilter ? new Set(chatgptAllowlist) : null;

	const codeModeRequested = cachedData.metadata?.mcpConfig?.codeMode === true;
	// Programmatic direct tool calls should not materialize giant aggregate
	// surfaces. They already identify the exact D1 tool they want; Code Mode
	// outer tools and session discovery stay on the compact Code Mode surface.
	const skipCodeMode = shouldBypassCodeModeForCaller(
		callerIdentity,
		requestedToolName,
	);
	const directCatalog =
		skipCodeMode &&
		cachedData.tools.some(
			(tool) =>
				tool.toolId === requestedToolName &&
				isConfiguredCatalogTool(tool, cachedData.metadata?.mcpConfig),
		);
	const directToolAllowSet =
		skipCodeMode && requestedToolName && !directCatalog
			? new Set([requestedToolName])
			: null;

	for (const tool of cachedData.tools) {
		if (
			tool.config?.transport === "catalog" &&
			(!isConfiguredCatalogTool(tool, cachedData.metadata?.mcpConfig) ||
				cachedData.tools.filter((candidate) => candidate.toolId === tool.toolId)
					.length !== 1)
		)
			continue;
		if (allowSet && !allowSet.has(tool.toolId)) continue;
		if (directToolAllowSet && !directToolAllowSet.has(tool.toolId)) continue;
		const requestScopedTool = {
			...tool,
			config:
				tool.config && typeof tool.config === "object"
					? { ...(tool.config as Record<string, JsonValue>) }
					: tool.config,
		};
		serverCtx.loadedTools.set(tool.toolId, requestScopedTool);
	}

	if (allowSet) {
		console.log(
			`[MCP] Filtered to ${serverCtx.loadedTools.size}/${cachedData.tools.length} tools (chatgptToolAllowlist)`,
		);
	}

	// Enrich aggregated tools with skills from their source apps (before Code Mode
	// catalog build, which snapshots descriptions statically)
	await enrichToolsWithSkills(serverCtx);

	// Register tools — Code Mode or standard
	// Programmatic callers get compact Code Mode for discovery and outer Code
	// Mode calls, then typed direct-tool registration only for a named tools/call.
	let codeModeActive = false;

	if (codeModeRequested && !skipCodeMode) {
		// Dynamic import: @cloudflare/codemode depends on zod-to-ts → TypeScript compiler
		// which uses __filename (unavailable in Workers). Only load when actually needed.
		const { registerCodeModeTools } = await import("./codemode");
		codeModeActive = await registerCodeModeTools(server, serverCtx);
	}

	if (codeModeActive) {
		registerAccountProfile(serverCtx);
		// Code Mode is the compact agent surface: `code` for discovery/execution and
		// `ask` for durable Home delegation. Resources and prompts remain protocol
		// capabilities; implementation helpers do not become top-level tools.
		registerBootstrapResources(serverCtx);
		registerResourceTemplates(serverCtx);
		await registerAppSkills(serverCtx);
		await registerAppPrompts(serverCtx);
		for (const tool of serverCtx.loadedTools.values()) {
			if (
				!isConfiguredCatalogTool(tool, cachedData.metadata?.mcpConfig) &&
				((tool.meta as Record<string, unknown> | null | undefined)?.source !==
					"homeSurface" ||
					!SESSION_NATIVE_HOME_TOOL_IDS.includes(
						tool.toolId as (typeof SESSION_NATIVE_HOME_TOOL_IDS)[number],
					))
			)
				continue;
			try {
				await registerDynamicTool(serverCtx, tool);
			} catch (error) {
				log.error("Failed to register home tool", {
					event: "server_factory.home_tool_registration_failed",
					appId: serverCtx.appId,
					toolName: tool.toolId,
					outcome: "unavailable",
					error,
				});
			}
		}
	} else {
		// Standard mode: register all tools individually
		// Internal service callers skip bootstrap tools/resources entirely:
		//   • get_info / __track_widget_analytics are chat-client helpers.
		//   • bootstrap list_skills/read_skill collide with D1 cognitive
		//     app_tools rows of the same name on the tedix admin app.
		// The service caller already knows exactly which D1 tool it wants.
		if (!skipCodeMode) {
			registerBootstrapTools(serverCtx);
			registerBootstrapResources(serverCtx);
		}
		registerResourceTemplates(serverCtx);
		if (directCatalog) {
			const selected = serverCtx.loadedTools.get(requestedToolName!);
			if (selected) await registerDynamicTool(serverCtx, selected);
		} else await registerAppTools(serverCtx);
		// Skill-discovery tools (`list_skills` / `read_skill` registered by
		// registerAppSkills) collide with the cognitive D1 `list_skills`
		// app_tools row on the tedix admin app. For service callers we
		// already have those D1 rows registered above and don't need the
		// chat-client discovery tools, so skip.
		if (!skipCodeMode) {
			await registerAppSkills(serverCtx);
			await registerAppPrompts(serverCtx);
		}
	}

	console.log(
		`[MCP] Built server "${serverName}" v${serverVersion} with ${serverCtx.registeredTools.size} tools in ${Date.now() - startTime}ms`,
	);

	trackMcpEvent(env, {
		timestamp: new Date().toISOString(),
		eventType: "session_init",
		appId: cachedData.app.id,
		appSlug: cachedData.app.slug,
		organizationId: cachedData.organizationId,
		...buildCallerTelemetryFields(callerIdentity),
		traceId: serverCtx.traceId,
		success: true,
		durationMs: Date.now() - startTime,
	});

	return server;
}
