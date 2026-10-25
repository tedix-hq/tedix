import { createMcpServer } from "@tedix/mcp-shared/server";
import {
	clientSupportsMcpApps,
	LEGACY_APPS_SESSION_PREFIX,
} from "./mcp/client-apps-capability";
import { z } from "zod";
import {
	AGGREGATE_SURFACE_CACHE_TTL_MS,
	purgeAggregateSurfaceCaches,
} from "./aggregate-surface-cache";
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

import { extractTediJwtClaims } from "@tedix/auth/types";
import {
	MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION,
	MCP_PROTOCOL_VERSION_HEADER,
} from "@tedix/mcp-shared/protocol";
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
import { installHonoErrorHandlers } from "@tedix/worker-kit/errors";
import {
	requestTraceId,
	correlatedErrorResponse,
} from "@tedix/worker-kit/request-correlation";
import {
	applyInboundTrustHeaderHygiene,
	isServiceBinding,
	stripServiceBindingMarker,
} from "@tedix/worker-kit/request-auth";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { cors } from "hono/cors";
import {
	humanMcpGrantFailureResponse,
	invalidateAihM2mClientScopeCache,
	isTrustedBrowserBridge,
	recordM2mTokenAudience,
	resolveAihM2mClientScopeContext,
	resolveAihM2mTediOrganizationId,
	resolveExternalAgentSessionAuth,
	resolveHumanMcpSelection,
	resolveMcpExpectedAudience,
	validateAuth,
	stripRedundantApiKeyHeader,
	type MultiOrgMcpSelection,
} from "./auth-helpers";
import {
	organizationScopedRequest,
	resolveConnectOrganization,
	shouldBindHumanToTedi,
} from "./connect-organization";
import { deliverDueEventWebhooks } from "./event-webhooks";
import { toolResponseTimeoutMs } from "./tool-response-timeout";
// Import from split modules
import { extractAppFromHostname, resolveRequestHostname } from "./hostname";
import { getApiClient } from "./lib/api-client";
import { withStepBudget } from "./lib/step-budget";
import { contentFreeMcpException, createMcpLogger } from "./log";
import {
	buildAggregateTaskHandlers,
	hasAggregateTaskCapableTool,
	reassertTrustedWorkflowTediTaskId,
} from "./mcp/aggregate-task-handlers";
import {
	resolveTediProfileAuth,
	tediProfileFailureResponse,
	type TediProfileAuth,
} from "./tedi-profile-auth";
// Type-only static import: the value export `buildAggregateTediTools` is
// loaded dynamically at its single call site instead. That module tree
// (aggregate-tedis-*) materializes ~130 Zod→JSON-Schema conversions at module
// scope, and every one of them ran during Worker STARTUP — the deploy-time
// budget Cloudflare validates at 1s (error 10021). It is needed only when a
// request actually aggregates tedi surfaces, so it must not be on the startup
// path. Same reasoning as the `registerCodeModeTools` dynamic import.
import { handleExternalAgentSessionExchange } from "./external-agent-session";
import {
	externalAgentValidationFailureResponse,
	recordExternalAgentValidation,
} from "./external-agent-validation";
import type { AggregateTediEntry } from "./mcp/aggregate-tedis";
import { isDirectHomeKernelCall } from "./mcp/caller-identity";
import { buildAggregateCompletionHandler } from "./mcp/completions";
import {
	removeProjectedKernelConversationLifecycleTools,
	shouldExposeHomeSurface,
} from "./mcp/home-surface";
import { ensurePlatformOperatorAggregateApps } from "./mcp/platform-operator-aggregation";
import {
	recordMcpAccessDenial,
	recordProtocolDenialIfPresent,
} from "./mcp/security-decision";
import {
	buildEdgeListCacheHints,
	buildMcpServer,
	buildServerContext,
	extractCallerIdentity,
	getAppContext,
} from "./mcp/server-factory";
import { getAppsSDKCompatibleHtml } from "./mcp/utils/widget";
import { checkMcpRequestRateLimit } from "./middleware/rate-limit";
import { handlePreviewRequest } from "./preview";
import type { ResolvedApp } from "./resolution";
import {
	getCorsOrigins,
	purgeAppResolutionCacheKeys,
	resolveAppFromHostname,
} from "./resolution";
import {
	isRetryableUpstreamError,
	UPSTREAM_ATTEMPT_TIMEOUT_MS,
	upstreamUnavailableResponse,
} from "./upstream";
import { handleFavicon, handleWellKnown } from "./well-known";
import {
	decorateModernFastPathResult,
	jsonRpcEnvelopeResponse,
	readJsonRpcBody,
	readJsonRpcEnvelope,
	requestBodyTooLargeResponse,
	resolvedMcpServerInfo,
	unsupportedProtocolVersionResponse,
	validateModernFastPathRequest,
} from "./json-rpc-envelope";
import {
	handleInternalSubscriptionPublish,
	maybeHandleInteractionEvents,
	maybeHandleSubscriptionsListen,
	MCP_EVENTS_EXTENSION,
	type McpSubscriptionBindingEnv,
} from "./mcp-events-routes";
import {
	getAllowedMcpOrigins,
	normalizeOrigin,
	validateMcpOrigin,
} from "./mcp-origin";
import {
	extractDirectToolCallArguments,
	extractRequestedCodeModeNamespaces,
	maybeHandleBootstrapFastMcp,
	maybeHandleCodeModeCompactMcp,
	modernDiscoverInstructions,
} from "./codemode-fast-paths";
import { enforceMcpAccess, extractMcpToolCallName } from "./mcp-access";

const log = createMcpLogger("mcp.router");

export { McpSubscriptionDurableObject } from "./subscriptions";

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
async function resolvePrimaryTedi(
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

const DEFAULT_RATE_LIMIT_CONFIG = {
	requestsPerMinute: 100,
	retryAfterSeconds: 60,
} as const;

interface RateLimitConfig {
	requestsPerMinute?: number;
	retryAfterSeconds?: number;
}

function rateLimitResponse(config?: RateLimitConfig): Response {
	const retryAfter =
		config?.retryAfterSeconds ?? DEFAULT_RATE_LIMIT_CONFIG.retryAfterSeconds;
	const limit =
		config?.requestsPerMinute ?? DEFAULT_RATE_LIMIT_CONFIG.requestsPerMinute;

	return new Response(
		JSON.stringify({
			error: "Rate limit exceeded",
			message: "Too many requests. Please try again later.",
			retryAfter,
		}),
		{
			status: 429,
			headers: {
				"Content-Type": "application/json",
				"Retry-After": String(retryAfter),
				"X-RateLimit-Limit": String(limit),
				"X-RateLimit-Remaining": "0",
			},
		},
	);
}

// =============================================================================
// HONO APP (non-MCP routes)
// =============================================================================

const honoApp = new Hono<{ Bindings: CloudflareEnv }>();

installHonoErrorHandlers(honoApp, { service: "mcp" });

honoApp.use("*", async (c, next) => {
	const origins = getCorsOrigins(c.env);
	const corsMiddleware = cors({
		origin: origins.length > 0 ? origins : "*",
		credentials: true,
	});
	return corsMiddleware(c, next);
});

// deployedSha is the release SHA this Worker is actually running, and the
// only unauthenticated way to see it. It is deliberately the same GIT_SHA var
// that keys the aggregate surface cache (see aggregateSurfaceCacheKey), so a
// deploy that fails to stamp it is visible here instead of silently keying the
// cache on a stale value.
// authz: public — unauthenticated liveness + deployed-sha probe; serves no tenant data.
honoApp.get("/health", (c) =>
	c.json(
		{
			status: "ok",
			service: "mcp",
			deployedSha: String(c.env.GIT_SHA || "unknown"),
			timestamp: new Date().toISOString(),
		},
		200,
		{ "Cache-Control": "no-store" },
	),
);

// Debug endpoints
// authz: public — development-only debug surface; returns 404 outside environment=development.
honoApp.get("/debug/hostname", (c) => {
	const debugEnv = c.env as CloudflareEnv;
	if (debugEnv.ENVIRONMENT !== "development") {
		return c.text("Not Found", 404);
	}
	const env = c.env as CloudflareEnv;
	const url = new URL(c.req.url);
	const xOriginalHost = c.req.header("x-original-host");
	const xForwardedHost = c.req.header("x-forwarded-host");
	const xTedixHost = c.req.header("x-tedix-host");
	const hostHeader = c.req.header("host");

	const hostname = resolveRequestHostname(c.req.raw.headers, url, env);

	const hostnameInfo = extractAppFromHostname(hostname, env);

	// Only include safe routing headers, never auth/cookie headers
	const safeHeaderKeys = new Set([
		"host",
		"x-original-host",
		"x-forwarded-host",
		"x-tedix-host",
		"x-forwarded-for",
		"x-forwarded-proto",
		"content-type",
		"accept",
		"user-agent",
		"cf-connecting-ip",
		"cf-ray",
	]);
	const safeHeaders: Record<string, string> = {};
	c.req.raw.headers.forEach((value, key) => {
		if (safeHeaderKeys.has(key)) {
			safeHeaders[key] = value;
		}
	});

	return c.json({
		urlHostname: url.hostname,
		xOriginalHost,
		xForwardedHost,
		xTedixHost,
		hostHeader,
		resolvedHostname: hostname,
		hostnameInfo,
		headers: safeHeaders,
	});
});

// authz: public — development-only debug surface; returns 404 outside environment=development.
honoApp.get("/debug/widget-html", async (c) => {
	const env = c.env as CloudflareEnv;
	if (env.ENVIRONMENT !== "development") {
		return c.text("Not Found", 404);
	}
	const route = c.req.query("route") || "/tedix/search-listings";
	const widgetUrl = env.MCP_UI_URL;
	const isDev = env.ENVIRONMENT === "development";

	try {
		const html = await getAppsSDKCompatibleHtml(widgetUrl, route);

		const preview = html.substring(0, 2000);
		const hasBaseHref = html.includes('<base href="');

		return c.json({
			success: true,
			widgetUrl,
			route,
			isDevelopment: isDev,
			validation: {
				hasBaseHref,
				totalLength: html.length,
			},
			preview: preview + (html.length > 2000 ? "\n... (truncated)" : ""),
		});
	} catch (error) {
		return c.json(
			{
				success: false,
				error: error instanceof Error ? error.message : "Unknown error",
				widgetUrl,
				route,
				isDevelopment: isDev,
			},
			500,
		);
	}
});

// =============================================================================
// WORKFLOW exports
// =============================================================================

// Generic server-side MCP Tasks executor — backs config-driven `_asyncTask`
// tools that opt into the io.modelcontextprotocol/tasks extension.
export { GenericTasksWorkflow } from "./workflows/generic-tasks-workflow";

// =============================================================================
// main fetch handler
// =============================================================================

const worker = {
	async fetch(
		request: Request,
		env: CloudflareEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/external-agents/session")
			request = stripRedundantApiKeyHeader(request);

		let hostname = resolveRequestHostname(request.headers, url, env);
		const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";
		const baseMcpOrigin = env.MCP_URL;
		const isDev = env.ENVIRONMENT === "development";
		if (
			isDev &&
			(hostname === "host.docker.internal" ||
				hostname === "localhost" ||
				hostname === "127.0.0.1")
		) {
			const localAppSlug = url.searchParams.get("appSlug");
			if (localAppSlug && /^[a-z0-9-]+$/i.test(localAppSlug)) {
				hostname = `${localAppSlug}.mcp.tedix.tech`;
			}
		}

		// authz: public — health probe plus the dev-only /debug/* Hono surface.
		if (
			url.pathname === "/health" ||
			(isDev && url.pathname.startsWith("/debug/"))
		) {
			return honoApp.fetch(request, env, ctx);
		}

		if (url.pathname === "/external-agents/session") {
			return handleExternalAgentSessionExchange(request, env);
		}

		// Internal service-binding-only route: best-effort scope cache invalidation.
		// Called by apps/api after syncTediAihClientForAssignment succeeds.
		if (
			request.method === "POST" &&
			url.pathname === "/__internal/invalidate-scope-cache"
		) {
			if (!isServiceBinding(request.headers)) {
				return new Response(JSON.stringify({ error: "Forbidden" }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				});
			}
			try {
				const body = (await request.json()) as { mcpServerId?: string };
				const cleared = invalidateAihM2mClientScopeCache(
					body.mcpServerId ? { mcpServerId: body.mcpServerId } : undefined,
				);
				return new Response(JSON.stringify({ ok: true, cleared }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			} catch {
				return new Response(JSON.stringify({ ok: true, cleared: 0 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
		}

		// Internal service-binding-only route: best-effort Workers Cache purge for
		// an app's `.well-known/*` discovery documents (see well-known.ts, which
		// stamps `Cache-Tag: app:{id}` on the two cacheable responses). Called by
		// apps/api after a mutation that can change discovery content: mcpConfig
		// (updateAppProcedure / updateByIdOrSlugProcedure) or the OpenAI challenge
		// token, once an endpoint writes that field.
		// Purge the durable aggregate-surface cache (L3/R2 globally, L1 for this
		// isolate). Called by the tool-schema-sync workflow after it applies
		// schema changes, because these layers otherwise have no invalidation
		// (see `docs/engineering/mcp/runtime.md`). Purge rolls the
		// global activation epoch before deleting snapshots; every aggregate
		// request reads that marker before addressing L1/L2 so notifications
		// never outrun it.
		if (
			request.method === "POST" &&
			url.pathname === "/__internal/purge-aggregate-cache"
		) {
			if (!isServiceBinding(request.headers)) {
				return new Response(JSON.stringify({ error: "Forbidden" }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				});
			}
			try {
				const { deleted, l2Deleted, localEntries, activationEpoch } =
					await purgeAggregateSurfaceCaches(env);
				console.log(
					`[aggregate] purge-aggregate-cache: r2Deleted=${deleted} localEntriesCleared=${localEntries}`,
				);
				return new Response(
					JSON.stringify({
						ok: true,
						r2Deleted: deleted,
						l2Deleted,
						localEntries,
						activationEpoch,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			} catch (error) {
				return new Response(
					JSON.stringify({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
		}
		if (
			request.method === "POST" &&
			url.pathname === "/__internal/purge-discovery-cache"
		) {
			if (!isServiceBinding(request.headers)) {
				return new Response(JSON.stringify({ error: "Forbidden" }), {
					status: 403,
					headers: { "Content-Type": "application/json" },
				});
			}
			try {
				const body = (await request.json()) as {
					appId?: string;
					appResolutionKeys?: string[];
				};
				if (!body.appId) {
					return new Response(
						JSON.stringify({ ok: false, error: "appId required" }),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					);
				}
				const result = await ctx.cache?.purge({
					tags: [`app:${body.appId}`],
				});
				const resolution = await purgeAppResolutionCacheKeys(
					env,
					body.appResolutionKeys ?? [],
				);
				return new Response(
					JSON.stringify({
						ok: result?.success !== false,
						discoveryPurged: result?.success ?? false,
						...resolution,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			} catch {
				return new Response(JSON.stringify({ ok: false }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
		}

		if (
			request.method === "POST" &&
			url.pathname === "/__internal/subscriptions/publish"
		) {
			return handleInternalSubscriptionPublish(request, env);
		}

		// The API's two-minute cron drives SEP-3415 webhook delivery here.
		if (
			request.method === "POST" &&
			url.pathname === "/__internal/events/deliver"
		) {
			if (!isServiceBinding(request.headers))
				return Response.json({ error: "Forbidden" }, { status: 403 });
			return Response.json({
				ok: true,
				...(await deliverDueEventWebhooks(env)),
			});
		}

		// MCP CORS preflight must answer before auth — OPTIONS carries no
		// credentials, so browser-hosted modern clients otherwise get 401 and
		// cannot negotiate. Advertise the full modern header set.
		if (
			request.method === "OPTIONS" &&
			(url.pathname === "/mcp" || url.pathname.startsWith("/mcp/"))
		) {
			const requestedParamHeaders = (
				request.headers.get("Access-Control-Request-Headers") ?? ""
			)
				.split(",")
				.map((header) => header.trim())
				.filter((header) => /^mcp-param-/i.test(header));
			const allowedHeaders = [
				"Content-Type",
				"Accept",
				"Authorization",
				"MCP-Protocol-Version",
				"Mcp-Session-Id",
				"Mcp-Method",
				"Mcp-Name",
				"X-API-Key",
				...requestedParamHeaders,
			];
			return new Response(null, {
				status: 204,
				headers: {
					// Echoes any origin (bearer-authenticated MCP) and adds X-API-Key +
					// reflected Mcp-Param-* headers: not the worker-kit allowlist/constants.
					"Access-Control-Allow-Origin": request.headers.get("Origin") ?? "*",
					"Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
					"Access-Control-Allow-Headers": [...new Set(allowedHeaders)].join(
						", ",
					),
					"Access-Control-Max-Age": "86400",
				},
			});
		}

		// Legacy initialization has no version header. Explicit versions must
		// belong to the same compatibility ladder advertised by the transport.
		const protocolVersion = request.headers.get(MCP_PROTOCOL_VERSION_HEADER);
		if (
			request.method === "POST" &&
			(url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) &&
			protocolVersion !== null &&
			!MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)
		) {
			return unsupportedProtocolVersionResponse(request);
		}

		if (
			!baseMcpOrigin &&
			(url.pathname === "/mcp" || url.pathname.startsWith("/mcp/"))
		) {
			return new Response(
				JSON.stringify({
					error: "Server misconfiguration",
					message: "MCP_URL must be set for MCP routing.",
				}),
				{
					status: 500,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// authz: public — the host's icon for directory listings.
		if (
			url.pathname === "/favicon.ico" &&
			(request.method === "GET" || request.method === "HEAD")
		) {
			return handleFavicon(hostname, env);
		}

		// Step 1: Handle .well-known routes
		// authz: public — OAuth/MCP discovery documents are spec-mandated unauthenticated.
		if (url.pathname.startsWith("/.well-known/")) {
			const wellKnownResponse = await handleWellKnown(url, hostname, env);
			if (wellKnownResponse) {
				return wellKnownResponse;
			}
		}

		// Step 2: Validate OAuth/auth for MCP routes
		const hasAuthHeader = request.headers.get("Authorization");
		const hasApiKeyHeader =
			request.headers.get("X-API-Key") || request.headers.get("x-api-key");
		const hasServiceBinding = isServiceBinding(request.headers);
		const hasAnyAuth = hasAuthHeader || hasApiKeyHeader || hasServiceBinding;

		const isMcpPath =
			url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");

		// Skill-run provenance the skill-runtime bridge asserts. Captured before the
		// strip below and re-set only for validated service-binding callers, so an
		// external caller cannot spoof it — memory_learn trusts x-tedix-skill-run-id
		// as a fact-source URI (`skill://runs/<id>`).
		let inboundSkillRunId: string | null = null;
		let inboundSkillId: string | null = null;
		let inboundWorkflowStepId: string | null = null;
		let inboundWorkflowStepName: string | null = null;
		let inboundWorkflowStepCount: string | null = null;
		let inboundWorkflowStepAttempt: string | null = null;
		let inboundWorkflowExecutionEpoch: string | null = null;
		let inboundWorkflowCallId: string | null = null;
		let inboundWorkflowIdempotencyKey: string | null = null;
		let inboundWorkflowTediTaskId: string | null = null;

		if (isMcpPath) {
			// Security: Unconditionally strip all inbound trust-asserting x-tedix-*
			// headers from every incoming MCP request — authenticated or not. This
			// prevents external callers from spoofing identity / skill-run provenance
			// on public (unauthenticated) apps. They are only re-set below after
			// successful validation: x-tedix-auth-* from the verified principal, and
			// x-tedix-skill-run-id / -skill-id only for trusted service-binding callers.
			inboundSkillRunId = request.headers.get("x-tedix-skill-run-id");
			inboundSkillId = request.headers.get("x-tedix-skill-id");
			inboundWorkflowStepId = request.headers.get("x-tedix-workflow-step-id");
			inboundWorkflowStepName = request.headers.get(
				"x-tedix-workflow-step-name",
			);
			inboundWorkflowStepCount = request.headers.get(
				"x-tedix-workflow-step-count",
			);
			inboundWorkflowStepAttempt = request.headers.get(
				"x-tedix-workflow-step-attempt",
			);
			inboundWorkflowExecutionEpoch = request.headers.get(
				"x-tedix-workflow-execution-epoch",
			);
			inboundWorkflowCallId = request.headers.get("x-tedix-workflow-call-id");
			inboundWorkflowTediTaskId = request.headers.get(
				"x-tedix-workflow-tedi-task-id",
			);
			inboundWorkflowIdempotencyKey =
				request.headers.get("idempotency-key") ??
				request.headers.get("x-idempotency-key");
			const incomingTrustHeaders = [...request.headers.keys()].filter(
				(k) =>
					k.startsWith("x-tedix-auth-") ||
					k === "x-tedix-skill-run-id" ||
					k === "x-tedix-skill-id" ||
					k.startsWith("x-tedix-workflow-"),
			);
			if (incomingTrustHeaders.length > 0) {
				const stripped = new Headers(request.headers);
				for (const h of incomingTrustHeaders) stripped.delete(h);
				request = new Request(request, { headers: stripped });
			}
		}

		// Security: strip the shared trust-header deny-list on every route, not
		// just `/mcp`. The narrow strip above covers only `x-tedix-auth-*`,
		// skill-run and workflow markers; `X-Service-Binding`, `X-Tedix-Org-Id`,
		// `X-Tedix-Tedi-Id`, `X-Tedix-Tedi-Scopes`, `X-Tedix-Caller-Type`,
		// `x-tedix-external-agent-*` and the rest of INTERNAL_TRUST_HEADERS must
		// not stay forwardable anywhere. This is the invariant the
		// platform-operator cross-org grant in
		// `cognitive-runtime/events-policy.ts` rests on; why the gap was inert
		// but one refactor from a cross-tenant authority grant:
		// `docs/engineering/mcp/runtime.md`.
		//
		// Additive by construction: a genuine service-binding request is left
		// untouched (the helper returns early), preserving today's behavior for
		// internal hops, while every external request is stripped on every path.
		if (!hasServiceBinding) {
			const hygienic = new Headers(request.headers);
			const before = [...hygienic.keys()].length;
			applyInboundTrustHeaderHygiene(hygienic, false);
			if ([...hygienic.keys()].length !== before) {
				request = new Request(request, { headers: hygienic });
			}
		}

		// Extract app information from hostname (needed for early app resolution below)
		const hostnameInfo = extractAppFromHostname(hostname, env);

		// Resolve app early (Worker-level cache hit ~0ms) so proxy targets can
		// validate against the exact resource audience recorded on their app row.
		let earlyResolvedApp: ResolvedApp | null = null;
		let earlyAuthMode: string | undefined;
		let oauthJwtPayload: Record<string, unknown> | undefined;
		let multiOrgSelection: MultiOrgMcpSelection | null = null;
		// Content-free auth stage timing, logged once for a human principal:
		// fixed stage names and durations only.
		const authStages: Record<string, number> = {};
		let authLast = Date.now();
		const authStarted = authLast;
		const markAuth = (stage: string) => {
			const now = Date.now();
			authStages[`${stage}_ms`] = now - authLast;
			authLast = now;
		};
		if (
			isMcpPath &&
			hasAnyAuth &&
			(hostnameInfo.type === "subdomain" || hostnameInfo.type === "custom")
		) {
			try {
				earlyResolvedApp = await resolveAppFromHostname(hostnameInfo, env);
				markAuth("resolve");
				earlyAuthMode = earlyResolvedApp?.metadata?.mcpConfig?.authMode as
					| string
					| undefined;
			} catch {
				// Non-fatal — full resolution below will surface the error
			}
		}

		if (isMcpPath && hasAnyAuth) {
			const trustedBrowserBridge = isTrustedBrowserBridge(request.headers);
			if (!hasAuthHeader && hasApiKeyHeader) {
				const apiKey = hasApiKeyHeader;
				const headers = new Headers(request.headers);
				headers.set("Authorization", `Bearer ${apiKey}`);
				headers.delete("X-API-Key");
				request = new Request(request.url, {
					method: request.method,
					headers,
					body: request.body,
					// @ts-expect-error — duplex needed for streaming body in Workers
					duplex: "half",
				});
			}

			// The credential transport header cannot exempt a human OAuth grant
			// from its exact resource audience or live consent checks.
			const expectedAudience = trustedBrowserBridge
				? undefined
				: resolveMcpExpectedAudience({
						hostname,
						authMode: earlyAuthMode,
						configuredAudience:
							earlyResolvedApp?.metadata?.mcpConfig?.expectedAudience,
					});
			if (!trustedBrowserBridge && !expectedAudience) {
				if (earlyResolvedApp) {
					await recordMcpAccessDenial({
						request,
						resolvedApp: earlyResolvedApp,
						env,
						ctx,
						reason: "oauth_audience_not_configured",
						httpStatus: 503,
					});
				}
				return new Response(
					JSON.stringify({
						error: "oauth_audience_not_configured",
						message:
							"This proxy-target MCP server has no configured OAuth audience.",
					}),
					{ status: 503, headers: { "Content-Type": "application/json" } },
				);
			}
			const authResult = await validateAuth(request, env, {
				hostname,
				expectedAudience: expectedAudience ?? undefined,
				mcpServerId:
					typeof earlyResolvedApp?.metadata?.mcpConfig?.descopeResourceId ===
					"string"
						? earlyResolvedApp.metadata.mcpConfig.descopeResourceId
						: undefined,
			});
			markAuth("token");

			if (authResult instanceof Response) {
				if (earlyResolvedApp) {
					await recordMcpAccessDenial({
						request,
						resolvedApp: earlyResolvedApp,
						env,
						ctx,
						reason: "authentication_failed",
						httpStatus: authResult.status,
					});
				}
				return authResult;
			}

			if (authResult) {
				const headers = new Headers(request.headers);
				headers.set("x-tedix-auth-type", authResult.type);
				if (authResult.type === "delegated-mcp") {
					// The signed Home dispatch ceiling is the only scope source on this
					// request. Do not enter the AIH branch that rehydrates the full tedi
					// profile from D1, or accept inbound identity headers.
					const liveTedi = await resolveTediProfileAuth(
						env,
						authResult.claims.tediId,
					);
					if (liveTedi.status !== "active") {
						return tediProfileFailureResponse(liveTedi, "delegated-mcp");
					}
					if (liveTedi.orgId !== authResult.claims.organizationId) {
						return new Response(
							JSON.stringify({ error: "delegated_tenant_mismatch" }),
							{
								status: 403,
								headers: { "Content-Type": "application/json" },
							},
						);
					}
					headers.set("x-tedix-auth-type", "tedi");
					headers.set("x-tedix-auth-credential-mode", "delegated-mcp");
					headers.set("x-tedix-auth-request-run-id", authResult.claims.runId);
					headers.set(
						"x-tedix-auth-request-root-run-id",
						authResult.claims.homeRunId,
					);
					headers.set(
						"x-tedix-auth-request-work-item-id",
						authResult.claims.workItemId,
					);
					if (liveTedi.mcpEndpoints !== undefined)
						headers.set(
							"x-tedix-auth-mcp-endpoints",
							JSON.stringify(liveTedi.mcpEndpoints),
						);
					headers.set("x-tedix-auth-tedi-id", authResult.claims.tediId);
					headers.set("x-tedix-auth-user-id", authResult.claims.tediId);
					headers.set("x-tedix-auth-org-id", authResult.claims.organizationId);
					headers.set(
						"x-tedix-auth-scopes",
						authResult.claims.scopes.join(" "),
					);
				} else if (authResult.type === "service-binding") {
					// Internal service-binding caller (skill-runtime, internal Workers).
					// Propagate identity from the X-Tedix-* headers the caller set,
					// and signal "service" auth-type to the McpServer factory so
					// callers like skill-runtime bypass Code Mode and get individual
					// tools instead of the collapsed `code` tool.
					headers.set("x-tedix-auth-type", "service");
					if (authResult.userId) {
						headers.set("x-tedix-auth-user-id", authResult.userId);
					}
					// Only an explicit X-Tedix-Tedi-Id makes the caller a tedi.
					// authResult.userId may instead be X-Tedix-Acting-User (Home
					// kernel direct reads); conflating it into tediId forced every
					// kernel call down the tedi credential path, where
					// fetchTediToken 400s on a non-tedi id and the user-credential
					// leg always failed. For tedi callers userId === X-Tedix-Tedi-Id
					// so this is behavior-identical for them.
					{
						const callerTediId = request.headers.get("X-Tedix-Tedi-Id");
						if (callerTediId) {
							headers.set("x-tedix-auth-tedi-id", callerTediId);
						}
					}
					// Kernel marker → kernel audit actor. Propagated the
					// same way as acting-user/tedi-id: the incoming x-tedix-auth-*
					// namespace is unconditionally stripped above, so this header can
					// only originate from validateAuth's authenticated service-binding
					// result (apps/api kernel sent X-Tedix-Kernel), never
					// from an external caller.
					if (authResult.kernel) {
						headers.set("x-tedix-auth-kernel", "true");
						if (authResult.approvedFactoryRequestId)
							headers.set(
								"x-tedix-auth-approved-factory-request",
								authResult.approvedFactoryRequestId,
							);
						if (authResult.approvedWorkResponderUserId)
							headers.set(
								"x-tedix-auth-approved-work-responder",
								authResult.approvedWorkResponderUserId,
							);
					}
					if (authResult.organizationId)
						headers.set("x-tedix-auth-org-id", authResult.organizationId);
					if (authResult.scopes && authResult.scopes.length > 0)
						headers.set("x-tedix-auth-scopes", authResult.scopes.join(" "));
					// Skill-run provenance: re-assert only for trusted service-binding
					// callers (the skill-runtime bridge). Stripped from the inbound
					// request above, so an external caller cannot spoof a victim's
					// skill-run-id (which memory_learn trusts as a fact-source URI).
					if (inboundSkillRunId) {
						headers.set("x-tedix-skill-run-id", inboundSkillRunId);
					}
					if (inboundSkillId) {
						headers.set("x-tedix-skill-id", inboundSkillId);
					}
					if (inboundWorkflowStepId) {
						headers.set("x-tedix-workflow-step-id", inboundWorkflowStepId);
					}
					if (inboundWorkflowStepName) {
						headers.set("x-tedix-workflow-step-name", inboundWorkflowStepName);
					}
					if (inboundWorkflowStepCount) {
						headers.set(
							"x-tedix-workflow-step-count",
							inboundWorkflowStepCount,
						);
					}
					if (inboundWorkflowStepAttempt) {
						headers.set(
							"x-tedix-workflow-step-attempt",
							inboundWorkflowStepAttempt,
						);
					}
					if (inboundWorkflowExecutionEpoch) {
						headers.set(
							"x-tedix-workflow-execution-epoch",
							inboundWorkflowExecutionEpoch,
						);
					}
					if (inboundWorkflowCallId) {
						headers.set("x-tedix-workflow-call-id", inboundWorkflowCallId);
					}
					if (inboundWorkflowIdempotencyKey) {
						headers.set(
							"x-tedix-workflow-idempotency-key",
							inboundWorkflowIdempotencyKey,
						);
					}
				} else if (authResult.type === "oauth") {
					if (authResult.userId)
						headers.set("x-tedix-auth-user-id", authResult.userId);
					if (authResult.organizationId)
						headers.set("x-tedix-auth-org-id", authResult.organizationId);
					if (authResult.email)
						headers.set("x-tedix-auth-email", authResult.email);
					if (authResult.clientId)
						headers.set("x-tedix-auth-client-id", authResult.clientId);
					// Hoist JWT payload so tenant-match enforcement (below, outside this
					// block's scope) can access it without a ReferenceError.
					oauthJwtPayload = authResult.payload as Record<string, unknown>;
					const jwtPayload = authResult.payload as Record<string, unknown>;
					const mcpServerId = earlyResolvedApp?.metadata?.mcpConfig
						?.descopeResourceId as string | undefined;
					let aihM2mTediProfileAuth: TediProfileAuth | null = null;
					const aihM2mClient = mcpServerId
						? await resolveAihM2mClientScopeContext(
								env,
								jwtPayload,
								mcpServerId,
								{
									bearerToken:
										request.headers
											.get("Authorization")
											?.match(/^Bearer\s+(.+)$/i)?.[1] ??
										request.headers.get("X-API-Key") ??
										undefined,
									// Defense in depth (audit CC-2): bound a tedi client's
									// baked registration scopes to its current live D1
									// capability profile at request time, so a stale-broad
									// Descope client credential — e.g. a capability downgrade
									// that has not yet propagated to the client registration —
									// can never exceed the tedi's live profile. Resolved fresh
									// (uncached) and reused below for the scope header.
									resolveTediProfileScopes: async (tediId) => {
										aihM2mTediProfileAuth = await resolveTediProfileAuth(
											env,
											tediId,
										);
										// A tedi without live authority gets no scopes; the
										// request is answered with its failure response below.
										return aihM2mTediProfileAuth.status === "active"
											? aihM2mTediProfileAuth.scopes
											: [];
									},
								},
							)
						: null;
					if (authResult.m2mAudience)
						recordM2mTokenAudience(env, {
							audit: authResult.m2mAudience,
							payload: jwtPayload,
							clientResolved: aihM2mClient !== null,
							mcpServerId,
							appId: earlyResolvedApp?.app.id,
							appSlug: earlyResolvedApp?.app.slug,
						});
					markAuth("client");
					const { claims: tediClaims, error: tediClaimError } =
						extractTediJwtClaims(authResult.payload);

					if (tediClaimError) {
						console.warn(`[MCP Auth] ${tediClaimError}`);
					}

					if (
						!tediClaims &&
						!aihM2mClient &&
						!trustedBrowserBridge &&
						authResult.localDemo !== true
					) {
						const config = earlyResolvedApp?.metadata?.mcpConfig;
						if (!mcpServerId || !expectedAudience)
							return new Response(
								JSON.stringify({ error: "human_mcp_resource_not_configured" }),
								{
									status: 503,
									headers: { "Content-Type": "application/json" },
								},
							);
						const resolved = await resolveHumanMcpSelection(
							authResult.payload,
							env,
							{
								audience: expectedAudience,
								mcpServerId,
								multiOrganization: config?.multiOrgConsent === true,
							},
						);
						markAuth("grant");
						if (!resolved.ok) return humanMcpGrantFailureResponse(resolved);
						const selection = resolved.selection;
						if (config?.multiOrgConsent === true) multiOrgSelection = selection;
						else if (
							selection.organizations.length !== 1 ||
							selection.organizations[0]?.organizationId !==
								earlyResolvedApp?.app.organizationId
						)
							return new Response(
								JSON.stringify({ error: "human_mcp_tenant_mismatch" }),
								{
									status: 403,
									headers: { "Content-Type": "application/json" },
								},
							);
					}
					if (tediClaims) {
						// First-class tedi identity: access key → JWT exchange.
						// Requires explicit top-level claims: tediId, entityType, descopeUserId.
						// Resolve capability profile + real org ID from D1 via API service binding.
						headers.set("x-tedix-auth-tedi-id", tediClaims.tediId);
						headers.set("x-tedix-auth-user-id", tediClaims.descopeUserId);
						headers.set("x-tedix-auth-type", "tedi");
						headers.set("x-tedix-auth-credential-mode", "direct-tedi-jwt");
						const directTediAuth = await resolveTediProfileAuth(
							env,
							tediClaims.tediId,
						);
						if (directTediAuth.status !== "active") {
							return tediProfileFailureResponse(
								directTediAuth,
								"direct-tedi-jwt",
							);
						}
						// Override Descope tenant ID (e.g. "org_tedix") with real D1 org
						// UUID. Without this, tedi-originated calls query the wrong org.
						if (directTediAuth.orgId) {
							headers.set("x-tedix-auth-org-id", directTediAuth.orgId);
						}
						headers.set("x-tedix-auth-scopes", directTediAuth.scopes.join(" "));
						if (directTediAuth.mcpEndpoints !== undefined)
							headers.set(
								"x-tedix-auth-mcp-endpoints",
								JSON.stringify(directTediAuth.mcpEndpoints),
							);
					} else if (aihM2mClient) {
						// Descope AIH client-credentials tokens identify the registered
						// MCP client but do not currently include its scopes as JWT
						// claims. The registered client remains the authority for tedi
						// M2M callers, so hydrate scopes from the verified AIH client.
						headers.set("x-tedix-auth-credential-mode", "aih-m2m");
						if (aihM2mClient.clientId) {
							headers.set("x-tedix-auth-client-id", aihM2mClient.clientId);
						}
						if (aihM2mClient.externalAgent) {
							const validationStartedAt = performance.now();
							let externalAgent: Awaited<
								ReturnType<typeof resolveExternalAgentSessionAuth>
							>;
							try {
								externalAgent = await resolveExternalAgentSessionAuth(
									env,
									aihM2mClient.externalAgent,
									aihM2mClient.clientRecordId,
									aihM2mClient.scopes,
								);
							} catch (error) {
								recordExternalAgentValidation({
									env,
									appId: earlyResolvedApp?.app.id,
									appSlug: earlyResolvedApp?.app.slug,
									organizationId: aihM2mClient.externalAgent.organizationId,
									durationMs: performance.now() - validationStartedAt,
									error,
								});
								return externalAgentValidationFailureResponse(error);
							}
							recordExternalAgentValidation({
								env,
								appId: earlyResolvedApp?.app.id,
								appSlug: earlyResolvedApp?.app.slug,
								organizationId: externalAgent.principal.organizationId,
								durationMs: performance.now() - validationStartedAt,
							});
							headers.delete("x-tedix-auth-user-id");
							headers.delete("x-tedix-auth-tedi-id");
							headers.set("x-tedix-auth-type", "external_agent");
							headers.set(
								"x-tedix-auth-org-id",
								externalAgent.principal.organizationId,
							);
							headers.set(
								"x-tedix-auth-external-principal-id",
								externalAgent.principal.id,
							);
							headers.set(
								"x-tedix-auth-external-session-id",
								externalAgent.session.id,
							);
							headers.set(
								"x-tedix-auth-external-client-record-id",
								aihM2mClient.clientRecordId,
							);
							headers.set(
								"x-tedix-auth-external-harness",
								externalAgent.session.harness,
							);
							headers.set(
								"x-tedix-auth-external-model",
								`${externalAgent.session.modelProvider}:${externalAgent.session.modelId}:${externalAgent.session.modelVersion}`,
							);
							headers.set(
								"x-tedix-auth-scopes",
								externalAgent.scopes.join(" "),
							);
						} else {
							headers.set("x-tedix-auth-type", "tedi");
							headers.set("x-tedix-auth-user-id", aihM2mClient.clientRecordId);
						}
						const tediTag = aihM2mClient.tags.find((tag) =>
							tag.startsWith("tedi:"),
						);
						const m2mTediId = tediTag ? tediTag.slice(5) : null;
						if (!aihM2mClient.externalAgent && m2mTediId) {
							const liveM2mTediAuth =
								aihM2mTediProfileAuth ??
								(await resolveTediProfileAuth(env, m2mTediId));
							if (liveM2mTediAuth.status !== "active") {
								return tediProfileFailureResponse(liveM2mTediAuth, "aih-m2m");
							}
							const organizationId = resolveAihM2mTediOrganizationId({
								liveOrganizationId: liveM2mTediAuth.orgId,
								servedAppOrganizationId: earlyResolvedApp?.app.organizationId,
							});
							if (organizationId) {
								headers.set("x-tedix-auth-org-id", organizationId);
							} else {
								// Never retain the platform Descope tenant from the M2M JWT as
								// customer data authority when neither trusted source resolved.
								headers.delete("x-tedix-auth-org-id");
							}
							headers.set("x-tedix-auth-tedi-id", m2mTediId);
							if (liveM2mTediAuth.mcpEndpoints !== undefined)
								headers.set(
									"x-tedix-auth-mcp-endpoints",
									JSON.stringify(liveM2mTediAuth.mcpEndpoints),
								);
						}
						// A tedi M2M grant is bound to this exact AIH server. Its effective
						// scopes are the intersection of the registered client's scopes
						// and the current D1 capability profile, resolved during hydration.
						// External agents already carry their live principal ceiling above.
						if (!aihM2mClient.externalAgent)
							headers.set("x-tedix-auth-scopes", aihM2mClient.scopes.join(" "));
					} else if (authResult.scopes) {
						// Human OAuth token — scopes come from AIH policy
						headers.set("x-tedix-auth-scopes", authResult.scopes.join(" "));
						const tediId =
							typeof jwtPayload?.tediId === "string"
								? jwtPayload.tediId
								: undefined;
						if (tediId) {
							headers.set("x-tedix-auth-tedi-id", tediId);
						}
					}
					// Note: human callers (no tediId in token) get resolved later
					// after app resolution provides the organizationId
				}
				reassertTrustedWorkflowTediTaskId(
					headers,
					inboundWorkflowTediTaskId,
					authResult.type,
				);
				request = new Request(request, { headers });
			}
		}

		// Step 3: Hostname-based routing
		if (isDev) {
			console.log(
				`[MCP Router] Hostname: ${hostname}, Type: ${hostnameInfo.type}, AppSlug: ${hostnameInfo.appSlug ?? "none"}`,
			);
		}

		// Both subdomain and custom domain routes share identical auth enforcement:
		// 1. authMode check (~line 411) — requires auth if mcpConfig.authMode === "authenticated"
		// 2. toolScopes / enforcePolicies (~line 442) — per-tool scope checking
		// 3. Rate limiting (~line 507)
		// Custom domains only differ in resolution path (two API calls vs one).
		if (hostnameInfo.type === "subdomain" || hostnameInfo.type === "custom") {
			if (isDev && request.method === "GET" && url.pathname === "/mcp") {
				const accept = request.headers.get("accept") ?? "none";
				console.log(`[MCP Router] GET /mcp headers: accept=${accept}`);
			}
			let resolvedApp: ResolvedApp | null;
			try {
				resolvedApp =
					earlyResolvedApp ?? (await resolveAppFromHostname(hostnameInfo, env));
				earlyResolvedApp = null; // allow GC
			} catch (error) {
				// Transient apps/api unavailability (warming 5xx / dropped service
				// binding) → 503 + Retry-After so clients retry, not a bare 502.
				if (isRetryableUpstreamError(error)) {
					log.warn("App resolution upstream unavailable", {
						event: "resolution.route_upstream_unavailable",
						outcome: "unavailable",
						error: contentFreeMcpException(error),
					});
					return upstreamUnavailableResponse();
				}
				log.error("App resolution failed", {
					event: "resolution.route_lookup_failed",
					outcome: "unavailable",
					error: contentFreeMcpException(error),
				});
				return new Response(
					JSON.stringify({
						error: "Upstream error",
						message: "Failed to resolve app.",
					}),
					{ status: 502, headers: { "Content-Type": "application/json" } },
				);
			}
			if (isDev) {
				console.log(
					`[MCP Router] Subdomain routing - App resolved: ${resolvedApp?.app?.slug ?? "NOT FOUND"}`,
				);
			}

			if (!resolvedApp) {
				return new Response(
					JSON.stringify({
						error: "App not found",
						message:
							hostnameInfo.type === "subdomain"
								? `No app found for subdomain: ${hostnameInfo.appSlug}`
								: `No app found for domain: ${hostnameInfo.customDomain}`,
					}),
					{
						status: 404,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			const { app } = resolvedApp;

			if (app.visibility === "disabled") {
				await recordMcpAccessDenial({
					request,
					resolvedApp,
					env,
					ctx,
					reason: "app_disabled",
					httpStatus: 404,
				});
				return new Response(
					JSON.stringify({
						error: "App disabled",
						message: "This MCP app is disabled.",
					}),
					{ status: 404, headers: { "Content-Type": "application/json" } },
				);
			}

			if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
				const accessError = await enforceMcpAccess({
					request,
					hostname,
					resolvedApp,
					env,
					oauthJwtPayload,
					multiOrgSelection,
					isDev,
				});
				if (accessError) {
					await recordMcpAccessDenial({
						request,
						resolvedApp,
						env,
						ctx,
						reason: accessError.reason,
						httpStatus: accessError.response.status,
					});
					return accessError.response;
				}
			}

			// Rate limit
			const { allowed } = await checkMcpRequestRateLimit(
				env,
				app.id,
				request.headers,
				clientIp,
			);
			if (!allowed) {
				await recordMcpAccessDenial({
					request,
					resolvedApp,
					env,
					ctx,
					reason: "rate_limited",
					httpStatus: 429,
				});
				return rateLimitResponse();
			}

			// Resolve tediId for human callers (no tediId in JWT, org known from app).
			//
			// By default a human OAuth caller is promoted to their org's primary (or
			// fallback org-scoped) tedi, so they act as that worker (delegationMode
			// "human_to_tedi", demoted to subjectUserId). Set mcpConfig.bindHumanToTedi
			// = false to keep the human as the principal instead: actorType stays
			// "user", scopes come from their own OAuth/FGA grant, and audit attributes
			// to the human — the conventional MCP-OAuth model. This only affects human
			// OAuth callers; autonomous tedi M2M callers already carry
			// x-tedix-auth-tedi-id and never enter this block.
			const appMcpConfig = app.metadata?.mcpConfig as
				| Record<string, unknown>
				| undefined;
			const bindHumanToTedi = shouldBindHumanToTedi(
				appMcpConfig,
				multiOrgSelection,
				{
					// Set only from validateAuth's service-binding result; the
					// inbound x-tedix-auth-* namespace is stripped above.
					kernel:
						request.headers.get("x-tedix-auth-type") === "service" &&
						request.headers.get("x-tedix-auth-kernel") === "true",
				},
			);
			if (
				bindHumanToTedi &&
				!request.headers.get("x-tedix-auth-tedi-id") &&
				request.headers.get("x-tedix-auth-user-id") &&
				app.organizationId &&
				env.API_SERVICE
			) {
				const resolvedTediId = await resolvePrimaryTedi(
					env,
					request.headers.get("x-tedix-auth-user-id")!,
					app.organizationId,
				);
				if (resolvedTediId) {
					const headers = new Headers(request.headers);
					headers.set("x-tedix-auth-tedi-id", resolvedTediId);
					request = new Request(request, { headers });
					console.log(`[MCP Auth] Resolved user→tedi: ${resolvedTediId}`);
				} else {
					console.warn(
						`[MCP Auth] Failed to resolve tediId for user=${request.headers.get("x-tedix-auth-user-id")} org=${app.organizationId}`,
					);
				}
			} else if (
				!bindHumanToTedi &&
				!request.headers.get("x-tedix-auth-tedi-id") &&
				request.headers.get("x-tedix-auth-user-id")
			) {
				console.log(
					`[MCP Auth] Human principal (bindHumanToTedi=false): user=${request.headers.get("x-tedix-auth-user-id")} acts as themselves on ${app.slug}`,
				);
				markAuth("access");
				console.log(
					JSON.stringify({
						_tr: "mcp_auth_timing",
						total_ms: Date.now() - authStarted,
						...authStages,
					}),
				);
			}

			// Headless widget preview (after auth + rate limiting)
			if (url.pathname === "/_preview") {
				return handlePreviewRequest(request, url, app, env);
			}

			// Streamable HTTP security: validate browser Origin on MCP endpoint requests.
			if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
				const originError = validateMcpOrigin(request, env, resolvedApp);
				if (originError) {
					await recordMcpAccessDenial({
						request,
						resolvedApp,
						env,
						ctx,
						reason: originError.reason,
						httpStatus: originError.response.status,
					});
					return originError.response;
				}
			}

			// Route to MCP
			if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
				if (isDev) {
					console.log(
						`[MCP Router] >>> Stateless MCP for app: ${app.slug} (${app.id})`,
					);
				}

				const subscriptionResponse = await maybeHandleSubscriptionsListen(
					request,
					resolvedApp,
					env,
				);
				if (subscriptionResponse) return subscriptionResponse;

				try {
					const bootstrapFastResponse = await maybeHandleBootstrapFastMcp(
						request,
						resolvedApp,
					);
					if (bootstrapFastResponse) {
						return recordProtocolDenialIfPresent({
							request,
							response: bootstrapFastResponse,
							resolvedApp,
							env,
							ctx,
						});
					}
					return recordProtocolDenialIfPresent({
						request,
						response: await handleMcpRequest(
							request,
							resolvedApp,
							env,
							ctx,
							multiOrgSelection,
						),
						resolvedApp,
						env,
						ctx,
					});
				} catch (error) {
					// handleMcpRequest → getAppContext / aggregate can throw on a
					// transient apps/api drop; without this guard it escapes as an
					// uncaught Worker 500. Map transient → 503 + Retry-After.
					if (isRetryableUpstreamError(error)) {
						log.warn("MCP request upstream unavailable", {
							event: "router.request_upstream_unavailable",
							outcome: "unavailable",
							error: contentFreeMcpException(error),
						});
						return upstreamUnavailableResponse();
					}
					throw error;
				}
			}

			return honoApp.fetch(request, env, ctx);
		}

		// Step 4: Base domain handling
		if (hostnameInfo.type === "base_domain") {
			const isMcpRoute =
				url.pathname === "/mcp" || url.pathname.startsWith("/mcp/");

			if (!isMcpRoute) {
				return honoApp.fetch(request, env, ctx);
			}

			try {
				const client = getApiClient({
					serviceFetch: env.API_SERVICE,
				});
				const domainResult = await client.apps.getByDomain({
					domain: hostname,
				});

				if (domainResult.app) {
					if (isDev) {
						console.log(
							`[MCP Router] Base domain ${hostname} is registered as customMcpDomain for app: ${domainResult.app.slug}`,
						);
					}

					let fullResult: Awaited<
						ReturnType<typeof client.apps.getBySlugWithTools>
					>;
					try {
						fullResult = await client.apps.getBySlugWithTools({
							slug: domainResult.app.slug,
						});
					} catch (error) {
						log.error("Custom domain app metadata load failed", {
							event: "router.custom_domain_metadata_failed",
							serverHost: hostname,
							appSlug: domainResult.app.slug,
							outcome: "unavailable",
							error,
						});
						if (isRetryableUpstreamError(error)) {
							return upstreamUnavailableResponse();
						}
						return new Response(
							JSON.stringify({
								error: "Upstream error",
								message: "Failed to resolve custom MCP domain app metadata.",
							}),
							{ status: 502, headers: { "Content-Type": "application/json" } },
						);
					}
					const fullApp = fullResult.app;
					if (!fullApp) {
						log.error("Custom domain app metadata missing", {
							event: "router.custom_domain_metadata_missing",
							serverHost: hostname,
							appSlug: domainResult.app.slug,
							outcome: "misconfigured",
						});
						return new Response(
							JSON.stringify({
								error: "Upstream error",
								message: "Failed to resolve custom MCP domain app metadata.",
							}),
							{ status: 502, headers: { "Content-Type": "application/json" } },
						);
					}
					const metadata =
						(fullApp?.metadata as ResolvedApp["metadata"] | null) ?? null;

					const resolvedApp: ResolvedApp = {
						app: {
							id: fullApp.id,
							slug: fullApp.slug,
							name: fullApp.name,
							domain: fullApp.primaryDomain,
							organizationId: fullApp.organizationId,
							description: fullApp.description ?? null,
							logoUrl: fullApp.logoUrl ?? null,
							customMcpDomain: fullApp.customMcpDomain ?? null,
							openaiChallengeToken: fullApp.openaiChallengeToken ?? null,
							openaiAppId: fullApp.openaiAppId ?? null,
							appStoreStatus: fullApp.appStoreStatus ?? null,
							visibility: fullApp.visibility,
							discoveryStatus: fullApp.discoveryStatus ?? null,
							metadata,
						},
						metadata,
						tools: fullResult.tools ?? [],
						catalogMcp: fullResult.catalogMcp ?? null,
						catalogResources: fullResult.catalogResources ?? [],
						catalogResourceTemplates: fullResult.catalogResourceTemplates ?? [],
						catalogPrompts: fullResult.catalogPrompts ?? [],
					};

					const accessError = await enforceMcpAccess({
						request,
						hostname,
						resolvedApp,
						env,
						oauthJwtPayload,
						multiOrgSelection,
						isDev,
					});
					if (accessError) {
						await recordMcpAccessDenial({
							request,
							resolvedApp,
							env,
							ctx,
							reason: accessError.reason,
							httpStatus: accessError.response.status,
						});
						return accessError.response;
					}

					const { allowed } = await checkMcpRequestRateLimit(
						env,
						resolvedApp.app.id,
						request.headers,
						clientIp,
					);
					if (!allowed) {
						await recordMcpAccessDenial({
							request,
							resolvedApp,
							env,
							ctx,
							reason: "rate_limited",
							httpStatus: 429,
						});
						return rateLimitResponse();
					}

					const originError = validateMcpOrigin(request, env, resolvedApp);
					if (originError) {
						await recordMcpAccessDenial({
							request,
							resolvedApp,
							env,
							ctx,
							reason: originError.reason,
							httpStatus: originError.response.status,
						});
						return originError.response;
					}
					return recordProtocolDenialIfPresent({
						request,
						response: await handleMcpRequest(
							request,
							resolvedApp,
							env,
							ctx,
							multiOrgSelection,
						),
						resolvedApp,
						env,
						ctx,
					});
				}
			} catch (error) {
				log.error("Custom domain lookup failed", {
					event: "router.custom_domain_lookup_failed",
					serverHost: hostname,
					outcome: "unavailable",
					error,
				});
				// A transient apps/api drop here would otherwise silently fall through
				// to the dev fallback; surface it honestly as 503 + Retry-After.
				if (isRetryableUpstreamError(error)) {
					return upstreamUnavailableResponse();
				}
			}

			// Local dev fallback
			const defaultAppSlug = env.DEFAULT_APP_SLUG;

			if (defaultAppSlug) {
				if (isDev) {
					console.log(
						`[MCP Router] Base domain with DEFAULT_APP_SLUG fallback: ${defaultAppSlug}`,
					);
				}

				try {
					const client = getApiClient({
						serviceFetch: env.API_SERVICE,
					});
					const result = await client.apps.getBySlugWithTools({
						slug: defaultAppSlug,
					});

					if (result.app) {
						if (isDev) {
							console.log(
								`[MCP Router] >>> Stateless MCP for default app: ${result.app.slug} (${result.app.id})`,
							);
						}

						const resolvedApp: ResolvedApp = {
							app: {
								id: result.app.id,
								slug: result.app.slug,
								name: result.app.name,
								domain: result.app.primaryDomain,
								organizationId: result.app.organizationId,
								visibility: result.app.visibility,
							},
							metadata: (result.app.metadata as any) ?? null,
							tools: result.tools ?? [],
						};

						const accessError = await enforceMcpAccess({
							request,
							hostname,
							resolvedApp,
							env,
							oauthJwtPayload,
							multiOrgSelection,
							isDev,
						});
						if (accessError) {
							await recordMcpAccessDenial({
								request,
								resolvedApp,
								env,
								ctx,
								reason: accessError.reason,
								httpStatus: accessError.response.status,
							});
							return accessError.response;
						}

						const { allowed } = await checkMcpRequestRateLimit(
							env,
							result.app.id,
							request.headers,
							clientIp,
						);
						if (!allowed) {
							await recordMcpAccessDenial({
								request,
								resolvedApp,
								env,
								ctx,
								reason: "rate_limited",
								httpStatus: 429,
							});
							return rateLimitResponse();
						}

						const originError = validateMcpOrigin(request, env, resolvedApp);
						if (originError) {
							await recordMcpAccessDenial({
								request,
								resolvedApp,
								env,
								ctx,
								reason: originError.reason,
								httpStatus: originError.response.status,
							});
							return originError.response;
						}
						return recordProtocolDenialIfPresent({
							request,
							response: await handleMcpRequest(
								request,
								resolvedApp,
								env,
								ctx,
								multiOrgSelection,
							),
							resolvedApp,
							env,
							ctx,
						});
					}
				} catch (error) {
					log.error("Default app lookup failed", {
						event: "router.default_app_lookup_failed",
						appSlug: defaultAppSlug,
						outcome: "unavailable",
						error,
					});
					if (isRetryableUpstreamError(error)) {
						return upstreamUnavailableResponse();
					}
				}
				if (isDev) {
					console.log(
						`[MCP Router] DEFAULT_APP_SLUG '${defaultAppSlug}' not found in database`,
					);
				}
			}

			if (isDev) {
				console.log(
					`[MCP Router] Base domain access rejected - subdomain required`,
				);
			}

			if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
				return new Response(
					JSON.stringify({
						error: "App subdomain required",
						message:
							"All MCP access requires an app subdomain. Use {app}.mcp.tedix.dev format.",
						example: "tedix.mcp.tedix.dev/mcp",
						hint: "For local development, set DEFAULT_APP_SLUG=tedix in wrangler.jsonc vars or use X-Tedix-Host header",
					}),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}

		// Step 5: All other requests
		return honoApp.fetch(request, env, ctx);
	},
};

/**
 * Service-binding ingress. Internal callers bind with
 * `"entrypoint": "InternalEntrypoint"`; the internet reaches only the default
 * export, which strips the `X-Service-Binding` marker, so binding trust is
 * unreachable from a public request.
 */
export class InternalEntrypoint extends WorkerEntrypoint<CloudflareEnv> {
	override async fetch(request: Request): Promise<Response> {
		return fetchWithCorrelation(request, this.env, this.ctx);
	}
}

async function fetchWithCorrelation(
	request: Request,
	env: CloudflareEnv,
	ctx: ExecutionContext,
): Promise<Response> {
	const traceId = requestTraceId(request.headers);
	// The MCP handler owns SEP-414 body metadata; don't override it with a generated header.
	const response = await correlatedErrorResponse(
		await worker.fetch(request, env, ctx),
		traceId,
		false,
	);
	if (response.status >= 400)
		console.warn("[MCP] request failed", {
			event: "tedix.mcp.error",
			traceId: response.headers.get("X-Tedix-Trace-Id"),
			httpStatus: response.status,
		});
	return response;
}

export default {
	fetch(
		request: Request,
		env: CloudflareEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		return fetchWithCorrelation(stripServiceBindingMarker(request), env, ctx);
	},
};
