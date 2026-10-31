/**
 * The MCP request path: authenticated `/mcp` requests, primary tedi
 * resolution and aggregate runtime-kind hydration. The Worker entry in
 * index.ts routes to it.
 */
import { createMcpServer } from "@tedix/mcp-shared/server";
import {
	clientSupportsMcpApps,
	LEGACY_APPS_SESSION_PREFIX,
} from "./mcp/client-apps-capability";
import { AGGREGATE_SURFACE_CACHE_TTL_MS } from "./aggregate-surface-cache";
import { aggregateAndPrefixTools } from "./aggregate-surface";
import { AggregateAppEntry } from "./aggregate-types";
import {
	applyHostConnectionDefaultsToAggregateEntries,
	withAggregateHostOrganization,
	withMountToolScopes,
} from "./aggregate-host-defaults";
import {
	directToolCallNamespaces,
	filterAggregateAppsForCodeNamespaces,
	filterAggregateTedisForCodeNamespaces,
} from "./codemode-targeting";
import { mcpToolsListResultTransform } from "./mcp-result-transform";
import { buildBootstrapInfo } from "./mcp/registration/bootstrap";
import { sidebarAppToolMeta } from "./mcp/sidebar-app";
/**
 * Tedix MCP Worker
 * Customer-facing stateless MCP server for Apps SDK integration
 *
 * Architecture: Stateless per-request McpServer built from cached D1 data.
 * No Durable Objects for MCP — tool data cached in Worker memory (60s TTL),
 * new McpServer + transport created per request via mountMcp() from
 * @tedix/mcp-shared/transport (server.connect() to a single-exchange
 * stateless transport).
 *
 * Routing Strategy (Hostname-Based Multi-Tenancy):
 *
 * all apps use subdomain routing - no special "aggregator" mode.
 * Tedix is equal to all other apps (tedix.mcp.tedix.dev).
 *
 * 1. Subdomain (App-scoped):
 *    - tedix.mcp.tedix.dev → Stateless MCP (app: tedix)
 *    - acme.mcp.tedix.dev → Stateless MCP (app: acme)
 *    - mobile-de.mcp.tedix.tech → Stateless MCP (app: mobile-de, local dev)
 *
 * 2. Custom Domain (App-scoped):
 *    - mcp.acme.example → Stateless MCP (lookup by custom domain)
 *
 * 3. Base Domain (Error):
 *    - mcp.tedix.dev (no subdomain) → Error, must use subdomain
 *    - localhost:3000 → Use X-Tedix-Host header to simulate subdomain
 *
 * .well-known Endpoints:
 * - /.well-known/openai-apps-challenge → App's challenge token from D1
 * - /.well-known/oauth-protected-resource → OAuth metadata JSON
 *
 * Map — sections below open with a `// ====` banner carrying these names:
 * Policy-based scope extraction, stateless MCP handler, rate limiting,
 * user -> TEDI resolution, HONO APP (non-MCP routes),
 * WORKFLOW exports, main fetch handler. Aggregation and its caches live in
 * aggregate-surface.ts.
 *
 * Design rationale behind the caching, aggregation and trust-header behaviour
 * in this file: `docs/engineering/mcp/runtime.md`. Scoped operating
 * rules: `apps/mcp/AGENTS.md`.
 */

import { MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION } from "@tedix/mcp-shared/protocol";
import {
	extractMcpTraceMeta,
	resolveInboundTraceId,
	resolveInboundTracestate,
} from "@tedix/mcp-shared/trace-context";
import {
	MCP_SUPPORTED_PROTOCOL_VERSIONS,
	mountMcp,
	type McpCompletionRequest,
	type McpCompletionResult,
	type McpDirectoryReadHandler,
} from "@tedix/mcp-shared/transport";
import { type MultiOrgMcpSelection } from "./auth-helpers";
import {
	organizationScopedRequest,
	resolveConnectOrganization,
} from "./connect-organization";
import { toolResponseTimeoutMs } from "./tool-response-timeout";
// Import from split modules
import { getApiClient } from "./lib/api-client";
import { withStepBudget } from "./lib/step-budget";
import { contentFreeMcpException, createMcpLogger } from "./log";
import {
	buildAggregateTaskHandlers,
	hasAggregateTaskCapableTool,
} from "./mcp/aggregate-task-handlers";
// Type-only static import: the value export `buildAggregateTediTools` is
// loaded dynamically at its single call site instead. That module tree
// (aggregate-tedis-*) materializes ~130 Zod→JSON-Schema conversions at module
// scope, and every one of them ran during Worker STARTUP — the deploy-time
// budget Cloudflare validates at 1s (error 10021). It is needed only when a
// request actually aggregates tedi surfaces, so it must not be on the startup
// path. Same reasoning as the `registerCodeModeTools` dynamic import.
import type { AggregateTediEntry } from "./mcp/aggregate-tedis";
import { isDirectHomeKernelCall } from "./mcp/caller-identity";
import { buildAggregateCompletionHandler } from "./mcp/completions";
import {
	removeProjectedKernelConversationLifecycleTools,
	shouldExposeHomeSurface,
} from "./mcp/home-surface";
import { ensurePlatformOperatorAggregateApps } from "./mcp/platform-operator-aggregation";
import {
	buildEdgeListCacheHints,
	buildMcpServer,
	buildServerContext,
	extractCallerIdentity,
	getAppContext,
} from "./mcp/server-factory";
import type { ResolvedApp } from "./resolution";
import { resolveAppFromHostname } from "./resolution";
import { UPSTREAM_ATTEMPT_TIMEOUT_MS } from "./upstream";
import {
	decorateModernFastPathResult,
	jsonRpcEnvelopeResponse,
	readJsonRpcBody,
	readJsonRpcEnvelope,
	requestBodyTooLargeResponse,
	resolvedMcpServerInfo,
	validateModernFastPathRequest,
} from "./json-rpc-envelope";
import {
	maybeHandleInteractionEvents,
	MCP_EVENTS_EXTENSION,
	type McpSubscriptionBindingEnv,
} from "./mcp-events-routes";
import { getAllowedMcpOrigins, normalizeOrigin } from "./mcp-origin";
import {
	extractDirectToolCallArguments,
	extractRequestedCodeModeNamespaces,
	maybeHandleCodeModeCompactMcp,
	modernDiscoverInstructions,
} from "./codemode-fast-paths";
import { enforceMcpAccess, extractMcpToolCallName } from "./mcp-access";

const log = createMcpLogger("mcp.router");

// A targeted Code Mode request hydrates only the namespace its program names.
// If that one read hits a fast transient, returning the degraded surface makes
// the namespace disappear and the sandbox cannot run. Rebuild once before
// executing the program. Each rebuild retains the existing 12s per-entry cap;
// discovery/full-surface hydration stays single-attempt to avoid multiplying a
// wide fan-out, and persistent failure still reaches the existing diagnostic.
const SELECTIVE_AGGREGATE_HYDRATION_ATTEMPTS = 2;

async function readInboundMcpTraceMeta(
	request: Request,
): Promise<Record<string, unknown> | undefined> {
	const contentType = request.headers.get("Content-Type") ?? "";
	if (request.method !== "POST" || !contentType.includes("application/json")) {
		return undefined;
	}

	try {
		return extractMcpTraceMeta(await request.clone().json());
	} catch {
		return undefined;
	}
}

// =============================================================================
// stateless MCP handler
// =============================================================================

/**
 * Handle MCP request statelessly — new McpServer per request.
 * Tool data cached in Worker memory (60s TTL).
 */
export async function handleMcpRequest(
	request: Request,
	resolvedApp: ResolvedApp,
	env: CloudflareEnv,
	ctx: ExecutionContext,
	multiOrgSelection?: MultiOrgMcpSelection | null,
	interactionEventsEnabled = resolvedApp.metadata?.mcpConfig
		?.interactionEvents === true &&
		Boolean((env as McpSubscriptionBindingEnv).MCP_SUBSCRIPTIONS),
	// Server-owned ingress identity: organization selection must not lift its restrictions.
	connectionAppSlug = resolvedApp.app.slug,
): Promise<Response> {
	const eventResponse = await maybeHandleInteractionEvents(
		request,
		env,
		interactionEventsEnabled,
		resolvedApp.metadata?.mcpConfig?.eventWebhooks === true,
	);
	if (eventResponse) return eventResponse;
	const callerIdentity = extractCallerIdentity(request);
	const multiOrgResource =
		resolvedApp.app.slug === "connect" &&
		resolvedApp.metadata?.mcpConfig?.multiOrgConsent === true;
	if (
		multiOrgResource &&
		(!multiOrgSelection || callerIdentity?.authType !== "oauth")
	) {
		return new Response(JSON.stringify({ error: "multi_org_grant_required" }), {
			status: 403,
			headers: { "Content-Type": "application/json" },
		});
	}
	const organizationTarget = request.headers.get("X-Tedix-Organization");
	if (multiOrgResource && multiOrgSelection && organizationTarget !== null) {
		let selected: MultiOrgMcpSelection["organizations"][number];
		try {
			selected = resolveConnectOrganization(
				multiOrgSelection,
				organizationTarget,
			);
		} catch (error) {
			return Response.json(
				{
					error: "organization_target_invalid",
					message:
						error instanceof Error
							? error.message
							: "Invalid organization target",
				},
				{ status: 403 },
			);
		}
		const gateway = await resolveAppFromHostname(
			{ type: "subdomain", appSlug: selected.gatewaySlug },
			env,
		);
		if (
			!gateway ||
			gateway.app.organizationId !== selected.organizationId ||
			gateway.app.slug === "connect"
		) {
			return Response.json(
				{ error: "organization_gateway_unavailable" },
				{ status: 503 },
			);
		}
		const scopedRequest = organizationScopedRequest(
			request,
			selected.organizationId,
		);
		// Reuse the native gateway's scope gates and surface construction. Authentication
		// and the exact Connect resource audience were already verified at the edge.
		const access = await enforceMcpAccess({
			request: scopedRequest,
			hostname: "connect.mcp.tedix.dev",
			resolvedApp: gateway,
			env,
			oauthJwtPayload: null,
			multiOrgSelection: { organizations: [selected] },
			isDev: env.ENVIRONMENT === "development",
		});
		if (access) return access.response;
		return handleMcpRequest(
			scopedRequest,
			gateway,
			env,
			ctx,
			undefined,
			interactionEventsEnabled,
			connectionAppSlug,
		);
	}
	if (request.method === "GET") {
		const allowedOrigins = getAllowedMcpOrigins(request, env, resolvedApp);
		const origin =
			normalizeOrigin(request.headers.get("Origin") ?? "") ??
			allowedOrigins[0] ??
			new URL(request.url).origin;
		// GET cannot open a stateless stream. Preserve the transport response
		// without hydrating the catalog; events and org-target checks ran above.
		return mountMcp(
			createMcpServer(resolvedMcpServerInfo(resolvedApp)),
			request,
			{ route: "/mcp", cors: { origin } },
		);
	}
	// Discovery must describe the same verified organization gateway as execution.
	// Answering on the Connect host before routing hides the selected Home Tasks
	// extension and bypasses target validation for compact protocol requests.
	const compactResponse = await maybeHandleCodeModeCompactMcp(
		request,
		resolvedApp,
		env,
		interactionEventsEnabled,
		connectionAppSlug,
	);
	if (compactResponse) return compactResponse;
	// Use let — tool merging below builds a per-request copy without mutating the cache.
	let cachedData = await getAppContext(
		resolvedApp.app.id,
		resolvedApp.app.slug,
		env,
		resolvedApp,
	);
	const directAccountBinding =
		cachedData.metadata?.mcpConfig?.connectionInstanceId;
	const directAccountProvider =
		cachedData.metadata?.mcpConfig?.connectionProviderId;
	const configuredAccountScope =
		cachedData.metadata?.mcpConfig?.connectionScope;
	const directAccountScope =
		configuredAccountScope === "user" ||
		configuredAccountScope === "tenant" ||
		configuredAccountScope === "hybrid"
			? configuredAccountScope
			: "tenant";

	if (directAccountBinding) {
		cachedData = {
			...cachedData,
			tools: cachedData.tools.map((tool) => {
				const config = tool.config as Record<string, unknown> | null;
				const auth = config?.auth as Record<string, unknown> | undefined;
				if (
					auth?.type !== "connection" ||
					auth.connectionId !== directAccountProvider
				)
					return tool;
				return {
					...tool,
					config: {
						...config,
						auth: {
							...auth,
							connectionInstanceId: directAccountBinding,
							credentialScope: directAccountScope,
						},
					},
				};
			}),
		};
	}
	if (multiOrgResource && callerIdentity && multiOrgSelection) {
		callerIdentity.verifiedMultiOrgOrganizations =
			multiOrgSelection.organizations;
		// This resource is populated only from the live selected organizations.
		// Ignore any static tools or catalog entries that drift into its D1 row.
		cachedData = {
			...cachedData,
			tools: [],
			catalogResources: [],
			catalogResourceTemplates: [],
			catalogPrompts: [],
		};
	}
	const requestedToolName = await extractMcpToolCallName(request);
	const requestedCodeModeNamespaces =
		requestedToolName === "code"
			? await extractRequestedCodeModeNamespaces(request)
			: null;
	// Code Mode names its namespaces in the program; a direct call names them in
	// the tool name or its catalog arguments. Only these are hydrated.
	const aggregateNamespaces =
		requestedCodeModeNamespaces ??
		directToolCallNamespaces(
			requestedToolName,
			requestedToolName ? await extractDirectToolCallArguments(request) : {},
			cachedData.tools,
		);
	// A programmatic direct call to a first-class home/kernel surface tool — e.g. a
	// skill-runtime goal-loop calling `ask` through the env.MCP bridge —
	// does not need the aggregate-app fan-out (the home surface is mounted
	// separately below, and `home__*`/`kernel__*` tools never come from the
	// aggregate). Skipping the fan-out removes the cold multi-second aggregate build
	// from the hot path for those direct calls. Operator/Code Mode/oauth callers and
	// aggregate-tool calls are unaffected (they don't satisfy the bypass).
	const directHomeKernelCall = isDirectHomeKernelCall(
		callerIdentity,
		requestedToolName,
	);
	// Prefer inbound W3C trace context (HTTP header first, then SEP-414
	// `params._meta.traceparent`) so a caller's distributed trace continues through
	// Tedix; fall back to legacy `X-Trace-Id`, then a fresh UUID.
	const inboundTraceMeta = await readInboundMcpTraceMeta(request);
	const traceId = resolveInboundTraceId(request.headers, inboundTraceMeta);
	const tracestate = resolveInboundTracestate(
		request.headers,
		inboundTraceMeta,
	);
	// Capture the original bearer token for forwarding to upstream service bindings
	const bearerToken =
		request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ??
		undefined;
	const headerConnectionLabel =
		request.headers.get("X-Tedix-Connection-Label") ?? undefined;
	const mcpConnectionLabel =
		(cachedData?.metadata?.mcpConfig?.connectionLabel as string | undefined) ||
		undefined;

	// `upstreamMcpUrl` is retained only as stale-config detection. Runtime
	// App-level upstream URL execution is disabled: catalog installs must sync every
	// upstream tool into D1 app_tools rows through syncCatalogToolsToApp.
	const upstreamMcpUrl = cachedData?.metadata?.mcpConfig?.upstreamMcpUrl as
		| string
		| undefined;
	const upstreamAppId: string | undefined = undefined;
	if (upstreamMcpUrl) {
		if (cachedData.tools.length === 0) {
			return new Response(
				JSON.stringify({
					jsonrpc: "2.0",
					error: {
						code: -32000,
						message:
							"Full-app upstream proxy mode is disabled. Run catalog.sync_catalog_tools_to_app to sync upstream tools into app_tools.",
					},
					id: null,
				}),
				{ status: 409, headers: { "Content-Type": "application/json" } },
			);
		}
		console.warn(
			`[MCP] App ${resolvedApp.app.slug} still has upstreamMcpUrl configured, but runtime proxying is disabled; serving ${cachedData.tools.length} forked D1 tools.`,
		);
	}

	// Org-wide aggregation — merge tools from multiple D1-backed source apps.
	const configuredAggregateApps: AggregateAppEntry[] = multiOrgResource
		? (multiOrgSelection?.organizations ?? []).map((organization) => ({
				slug: organization.gatewaySlug,
				prefix: organization.gatewaySlug,
				organizationId: organization.organizationId,
				organizationMount: true,
			}))
		: withAggregateHostOrganization(
				(cachedData?.metadata?.mcpConfig?.aggregateApps as
					| AggregateAppEntry[]
					| undefined) ?? [],
				resolvedApp.app.organizationId,
			);
	// Host-level connection overrides (connectionProviderId + label/scope/scopes)
	// default into every aggregate entry so `-{tenant}` provider variants don't
	// need per-entry copies of the host credential binding. Explicit entry
	// values still win.
	const aggregateApps = multiOrgResource
		? configuredAggregateApps
		: applyHostConnectionDefaultsToAggregateEntries(
				ensurePlatformOperatorAggregateApps(
					resolvedApp.app.slug,
					configuredAggregateApps,
				),
				cachedData?.metadata?.mcpConfig ?? null,
			);
	const filteredAggregateApps = filterAggregateAppsForCodeNamespaces(
		aggregateApps,
		aggregateNamespaces,
		cachedData?.metadata?.mcpConfig?.codeModeNamespaces as
			| Record<string, string>
			| undefined,
	);
	if (filteredAggregateApps.length && !directHomeKernelCall) {
		let aggregatedSurface = await aggregateAndPrefixTools(
			filteredAggregateApps,
			env,
			new Set(),
			ctx,
			resolvedApp.app.slug,
			undefined,
			!multiOrgResource,
		);
		for (
			let attempt = 1;
			aggregateNamespaces &&
			aggregatedSurface.degraded &&
			attempt < SELECTIVE_AGGREGATE_HYDRATION_ATTEMPTS;
			attempt++
		) {
			console.warn(
				JSON.stringify({
					_cm: "aggregate",
					event: "selective_hydration_retry",
					appSlug: resolvedApp.app.slug,
					attempt,
				}),
			);
			aggregatedSurface = await aggregateAndPrefixTools(
				filteredAggregateApps,
				env,
				new Set(),
				ctx,
				resolvedApp.app.slug,
				undefined,
				!multiOrgResource,
			);
		}
		if (
			aggregatedSurface.tools.length > 0 ||
			aggregatedSurface.resources.length > 0 ||
			aggregatedSurface.resourceTemplates.length > 0 ||
			aggregatedSurface.prompts.length > 0
		) {
			const mountToolScopes = multiOrgResource
				? aggregatedSurface.toolScopes
				: undefined;
			cachedData = {
				...cachedData,
				...(mountToolScopes && Object.keys(mountToolScopes).length > 0
					? {
							metadata: withMountToolScopes(
								cachedData.metadata,
								mountToolScopes,
							),
						}
					: {}),
				tools: [...cachedData.tools, ...aggregatedSurface.tools],
				catalogResources: multiOrgResource
					? []
					: [
							...(cachedData.catalogResources ?? []),
							...aggregatedSurface.resources,
						],
				catalogResourceTemplates: multiOrgResource
					? []
					: [
							...(cachedData.catalogResourceTemplates ?? []),
							...aggregatedSurface.resourceTemplates,
						],
				catalogPrompts: multiOrgResource
					? []
					: [
							...(cachedData.catalogPrompts ?? []),
							...aggregatedSurface.prompts,
						],
			};
			console.log(
				`[MCP] Aggregated ${aggregatedSurface.tools.length} tools, ${aggregatedSurface.resources.length} resources, ${aggregatedSurface.resourceTemplates.length} resource templates from ${filteredAggregateApps.length} apps into ${resolvedApp.app.slug}`,
			);
		}
	}

	const aggregateTedis = filterAggregateTedisForCodeNamespaces(
		multiOrgResource
			? undefined
			: (cachedData?.metadata?.mcpConfig?.aggregateTedis as
					| AggregateTediEntry[]
					| undefined),
		aggregateNamespaces,
	);
	// Hydrated aggregate tedis (D1 tediId + runtime kind). Captured here so the
	// completion/complete handler (below) can complete tedi-targeting arguments
	// from the same resolved set the `tedi:*` tools were built from.
	let hydratedAggregateTedis: AggregateTediEntry[] = [];
	if (aggregateTedis?.length && !directHomeKernelCall) {
		// Hydrate runtime_kind from D1 so the aggregator can hide
		// container-only tools when an isolate tedi is in the surface.
		// Operators don't annotate runtime_kind in metadata — it's
		// authoritative in the `tedis` table.
		const hydratedTedis = await hydrateAggregateRuntimeKinds(
			aggregateTedis,
			env,
		);
		hydratedAggregateTedis = hydratedTedis;
		const { buildAggregateTediTools } = await import("./mcp/aggregate-tedis");
		const tediTools = buildAggregateTediTools(hydratedTedis, env);
		if (tediTools.length > 0) {
			cachedData = {
				...cachedData,
				tools: [...cachedData.tools, ...tediTools],
			};
			console.log(
				`[MCP] Aggregated ${tediTools.length} tedi tools from ${aggregateTedis.length} tedis into ${resolvedApp.app.slug}`,
			);
		}
	}

	// First-class "home" namespace (docs/engineering/product/tedix-os.md): expose
	// the kernel as org-scoped `home__*` tools on org aggregate surfaces so an
	// operator can drive and converse with Home directly — not under a borrowed
	// tedi identity. Caller org rides the X-Tedix-Org-Id header (set in
	// handler.ts) and is enforced server-side by resolveOrganizationId, so no
	// tediId is ever attached and no ORG_INJECT_ROUTERS entry is required.
	const exposeHomeSurface = shouldExposeHomeSurface({
		appSlug: resolvedApp.app.slug,
		metadata: cachedData.metadata,
	});
	if (exposeHomeSurface) {
		cachedData = {
			...cachedData,
			tools: removeProjectedKernelConversationLifecycleTools(cachedData.tools),
		};
		const { buildHomeSurfaceTools } = await import("./mcp/home-surface-tools");
		const homeSurfaceTools = buildHomeSurfaceTools();
		if (homeSurfaceTools.length > 0) {
			cachedData = {
				...cachedData,
				tools: [...cachedData.tools, ...homeSurfaceTools],
			};
			console.log(
				`[MCP] Added ${homeSurfaceTools.length} first-class home__* tools to ${resolvedApp.app.slug}`,
			);
		}
	}

	// connectionLabel: header takes precedence, then mcpConfig fallback for
	// forked D1 tools that inherit app-level connection routing.
	const connectionLabel = headerConnectionLabel ?? mcpConnectionLabel;
	if (requestedToolName === "get_info") {
		const envelope = await readJsonRpcEnvelope(request);
		if (envelope && "tooLarge" in envelope)
			return requestBodyTooLargeResponse();
		if (!envelope) return new Response("Invalid MCP request", { status: 400 });
		const modernError = validateModernFastPathRequest(request, envelope);
		if (modernError) return modernError;
		const bootstrapServer = createMcpServer({
			name: cachedData.app.name,
			version: cachedData.metadata?.mcpConfig?.serverVersion ?? "1.0.0",
		});
		const bootstrapContext = buildServerContext(
			bootstrapServer,
			cachedData,
			callerIdentity,
			env,
			ctx,
			connectionLabel,
			traceId,
			tracestate,
			upstreamAppId,
			bearerToken,
			inboundTraceMeta,
			requestedCodeModeNamespaces,
			connectionAppSlug,
		);
		for (const tool of cachedData.tools)
			bootstrapContext.loadedTools.set(tool.toolId, tool);
		const info = {
			...buildBootstrapInfo(bootstrapContext, cachedData.tools),
			toolCount: 1,
			fastPath: "bootstrap",
		};
		return jsonRpcEnvelopeResponse(
			envelope,
			decorateModernFastPathResult(envelope, resolvedApp, {
				resultType: "complete",
				content: [
					{
						type: "text",
						text: `${info.name} MCP Server v${info.serverVersion}`,
					},
				],
				structuredContent: info,
				...(info.sidebarApp
					? {
							_meta: sidebarAppToolMeta(
								cachedData.app.slug,
								cachedData.metadata?.mcpConfig,
							),
						}
					: {}),
			}),
		);
	}
	const requestBody = await readJsonRpcBody(request);
	const clientAppsSupported = clientSupportsMcpApps(
		requestBody,
		request.headers,
	);
	const server = await buildMcpServer(
		cachedData,
		callerIdentity,
		env,
		ctx,
		connectionLabel,
		traceId,
		tracestate,
		upstreamAppId,
		bearerToken,
		requestedToolName,
		inboundTraceMeta,
		requestedCodeModeNamespaces,
		connectionAppSlug,
		clientAppsSupported,
	);
	const directoryReadHandler = (
		server as unknown as {
			tedixSkillDirectoryReadHandler?: McpDirectoryReadHandler;
		}
	).tedixSkillDirectoryReadHandler;
	const allowedOrigins = getAllowedMcpOrigins(request, env, resolvedApp);
	const responseOrigin =
		normalizeOrigin(
			request.headers.get("Origin") ?? request.headers.get("origin") ?? "",
		) ??
		allowedOrigins[0] ??
		new URL(request.url).origin;
	// MCP tasks extension (io.modelcontextprotocol/tasks): on the same org
	// aggregate surfaces that serve home__* tools, ask results carry
	// `task.id = homeRunId`, and tasks/get|cancel are answered org-scoped against
	// the kernel runtime (kernelRuntime.readRun / cancelRun via service binding).
	// Org resolution mirrors the home__* tools (handler.ts):
	// callerIdentity.organizationId first, then the app's org. Without an org the
	// handlers are omitted and the extension is not advertised — home runs would
	// not be readable.
	const homeTaskOrgId =
		callerIdentity?.organizationId ?? resolvedApp.app.organizationId;
	// Mount task handlers (and advertise io.modelcontextprotocol/tasks) for the
	// home/kernel surface or for any app that exposes a generic async tool
	// (`config._asyncTask === true`). Generic-task ids (`generic-<uuid>`) route
	// through the same aggregate handler to the mcp_tasks store; bare/`tedi:`
	// ids keep routing to the kernel/per-tedi projections.
	const hasTaskCapableTool = hasAggregateTaskCapableTool(
		cachedData.tools as Array<{ config?: Record<string, unknown> | null }>,
	);
	const taskHandlers =
		(exposeHomeSurface || hasTaskCapableTool) && homeTaskOrgId
			? buildAggregateTaskHandlers({
					env,
					appId: resolvedApp.app.id,
					organizationId: homeTaskOrgId,
					includeHomeSurface: exposeHomeSurface,
					callerIdentity,
					bearerToken,
					delegatedTediTaskId:
						callerIdentity?.authType === "service" && callerIdentity.skillRunId
							? (request.headers.get("X-Tedix-Workflow-Tedi-Task-Id") ??
								undefined)
							: undefined,
				})
			: undefined;
	// 2026-07-28 completion/complete: serve argument autocompletion for
	// kernel→tedi composition on surfaces that carry the kernel/aggregate
	// surface. Completes tedi-targeting arguments (tediId/slug/namespace) from
	// the already-resolved aggregate tedis and conversation/session arguments
	// from one bounded kernelRuntime conversation read. Other surfaces omit it,
	// so the `completions` capability is only advertised where it is useful.
	const aggregateCompletionHandler =
		exposeHomeSurface || hydratedAggregateTedis.length > 0
			? buildAggregateCompletionHandler({
					aggregateTedis: hydratedAggregateTedis,
					...(homeTaskOrgId ? { organizationId: homeTaskOrgId } : {}),
					env,
				})
			: undefined;
	// SEP-2640: skill:// resource-template variable completion
	// (`skill_name`/`app_slug`), attached by registerAppSkills on skill-serving
	// surfaces. Merge it ahead of the kernel/aggregate completer; either handler
	// alone makes mountMcp advertise the `completions` capability here.
	const skillCompletionHandler = (
		server as unknown as {
			tedixSkillCompletionHandler?: (
				input: McpCompletionRequest,
			) => McpCompletionResult | null;
		}
	).tedixSkillCompletionHandler;
	const completionHandler =
		skillCompletionHandler || aggregateCompletionHandler
			? async (input: McpCompletionRequest): Promise<McpCompletionResult> => {
					const skillResult = skillCompletionHandler?.(input) ?? null;
					if (skillResult) return skillResult;
					return (await aggregateCompletionHandler?.(input)) ?? { values: [] };
				}
			: undefined;
	// `subscriptions/listen` is served out-of-band by McpSubscriptionDurableObject
	// (routeMcpSubscriptionRequest) when the binding exists. Advertise the
	// per-primitive notification capabilities the do honors (resources
	// subscribe/listChanged, tools/prompts listChanged) so a discover-first
	// client can learn the stream exists instead of probing for it. Prompts are
	// intentionally not advertised: this edge does not mount prompt handlers.
	const hasSubscriptionStream = Boolean(
		(env as McpSubscriptionBindingEnv).MCP_SUBSCRIPTIONS,
	);
	const response = await mountMcp(server, request, {
		toolResponseTimeoutMs: (name) =>
			toolResponseTimeoutMs(
				name,
				cachedData.tools,
				resolvedApp.metadata?.mcpConfig,
			),
		route: "/mcp",
		cors: { origin: responseOrigin },
		// SEP-2549: explicit list-surface freshness hints mirroring the cache
		// actually backing this mount — aggregate surfaces rebuild on the 120s
		// L1 surface cache, plain apps on the 60s per-app D1 cache (default).
		cacheHints: buildEdgeListCacheHints(
			filteredAggregateApps.length > 0 || hydratedAggregateTedis.length > 0
				? AGGREGATE_SURFACE_CACHE_TTL_MS
				: undefined,
		),
		discover: {
			supportedVersions: MCP_SUPPORTED_PROTOCOL_VERSIONS,
			serverInfo: resolvedMcpServerInfo(resolvedApp),
			instructions: modernDiscoverInstructions(resolvedApp, connectionAppSlug),
			capabilities: {
				...(interactionEventsEnabled ? { events: {} } : {}),
				tools: hasSubscriptionStream ? { listChanged: true } : {},
				resources: hasSubscriptionStream
					? { listChanged: true, subscribe: true }
					: {},
				extensions: {
					"io.modelcontextprotocol/apps": {},
					"io.modelcontextprotocol/ui": {},
					// SEP-3415 names the events extension here; the top-level
					// `events` key above stays for hosts that read the older shape.
					...(interactionEventsEnabled ? { [MCP_EVENTS_EXTENSION]: {} } : {}),
					"io.modelcontextprotocol/skills": directoryReadHandler
						? { directoryRead: true }
						: {},
					// SEP-1046: advertise the client-credentials M2M flow when the
					// app is backed by an OAuth as (Descope AIH). Token validation +
					// scope enforcement already run at the edge; this is discovery so
					// non-interactive callers can skip the authorization-code flow.
					...(cachedData.metadata?.mcpConfig?.descopeResourceId
						? { [MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION]: {} }
						: {}),
				},
			},
		},
		resultTransform: mcpToolsListResultTransform(
			cachedData.tools,
			cachedData.metadata?.mcpConfig as Record<string, unknown> | undefined,
			request.headers,
		),
		taskHandlers,
		completionHandler,
		directoryReadHandler,
	});
	const headers = new Headers(response.headers);
	headers.set("X-Tedix-Trace-Id", traceId);
	if (
		requestBody?.method === "initialize" &&
		clientAppsSupported &&
		response.ok
	) {
		headers.set(
			"Mcp-Session-Id",
			`${LEGACY_APPS_SESSION_PREFIX}${crypto.randomUUID()}`,
		);
		headers.append("Access-Control-Expose-Headers", "Mcp-Session-Id");
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

// =============================================================================
// rate limiting
// =============================================================================

// =============================================================================
// user → TEDI resolution
// =============================================================================

/**
 * In-memory cache for user→tedi resolution.
 * Key: `${orgId}:${descopeUserId}`, Value: { tediId, expiresAt }
 *
 * This maps human callers (OAuth tokens with userId but no tediId) to their
 * primary tedi in the organization, so memory/cognitive tools work seamlessly
 * for both tedi service tokens and human users.
 */
const userTediCache = new Map<string, { tediId: string; expiresAt: number }>();
const USER_TEDI_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Resolve the primary tedi for a human user in an organization.
 *
 * Looks up tedis by descopeUserId match, falling back to the org's default
 * org-scoped tedi if no personal tedi exists.
 *
 * Returns null if no tedi can be resolved.
 */
export async function resolvePrimaryTedi(
	env: CloudflareEnv,
	descopeUserId: string,
	organizationId: string,
): Promise<string | null> {
	const cacheKey = `${organizationId}:${descopeUserId}`;

	// Check cache
	const cached = userTediCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) {
		return cached.tediId;
	}

	try {
		if (!env.API_SERVICE) return null;

		const client = getApiClient({
			serviceFetch: env.API_SERVICE,
			orgId: organizationId,
		});
		const data = await client.tedis.list({ limit: 50 });
		const tedis = data.data ?? [];
		if (tedis.length === 0) return null;

		// Resolution strategy:
		// 1. Personal tedi owned by this user (ownerUserId match)
		// 2. Org-scoped tedi (shared identity for the organization)
		const personalTedi = tedis.find(
			(t) =>
				(t.descopeUserId === descopeUserId ||
					t.ownerUserId === descopeUserId) &&
				t.status === "active",
		);
		const orgTedi = tedis.find(
			(t) => t.scope === "organization" && t.status === "active",
		);

		const resolved = personalTedi ?? orgTedi;
		if (!resolved) {
			console.warn(
				`[resolvePrimaryTedi] No tedi found for user=${descopeUserId} in org=${organizationId}. Tedis: ${tedis.length}, checked descopeUserId/ownerUserId match.`,
			);
			return null;
		}

		// Cache the result
		userTediCache.set(cacheKey, {
			tediId: resolved.id,
			expiresAt: Date.now() + USER_TEDI_CACHE_TTL_MS,
		});

		// Evict expired entries
		if (userTediCache.size > 200) {
			const now = Date.now();
			for (const [key, value] of userTediCache) {
				if (value.expiresAt <= now) userTediCache.delete(key);
			}
		}

		return resolved.id;
	} catch (error) {
		log.warn("Primary tedi resolution failed", {
			event: "router.primary_tedi_resolution_failed",
			outcome: "unavailable",
			error: contentFreeMcpException(error),
		});
		return null;
	}
}

/**
 * Hydrate D1-owned aggregate tedi fields by batched lookup. Operators only put
 * slugs in app metadata; runtime kind and credential identity are authoritative
 * in the `tedis` table. Paused/non-operational tedis are dropped so aggregate
 * MCP surfaces cannot keep advertising retired workers.
 *
 * Source-of-truth read routes through apps/api (service binding), not a direct
 * `@tedix/db` query, per the thin-edge invariant. The endpoint is cross-org by
 * design (slugs are globally unique); we send `X-Tedix-Org-Id: system`.
 *
 * Fail-safe on the API-error path (the `try` body throws or the endpoint returns
 * non-ok — a transient outage with the binding present): stamp every entry's
 * runtimeKind to `agent` so the aggregate surface stays on the only supported
 * tedi runtime kind while the API is briefly unavailable.
 *
 * The no-binding case (`!env.API_SERVICE`) is a permanent config/dev condition,
 * not a transient outage — in production the binding is always present. There we
 * leave entries unmodified and rely on the downstream Agent-runtime default.
 */
export async function hydrateAggregateRuntimeKinds(
	entries: AggregateTediEntry[],
	env: CloudflareEnv,
): Promise<AggregateTediEntry[]> {
	if (!env.API_SERVICE || entries.length === 0) return entries;
	// Operator-authored aggregateTedis metadata may contain empty/blank slugs.
	// The endpoint's input schema rejects empty strings (z.string().min(1)), so
	// one bad row would 400 the whole batch and trip the transient-outage
	// fail-safe for every entry. Filter them out instead: empty-slug entries
	// simply stay un-hydrated (matching the old direct-D1 per-entry no-op).
	const slugs = Array.from(
		new Set(
			entries
				.map((e) => e.slug)
				.filter((s) => typeof s === "string" && s.length > 0),
		),
	);
	if (slugs.length === 0) return entries;
	try {
		const client = getApiClient({
			serviceFetch: env.API_SERVICE,
			orgId: "system",
		});
		type RuntimeMetaRow = {
			slug: string;
			id: string;
			organizationId: string;
			runtimeKind: string;
			runtimeState: string;
			status: string | null;
		};
		// Chunk under the endpoint's input cap (and D1's bound-parameter limit) so
		// an arbitrarily large aggregate surface never overflows into the
		// transient-outage fail-safe (which would stop dropping retired tedis).
		const CHUNK = 200;
		const rows: RuntimeMetaRow[] = [];
		for (let i = 0; i < slugs.length; i += CHUNK) {
			// Budgeted: awaited on the request path with no other deadline; a wedged
			// call must degrade via the fail-safe below, not hang the surface build.
			const payload = await withStepBudget(
				"aggregate_tedi_runtime_hydrate",
				UPSTREAM_ATTEMPT_TIMEOUT_MS,
				client.tedis.listRuntimeMetaBySlugs({
					slugs: slugs.slice(i, i + CHUNK),
				}),
			);
			rows.push(...(payload.data as RuntimeMetaRow[]));
		}
		const bySlug = new Map<
			string,
			Pick<AggregateTediEntry, "tediId" | "organizationId" | "runtimeKind">
		>();
		const inactiveSlugs = new Set<string>();
		for (const row of rows) {
			if (
				row.runtimeState === "archived" ||
				["error", "paused", "provisioning"].includes(row.status ?? "")
			) {
				inactiveSlugs.add(row.slug);
				continue;
			}
			bySlug.set(row.slug, {
				tediId: row.id,
				organizationId: row.organizationId,
				...(row.runtimeKind === "agent"
					? { runtimeKind: row.runtimeKind }
					: {}),
			});
		}
		return entries
			.filter((entry) => !inactiveSlugs.has(entry.slug))
			.map((entry) => ({ ...entry, ...bySlug.get(entry.slug) }));
	} catch (error) {
		log.warn("Aggregate tedi hydration failed", {
			event: "aggregate.tedi_hydration_failed",
			outcome: "unavailable",
			error: contentFreeMcpException(error),
		});
		return entries.map((entry) => ({
			...entry,
			runtimeKind: "agent" as const,
		}));
	}
}
