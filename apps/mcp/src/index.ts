import { createMcpServer } from "@tedix/mcp-shared/server";
import {
	buildBootstrapInfo,
	isConfiguredCatalogTool,
} from "./mcp/registration/bootstrap";
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
 * Policy-based scope extraction, ORG-wide aggregation, stateless MCP handler,
 * rate limiting, user -> TEDI resolution, HONO APP (non-MCP routes),
 * WORKFLOW exports, main fetch handler.
 *
 * Design rationale behind the caching, aggregation and trust-header behaviour
 * in this file: `docs/engineering/mcp/runtime.md` "Edge Design Record". Scoped operating
 * rules: `apps/mcp/AGENTS.md`.
 */

import {
	pruneExpiredCacheEntries,
	setBoundedExpiringCacheEntry,
} from "./lib/bounded-cache";
import { toolResponseTimeoutMs } from "./tool-response-timeout";
import {
	buildMcpAggregateCacheDataPoint,
	type McpAggregateCacheDataPointEvent,
} from "@tedix/api-contract/schemas/mcp-analytics";
import {
	resolveToolAnnotations,
	type ToolJsonSchema,
} from "@tedix/api-contract/schemas/tools";
import { extractTediJwtClaims } from "@tedix/auth/types";
import { isDelegatedWorkTool } from "@tedix/auth/delegated-mcp-token";
import { hasScope, toolToScope } from "@tedix/mcp-shared/auth/scopes";
import {
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_OAUTH_CLIENT_CREDENTIALS_EXTENSION,
	MCP_PROTOCOL_VERSION_HEADER,
	MCP_PROTOCOL_VERSION_META_KEY,
	MCP_SERVER_INFO_META_KEY,
	MCP_TASKS_EXTENSION,
} from "@tedix/mcp-shared/protocol";
import {
	extractMcpTraceMeta,
	resolveInboundTraceId,
	resolveInboundTracestate,
} from "@tedix/mcp-shared/trace-context";
import {
	DEFAULT_MCP_CACHE_HINT,
	type McpCompletionRequest,
	type McpCompletionResult,
	type McpDirectoryReadHandler,
	type McpResultTransform,
	mountMcp,
	validateModernProtocolHeaders,
} from "@tedix/mcp-shared/transport";
import { collectAdvertisedScopes } from "@tedix/mcp-shared/well-known/oauth";
import { CODE_MODE_TOOL_ANNOTATIONS } from "@tedix/mcp-shared/codemode";
import { installHonoErrorHandlers } from "@tedix/worker-kit/errors";
import {
	applyInboundTrustHeaderHygiene,
	isServiceBinding,
	stripServiceBindingMarker,
} from "@tedix/worker-kit/request-auth";
import { WorkerEntrypoint } from "cloudflare:workers";
import { Hono } from "hono";
import { codeModeSecurityMeta } from "./mcp/codemode-security";
import { cors } from "hono/cors";
import {
	interactionReplyEventDefinition,
	interactionEventTarget,
	interactionEventShard,
	InteractionEventError,
} from "./interaction-events";
import {
	organizationScopedRequest,
	resolveConnectOrganization,
	shouldBindHumanToTedi,
} from "./connect-organization";
import {
	buildWwwAuthenticate,
	extractRequiredScopes,
	invalidateAihM2mClientScopeCache,
	isTrustedBrowserBridge,
	resolveAihM2mClientScopeContext,
	resolveAihM2mTediOrganizationId,
	resolveExternalAgentSessionAuth,
	resolveMcpExpectedAudience,
	shouldEnforceMcpToolScopes,
	shouldEnforceTenantMatchForOAuth,
	validateAuth,
	validateHumanMcpSelection,
	type MultiOrgMcpSelection,
} from "./auth-helpers";
// Import from split modules
import { extractAppFromHostname, resolveRequestHostname } from "./hostname";
import { contentFreeMcpException, createMcpLogger } from "./log";
import {
	type ApiClient,
	getApiClient,
	getTediProfileApiClient,
} from "./lib/api-client";
import {
	CACHE_TIER_BUDGET_MS,
	StepBudgetExceededError,
	joinInFlightLoad,
	trackInFlightLoad,
	withStepBudget,
} from "./lib/step-budget";
import { jwtTenantMatchesApp } from "./lib/tenant-match";
import {
	resolveTediProfileAuth,
	tediProfileFailureResponse,
	type TediProfileAuth,
} from "./tedi-profile-auth";
import {
	aggregateAppNamespaceCandidates,
	aggregateTediNamespace,
	isOrganizationMountNamespace,
	mountedAppToolScopes,
	organizationAppNamespace,
	organizationMountToolScopes,
} from "./mcp/aggregate-namespaces";
import {
	buildAggregateTaskHandlers,
	hasAggregateTaskCapableTool,
	reassertTrustedWorkflowTediTaskId,
} from "./mcp/aggregate-task-handlers";
// Type-only static import: the value export `buildAggregateTediTools` is
// loaded dynamically at its single call site instead. That module tree
// (aggregate-tedis-*) materializes ~130 Zod→JSON-Schema conversions at module
// scope, and every one of them ran during Worker STARTUP — the deploy-time
// budget Cloudflare validates at 1s (error 10021). It is needed only when a
// request actually aggregates tedi surfaces, so it must not be on the startup
// path. Same reasoning as the `registerCodeModeTools` dynamic import.
import type { AggregateTediEntry } from "./mcp/aggregate-tedis";
import { shouldBypassCodeModeForCaller } from "./mcp/caller-identity";
import { buildAggregateCompletionHandler } from "./mcp/completions";
import {
	buildHomeSurfaceTools,
	removeProjectedKernelConversationLifecycleTools,
	shouldExposeHomeSurface,
} from "./mcp/home-surface";
import {
	ensurePlatformOperatorAggregateApps,
	PLATFORM_OPERATOR_ADMIN_APP_SLUG,
	PLATFORM_OPERATOR_CODE_MODE_NAMESPACES,
} from "./mcp/platform-operator-aggregation";
import {
	buildEdgeListCacheHints,
	buildMcpServer,
	buildServerContext,
	extractCallerIdentity,
	getAppContext,
} from "./mcp/server-factory";
import {
	isMcpToolVisibleToCaller,
	resolveMcpToolRequiredScopes,
	resolveMcpToolNamespace,
} from "@tedix/mcp-shared/auth/tool-scopes";
import { sortToolsDeterministically } from "./mcp/tools-list-order";
import {
	accountProfileTool,
	accountProfileResult,
	ACCOUNT_PROFILE_SECURITY,
	accountProfileEnabled,
} from "./mcp/registration/account-profile";
import { paginateSortedToolsList } from "./mcp/tools-list-pagination";
import { getAppsSDKCompatibleHtml } from "./mcp/utils/widget";
import { checkRateLimit } from "./middleware/rate-limit";
import { handlePreviewRequest } from "./preview";
import type { ResolvedApp } from "./resolution";
import {
	buildCorsOrigins,
	getCorsOrigins,
	purgeAppResolutionCacheKeys,
	resolveAppFromHostname,
} from "./resolution";
import {
	isRetryableUpstreamError,
	UPSTREAM_ATTEMPT_TIMEOUT_MS,
	upstreamUnavailableResponse,
} from "./upstream";
import { handleWellKnown } from "./well-known";
import { handleExternalAgentSessionExchange } from "./external-agent-session";
import {
	externalAgentValidationFailureResponse,
	recordExternalAgentValidation,
} from "./external-agent-validation";
import {
	recordMcpAccessDenial,
	recordProtocolDenialIfPresent,
	type McpAccessDenialReason,
} from "./mcp/security-decision";
import { isRecord } from "@tedix/api-contract/utils/is-record";

const log = createMcpLogger("mcp.router");

export { McpSubscriptionDurableObject } from "./subscriptions";

// =============================================================================
// policy-based scope extraction
// =============================================================================

/**
 * Extract required scopes for a single tools/call request using Descope policy
 * mode. The required scope is derived from the tool name with the mcp:<tool.name>
 * convention; JSON-RPC batches are rejected by the transport before dispatch.
 */
async function extractPolicyRequiredScopes(
	request: Request,
	mcpConfig?: Record<string, unknown>,
): Promise<string[] | undefined> {
	const toolName = await extractMcpToolCallName(request);
	if (toolName) {
		if (toolName === "code" && mcpConfig?.codeMode === true) {
			// Code Mode authorizes each inner provider call with concrete
			// tool scopes. Requiring an outer mcp:code scope would make Descope
			// policies grant a synthetic scope that has no runtime meaning.
			return undefined;
		}
		return [toolToScope(toolName)];
	}

	return undefined;
}

async function extractMcpToolCallName(
	request: Request,
): Promise<string | undefined> {
	const contentType = request.headers.get("Content-Type") ?? "";
	if (request.method !== "POST" || !contentType.includes("application/json")) {
		return undefined;
	}

	try {
		const body = (await readJsonRpcBody(request)) as {
			method?: string;
			params?: { name?: string };
		} | null;
		return body?.method === "tools/call" ? body.params?.name : undefined;
	} catch {
		return undefined;
	}
}

function parseMcpCallerFromHeaders(headers: Headers): {
	authType?: string | null;
	scopes: string[];
} {
	return {
		authType: headers.get("x-tedix-auth-type"),
		scopes: (headers.get("x-tedix-auth-scopes") ?? "")
			.split(" ")
			.filter(Boolean),
	};
}

export function mcpToolsListResultTransform(
	tools: Array<{
		annotations?: InternalAppTool["annotations"];
		authRequired?: boolean;
		config?: Record<string, unknown> | null;
		outputSchema?: ToolJsonSchema | null;
		toolId: string;
		toolTypeId?: string | null;
		visibility?: string | null;
	}>,
	mcpConfig: Record<string, unknown> | undefined,
	requestHeaders: Headers,
): McpResultTransform {
	const outputSchemasByName = new Map(
		tools.flatMap((tool) =>
			tool.outputSchema ? [[tool.toolId, tool.outputSchema] as const] : [],
		),
	);
	const toolsByName = new Map(tools.map((tool) => [tool.toolId, tool]));
	const caller = parseMcpCallerFromHeaders(requestHeaders);
	const namespaceOverrides = mcpConfig?.codeModeNamespaces as
		| Record<string, string>
		| undefined;
	const visibleToolNames = new Set(
		tools
			.filter(
				(tool) =>
					(requestHeaders.get("x-tedix-auth-credential-mode") !==
						"delegated-mcp" ||
						!isDelegatedWorkTool(
							tool.toolId,
							resolveMcpToolNamespace(tool, namespaceOverrides),
							tool.config,
							tool.toolTypeId,
						)) &&
					isMcpToolVisibleToCaller(
						tool,
						resolveMcpToolNamespace(tool, namespaceOverrides),
						mcpConfig,
						caller,
					),
			)
			.map((tool) => tool.toolId),
	);

	return ({ request, response }) => {
		// `tools/call` result rewrites (transport.ts intentionally untouched):
		//  - `tedix/inputRequired` (sync-MRTR agent approval, governance.ts) →
		//    protocol-native `resultType: "input_required"` + inputRequests +
		//    requestState, so the calling agent resolves it and retries.
		//  - `tedix/genericTask` (async task, tool-execution.ts) →
		//    `resultType: "task"` envelope.
		if (request.method === "tools/call") {
			return rewriteGenericTaskResult(rewriteInputRequiredResult(response));
		}

		if (request.method !== "tools/list") return response;
		if (!("result" in response) || !response.result) return response;
		const result = response.result as { tools?: unknown };
		if (!Array.isArray(result.tools)) return response;

		const transformed = result.tools.flatMap((tool) => {
			if (
				typeof tool !== "object" ||
				tool === null ||
				Array.isArray(tool) ||
				typeof (tool as { name?: unknown }).name !== "string"
			) {
				return [tool];
			}
			const name = (tool as { name: string }).name;
			if (toolsByName.has(name) && !visibleToolNames.has(name)) {
				return [];
			}
			if (
				name === "code" &&
				mcpConfig?.codeMode === true &&
				visibleToolNames.size === 0
			) {
				return [];
			}

			const outputSchema = outputSchemasByName.get(name);
			return [
				{
					...tool,
					...(outputSchema ? { outputSchema } : {}),
					// The SDK preserves extension metadata but does not serialize the
					// OpenAI top-level auth declaration. Add it at the wire boundary.
					...(name === "code" && mcpConfig?.codeMode === true
						? codeModeSecurityMeta(mcpConfig)
						: {}),
					...(name === "get_profile"
						? { securitySchemes: ACCOUNT_PROFILE_SECURITY }
						: {}),
				},
			];
		});

		// Deterministic ordering for prompt-cache hits: stable sort by tool name.
		// D1 load order and aggregate merging are not stable across requests, so
		// without this clients see cache-busting tool-list permutations.
		sortToolsDeterministically(transformed);

		// Server-side cursor pagination: the stable sort makes a tool
		// name a stable position anchor, so page after filter+sort. Surfaces at
		// or under the page size return one cursorless page (no behavior change
		// for plain apps); the ~700-tool aggregate pages instead of shipping one
		// giant cold payload. This transform owns `nextCursor` for tools/list —
		// the inner server never mints one.
		const page = paginateSortedToolsList(
			transformed,
			isRecord(request.params) ? request.params.cursor : undefined,
		);
		if (!page.ok) {
			// Spec (2026-07-28 pagination): invalid cursors should result
			// in -32602 Invalid params.
			return {
				jsonrpc: "2.0",
				id: request.id,
				error: {
					code: -32_602,
					message: "Invalid params: unrecognized tools/list cursor",
				},
			};
		}
		const { nextCursor: _innerNextCursor, ...restResult } = result as {
			tools?: unknown;
			nextCursor?: unknown;
		};
		return {
			...response,
			result: {
				...restResult,
				tools: page.tools,
				...(page.nextCursor !== undefined
					? { nextCursor: page.nextCursor }
					: {}),
			},
		};
	};
}

/**
 * Rewrite a `tools/call` result that carries the `tedix/genericTask` _meta
 * marker into a protocol-native MCP Tasks `resultType: "task"` envelope
 * (McpCreateTaskResultSchema). Non-task results pass through unchanged.
 */
type McpJsonRpcMessage = Parameters<McpResultTransform>[0]["response"];

/**
 * Rewrite a `tools/call` result carrying the `tedix/inputRequired` _meta marker
 * (sync-MRTR agent approval, governance.ts) into a protocol-native
 * `resultType: "input_required"` result. The calling agent resolves the
 * `inputRequests` and retries the same call echoing `inputResponses` +
 * `requestState` (under `_meta`). Non-marker results pass through unchanged.
 */
function rewriteInputRequiredResult(
	response: McpJsonRpcMessage,
): McpJsonRpcMessage {
	if (!("result" in response) || !response.result) return response;
	const result = response.result as {
		_meta?: Record<string, unknown> | null;
		content?: unknown;
	};
	const marker = result._meta?.["tedix/inputRequired"];
	if (typeof marker !== "object" || marker === null) return response;
	const inputRequired = marker as Record<string, unknown>;
	if (typeof inputRequired.requestState !== "string") return response;

	return {
		...response,
		result: {
			resultType: "input_required",
			requestState: inputRequired.requestState,
			inputRequests: inputRequired.inputRequests ?? {},
			// Preserve the human-readable content block so non-MRTR clients still
			// see what is being asked.
			...(Array.isArray(result.content) ? { content: result.content } : {}),
		},
	} as McpJsonRpcMessage;
}

function rewriteGenericTaskResult(
	response: McpJsonRpcMessage,
): McpJsonRpcMessage {
	if (!("result" in response) || !response.result) return response;
	const result = response.result as {
		_meta?: Record<string, unknown> | null;
	};
	const marker = result._meta?.["tedix/genericTask"];
	if (typeof marker !== "object" || marker === null) return response;
	const task = marker as Record<string, unknown>;
	if (typeof task.taskId !== "string") return response;

	return buildTaskResult(response, {
		taskId: task.taskId,
		status: typeof task.status === "string" ? task.status : "working",
		createdAt: typeof task.createdAt === "string" ? task.createdAt : undefined,
		lastUpdatedAt:
			typeof task.lastUpdatedAt === "string" ? task.lastUpdatedAt : undefined,
		ttlMs: typeof task.ttlMs === "number" ? task.ttlMs : null,
		pollIntervalMs:
			typeof task.pollIntervalMs === "number" ? task.pollIntervalMs : undefined,
	});
}

function buildTaskResult(
	response: McpJsonRpcMessage,
	task: {
		createdAt?: string;
		lastUpdatedAt?: string;
		pollIntervalMs?: number;
		status: string;
		taskId: string;
		ttlMs: number | null;
	},
): McpJsonRpcMessage {
	return {
		...response,
		result: {
			resultType: "task",
			taskId: task.taskId,
			status: task.status,
			createdAt: task.createdAt,
			lastUpdatedAt: task.lastUpdatedAt,
			ttlMs: task.ttlMs,
			...(typeof task.pollIntervalMs === "number"
				? { pollIntervalMs: task.pollIntervalMs }
				: {}),
		},
	} as McpJsonRpcMessage;
}

/**
 * Resolve upstream app tools internally via API service binding when the upstream URL
 * points to the same Worker zone (avoiding 522 self-loopback).
 * Returns native AppTool[] from D1 — preserves original transport/config so tool
 * execution never loops through another MCP endpoint.
 *
 * `upstreamMcpUrl` is returned only for stale-config diagnostics; runtime
 * discovery/proxying is disabled.
 */
type InternalAppTool = import("./mcp/server-context").AppTool;
type InternalCatalogMcpResource =
	import("./mcp/server-context").CatalogMcpResource;
type InternalCatalogMcpResourceTemplate =
	import("./mcp/server-context").CatalogMcpResourceTemplate;
type InternalCatalogMcpPrompt = import("./mcp/server-context").CatalogMcpPrompt;

type AggregateAppEntry = {
	slug: string;
	/**
	 * Stable app id this entry links to; preferred over slug. Slug remains for
	 * display and as a fallback for entries written before ids were stored.
	 */
	appId?: string;
	/**
	 * Organization of the app whose `aggregateApps` holds this entry. Never read
	 * from stored metadata: the gateway stamps it from the resolved host app so
	 * apps/api can apply the aggregate ownership rule to an id-linked entry.
	 */
	hostOrganizationId?: string;
	connectionInstanceId?: string;
	/** Present only on a server-verified multi-organization selection. */
	organizationId?: string;
	/** The selected organization's own gateway, mounted by a Connect selection. */
	organizationMount?: boolean;
	/** Flat namespace these tools answered to before per-app namespaces. */
	legacyNamespace?: string;
	connectionLabel?: string;
	connectionProviderId?: string;
	connectionScope?: "tenant" | "user" | "hybrid";
	connectionScopes?: string[];
	prefix?: string;
	endpointPrefixes?: string[];
	toolIds?: string[];
	/**
	 * Mount only the source's read tools.
	 *
	 * A rule rather than a list: an enumerated `toolIds` snapshot has to be
	 * recomputed whenever the source changes, and a snapshot that nobody
	 * refreshes silently withholds every tool added after it was taken.
	 */
	readOnly?: boolean;
	forwardedQueryParams?: Record<string, string>;
};

interface InternalResolveResult {
	tools: InternalAppTool[];
	connectionInstanceId?: string;
	appId: string | null;
	/** The resolved app's current slug (an id-linked entry may store an old one). */
	appSlug?: string | null;
	/** The resolved app's organization; hosts the nested `aggregateApps` entries. */
	organizationId?: string | null;
	upstreamMcpUrl: string | null;
	connectionLabel: string | null;
	connectionProviderId: string | null;
	connectionScope: "tenant" | "user" | "hybrid" | null;
	connectionScopes: string[] | null;
	catalogResources: InternalCatalogMcpResource[];
	catalogResourceTemplates: InternalCatalogMcpResourceTemplate[];
	catalogPrompts: InternalCatalogMcpPrompt[];
	/** Query params to append when a forked upstream tool row calls its upstream. */
	forwardedQueryParams: Record<string, string> | null;
	/** Nested aggregate refs from `mcpConfig.aggregateApps`. Used by aggregateAndPrefixTools
	 *  to recurse through D1-backed app bundles. */
	aggregateApps: Array<{
		slug: string;
		appId?: string;
		connectionInstanceId?: string;
		endpointPrefixes?: string[];
		toolIds?: string[];
		readOnly?: boolean;
		connectionLabel?: string;
		connectionProviderId?: string;
		connectionScope?: "tenant" | "user" | "hybrid";
		connectionScopes?: string[];
		prefix?: string;
		forwardedQueryParams?: Record<string, string>;
	}> | null;
	resolutionFailed?: boolean;
	/** The app's own `mcpConfig.toolScopes`, unvalidated. */
	toolScopes?: unknown;
}

/**
 * Add Connect organization-mount scopes to a request's app metadata. Connect's
 * own keys win; the mount keys only name namespaces Connect serves for the
 * selected organizations, so they never widen an existing Connect rule.
 */
function withMountToolScopes<T extends { mcpConfig?: unknown } | null>(
	metadata: T,
	mountToolScopes: Record<string, string[]>,
): T {
	const mcpConfig =
		metadata?.mcpConfig && typeof metadata.mcpConfig === "object"
			? (metadata.mcpConfig as Record<string, unknown>)
			: {};
	const own =
		mcpConfig.toolScopes && typeof mcpConfig.toolScopes === "object"
			? (mcpConfig.toolScopes as Record<string, string[]>)
			: {};
	return {
		...metadata,
		mcpConfig: { ...mcpConfig, toolScopes: { ...mountToolScopes, ...own } },
	} as T;
}

export interface AggregatedMcpSurface {
	tools: InternalAppTool[];
	resources: InternalCatalogMcpResource[];
	resourceTemplates: InternalCatalogMcpResourceTemplate[];
	prompts: InternalCatalogMcpPrompt[];
	degraded?: boolean;
	/** Connect organization-mount scopes, keyed by the namespaces Connect serves. */
	toolScopes?: Record<string, string[]>;
}

const internalToolCache = new Map<
	string,
	{ result: InternalResolveResult; expiresAt: number }
>();
const internalToolInFlight = new Map<string, Promise<InternalResolveResult>>();
const aggregateSurfaceCache = new Map<
	string,
	{ result: AggregatedMcpSurface; expiresAt: number }
>();
const aggregateSurfaceInFlight = new Map<
	string,
	Promise<AggregatedMcpSurface>
>();
const AGGREGATE_ACTIVATION_MARKER_KEY = "aggregate-activation/v1/current";
const AGGREGATE_ACTIVATION_EPOCH_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
// Surfaces retain complete parsed schemas. Bound isolate retention under
// arbitrary namespace subsets and activation epochs; L2/R2 remain available.
const MAX_INTERNAL_TOOL_CACHE_ENTRIES = 64;
const MAX_AGGREGATE_SURFACE_CACHE_ENTRIES = 8;
const INTERNAL_TOOL_CACHE_TTL_MS = 120_000;
const AGGREGATE_SURFACE_CACHE_TTL_MS = 120_000;
// Degrade-on-flap: cap how long a single aggregate app's upstream resolution may
// hold the whole surface. A healthy cold init resolves every app in a few
// seconds (slowest ~4.5s, see `_cm:"aggregate"` logs); under the documented
// remote-binding flap a stuck app quantizes at n×~48s and would otherwise block
// the entire `Promise.all`. When an entry exceeds this, it is dropped as a
// degraded partial (surface returns with the healthy apps + `degraded:true`)
// instead of stalling discovery to the ~100s edge 524.
const AGGREGATE_ENTRY_TIMEOUT_MS = 12_000;
// A targeted Code Mode request hydrates only the namespace its program names.
// If that one read hits a fast transient, returning the degraded surface makes
// the namespace disappear and the sandbox cannot run. Rebuild once before
// executing the program. Each rebuild retains the existing 12s per-entry cap;
// discovery/full-surface hydration stays single-attempt to avoid multiplying a
// wide fan-out, and persistent failure still reaches the existing diagnostic.
const SELECTIVE_AGGREGATE_HYDRATION_ATTEMPTS = 2;
/**
 * Wedge-eviction bounds for the shared in-flight dedupe maps: a never-settling
 * shared promise otherwise serves the same silent hang to every request until
 * the isolate recycles. Every await inside these loads is individually
 * budgeted, so these fire only for a genuinely wedged promise, and each is
 * sized above the worst-case SUM of the inner budgets (internal tool resolve
 * one 12s upstream call → 30s; aggregate surface load ~35s → 45s). The
 * arithmetic: `docs/engineering/mcp/runtime.md` "Edge Design Record".
 */
const INTERNAL_TOOL_WEDGE_EVICT_MS = 30_000;
const AGGREGATE_LOAD_WEDGE_EVICT_MS = 45_000;

export function aggregateSurfaceCacheKey(
	entries: AggregateAppEntry[],
	deploymentFingerprint = "dev",
	activationEpoch = "initial",
): string {
	return JSON.stringify({
		deploymentFingerprint,
		activationEpoch,
		entries: entries.map((entry) => ({
			slug: entry.slug,
			// An id-linked entry resolves by id under its host's ownership rule, so
			// it must never share a snapshot with a slug-keyed entry of that name.
			appId: entry.appId ?? null,
			hostOrganizationId: entry.appId
				? (entry.hostOrganizationId ?? null)
				: null,
			organizationId: entry.organizationId ?? null,
			prefix: entry.prefix ?? null,
			connectionLabel: entry.connectionLabel ?? null,
			connectionProviderId: entry.connectionProviderId ?? null,
			connectionInstanceId: entry.connectionInstanceId ?? null,
			connectionScope: entry.connectionScope ?? null,
			connectionScopes: entry.connectionScopes ?? null,
			endpointPrefixes: entry.endpointPrefixes ?? null,
			toolIds: entry.toolIds ?? null,
			readOnly: entry.readOnly ?? null,
			forwardedQueryParams: entry.forwardedQueryParams ?? null,
		})),
	});
}

// Short, stable, fixed-length key derived from the raw fingerprint. The raw
// `aggregateSurfaceCacheKey` is the full entries JSON, which for large aggregates
// (e.g. tedix-unified, 31 apps) runs to several KB — past R2's 1024-byte object-
// key limit, so the L3 write threw silently and the big surfaces (the expensive
// ~6.4s ones) never cached. Also keeps the L2 cache URL bounded. cyrb53 (53-bit)
// → ~14 hex chars; collision risk is negligible across the handful of distinct
// aggregate fingerprints. not a security hash — just a compact cache key.
function hashAggregateCacheKey(cacheKey: string): string {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < cacheKey.length; i++) {
		const ch = cacheKey.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0))
		.toString(16)
		.padStart(14, "0");
}

function isValidAggregateActivationEpoch(value: string): boolean {
	const match = value.match(AGGREGATE_ACTIVATION_EPOCH_PATTERN);
	return Boolean(match && match[0] === value);
}

export async function readAggregateActivationEpoch(
	env: CloudflareEnv,
): Promise<{ value: string; cacheable: boolean }> {
	if (env.AGGREGATE_EPOCH_KV) {
		try {
			const value = await withStepBudget(
				"aggregate_activation_epoch_instant_read",
				CACHE_TIER_BUDGET_MS,
				env.AGGREGATE_EPOCH_KV.get(AGGREGATE_ACTIVATION_MARKER_KEY),
				AGGREGATE_ACTIVATION_MARKER_KEY,
			);
			if (value !== null) {
				if (isValidAggregateActivationEpoch(value)) {
					return { value, cacheable: true };
				}
				console.warn(
					"[aggregate] KV Instant activation epoch marker is invalid",
				);
			}
		} catch (error) {
			if (!(error instanceof StepBudgetExceededError)) {
				log.warn("KV Instant aggregate activation epoch read failed", {
					event: "aggregate.activation_epoch_instant_read_failed",
					outcome: "unavailable",
					error: contentFreeMcpException(error),
				});
			}
		}
	}
	if (!("AGGREGATE_CACHE" in env) || !env.AGGREGATE_CACHE) {
		return { value: "local", cacheable: true };
	}
	try {
		const object = await withStepBudget(
			"aggregate_activation_epoch_read",
			CACHE_TIER_BUDGET_MS,
			env.AGGREGATE_CACHE.get(AGGREGATE_ACTIVATION_MARKER_KEY),
			AGGREGATE_ACTIVATION_MARKER_KEY,
		);
		if (!object) return { value: "initial", cacheable: true };
		if (typeof object.size === "number" && object.size > 128) {
			console.warn("[aggregate] activation epoch marker is invalid");
			return { value: `unavailable:${crypto.randomUUID()}`, cacheable: false };
		}
		const value = await object.text();
		if (!isValidAggregateActivationEpoch(value)) {
			console.warn("[aggregate] activation epoch marker is invalid");
			return { value: `unavailable:${crypto.randomUUID()}`, cacheable: false };
		}
		return { value, cacheable: true };
	} catch (error) {
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("Aggregate activation epoch read failed", {
				event: "aggregate.activation_epoch_read_failed",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
		// Never reuse an earlier generation when the fence cannot be read. A unique
		// generation also prevents this request from joining or seeding any shared
		// aggregate/internal cache while R2 is unavailable.
		return { value: `unavailable:${crypto.randomUUID()}`, cacheable: false };
	}
}

export async function writeAggregateActivationEpoch(
	env: CloudflareEnv,
	activationEpoch: string,
): Promise<void> {
	// Keep the existing R2 fence current first. If the optional fast-path write
	// fails, removing its old pointer makes readers fall through to this marker.
	if ("AGGREGATE_CACHE" in env && env.AGGREGATE_CACHE) {
		await env.AGGREGATE_CACHE.put(
			AGGREGATE_ACTIVATION_MARKER_KEY,
			activationEpoch,
		);
	}
	if (!env.AGGREGATE_EPOCH_KV) return;
	try {
		await withStepBudget(
			"aggregate_activation_epoch_instant_write",
			CACHE_TIER_BUDGET_MS,
			env.AGGREGATE_EPOCH_KV.put(
				AGGREGATE_ACTIVATION_MARKER_KEY,
				activationEpoch,
			),
			AGGREGATE_ACTIVATION_MARKER_KEY,
		);
	} catch (error) {
		// A stale-but-valid Instant pointer would mask the fresh R2 fallback. Remove
		// it before allowing the purge to continue; if deletion also fails, abort
		// the purge so no caller is told that the new generation is active.
		await withStepBudget(
			"aggregate_activation_epoch_instant_delete",
			CACHE_TIER_BUDGET_MS,
			env.AGGREGATE_EPOCH_KV.delete(AGGREGATE_ACTIVATION_MARKER_KEY),
			AGGREGATE_ACTIVATION_MARKER_KEY,
		);
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("KV Instant aggregate activation epoch write failed", {
				event: "aggregate.activation_epoch_instant_write_failed",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
	}
}

/**
 * How one aggregate entry names its source app. `appId` wins over `slug`; an
 * id-linked entry also carries the organization of the app that holds it, which
 * apps/api needs to apply the aggregate ownership rule.
 */
type AggregateSourceRef = {
	slug: string;
	appId?: string;
	hostOrganizationId?: string;
};

/**
 * Identity of an aggregate source in the per-source L1 cache and the cycle
 * guard. An id-linked entry is keyed by id and host organization, never by its
 * stored (possibly stale) slug, so it cannot reuse a slug-keyed result.
 */
function aggregateSourceKey(ref: AggregateSourceRef): string {
	return ref.appId
		? `id:${ref.appId}@${ref.hostOrganizationId ?? ""}`
		: ref.slug;
}

/**
 * Cycle guard. The resolution stack records each ancestor's app id and current
 * slug, so an id-linked entry is caught by id and a slug entry by slug,
 * whichever way the ancestor itself was linked.
 */
function isAggregateSourceVisited(
	visited: Set<string>,
	ref: AggregateSourceRef,
): boolean {
	return ref.appId ? visited.has(ref.appId) : visited.has(ref.slug);
}

function internalToolCacheKey(
	source: AggregateSourceRef,
	selection?: { endpointPrefixes?: string[]; toolIds?: string[] },
	activationEpoch = "direct",
): string {
	return `internal:${activationEpoch}:${aggregateSourceKey(source)}:${JSON.stringify(selection ?? {})}`;
}

/** App exists but resolves to nothing — not a failure, so never `degraded`. */
function emptyInternalResolveResult(): InternalResolveResult {
	return {
		tools: [],
		appId: null,
		upstreamMcpUrl: null,
		connectionLabel: null,
		connectionProviderId: null,
		connectionScope: null,
		connectionScopes: null,
		catalogResources: [],
		catalogResourceTemplates: [],
		catalogPrompts: [],
		forwardedQueryParams: null,
		aggregateApps: null,
	};
}

/** Shape shared by `apps.getBySlugWithTools` and one entry of the batched form. */
type UpstreamAppWithTools = Awaited<
	ReturnType<ApiClient["apps"]["getBySlugWithTools"]>
>;

/**
 * Pure transform of one apps/api app+tools payload into the gateway's internal
 * shape. Shared by the single-slug and batched resolution paths so they cannot
 * drift — connection defaulting and catalog stamping are identical either way.
 */
function toInternalResolveResult(
	upstreamSlug: string,
	result: UpstreamAppWithTools,
): InternalResolveResult {
	if (!result.app) {
		console.warn(`[upstream-internal] App not found for slug: ${upstreamSlug}`);
		return emptyInternalResolveResult();
	}
	const resolvedApp = result.app;
	// The app's current slug: an id-linked entry may still store an old one.
	const sourceAppSlug = resolvedApp.slug || upstreamSlug;

	const mcpConfig = (result.app.metadata as Record<string, unknown> | null)
		?.mcpConfig as Record<string, unknown> | undefined;
	const upstreamMcpUrl = (mcpConfig?.upstreamMcpUrl as string | null) ?? null;
	const connectionLabel = (mcpConfig?.connectionLabel as string | null) || null;
	const connectionProviderId =
		(mcpConfig?.connectionProviderId as string | null) || null;
	const connectionScope =
		mcpConfig?.connectionScope === "tenant" ||
		mcpConfig?.connectionScope === "user" ||
		mcpConfig?.connectionScope === "hybrid"
			? mcpConfig.connectionScope
			: null;
	const connectionScopes = Array.isArray(mcpConfig?.connectionScopes)
		? mcpConfig.connectionScopes.filter(
				(scope): scope is string => typeof scope === "string",
			)
		: null;
	const forwardedQueryParams =
		(mcpConfig?.forwardedQueryParams as
			| Record<string, string>
			| null
			| undefined) ?? null;
	const aggregateApps =
		(mcpConfig?.aggregateApps as
			| InternalResolveResult["aggregateApps"]
			| null
			| undefined) ?? null;

	const tools = (result.tools ?? []).filter((t) => t.enabled !== false);
	const catalogResources = (result.catalogResources ?? []).map((resource) => ({
		...resource,
		sourceAppSlug,
		sourceAppId: resolvedApp.id,
		catalogMcp: result.catalogMcp ?? null,
		connectionProviderId,
		connectionScope: connectionScope as "tenant" | "user" | "hybrid" | null,
		connectionScopes,
	}));
	const catalogResourceTemplates = (result.catalogResourceTemplates ?? []).map(
		(template) => ({
			...template,
			sourceAppSlug,
			sourceAppId: resolvedApp.id,
			catalogMcp: result.catalogMcp ?? null,
			connectionProviderId,
			connectionScope: connectionScope as "tenant" | "user" | "hybrid" | null,
			connectionScopes,
		}),
	);
	const catalogPrompts = (result.catalogPrompts ?? []).map((prompt) => ({
		...prompt,
		sourceAppSlug,
		catalogMcp: result.catalogMcp ?? null,
		connectionProviderId,
		connectionScope: connectionScope as "tenant" | "user" | "hybrid" | null,
		connectionScopes,
	}));

	return {
		tools,
		appId: resolvedApp.id,
		appSlug: sourceAppSlug,
		organizationId: resolvedApp.organizationId ?? null,
		...(typeof mcpConfig?.connectionInstanceId === "string"
			? { connectionInstanceId: mcpConfig.connectionInstanceId }
			: {}),
		upstreamMcpUrl,
		connectionLabel,
		connectionProviderId,
		connectionScope,
		connectionScopes,
		catalogResources,
		catalogResourceTemplates,
		catalogPrompts,
		forwardedQueryParams,
		aggregateApps,
		toolScopes: mcpConfig?.toolScopes,
	};
}

async function resolveUpstreamToolsInternally(
	source: AggregateSourceRef,
	env: CloudflareEnv,
	selection?: {
		endpointPrefixes?: string[];
		toolIds?: string[];
	},
	activationEpoch = "direct",
	cacheable = true,
): Promise<InternalResolveResult> {
	const upstreamSlug = source.slug;
	const cacheKey = internalToolCacheKey(source, selection, activationEpoch);
	if (cacheable) pruneExpiredCacheEntries(internalToolCache);
	const cached = cacheable ? internalToolCache.get(cacheKey) : undefined;
	if (cached && cached.expiresAt > Date.now()) return cached.result;
	const inFlight = cacheable ? internalToolInFlight.get(cacheKey) : undefined;
	if (inFlight)
		return joinInFlightLoad(internalToolInFlight, cacheKey, inFlight, {
			step: "internal_tool_join",
			budgetMs: INTERNAL_TOOL_WEDGE_EVICT_MS,
			resource: upstreamSlug,
		});

	const loadPromise = (async (): Promise<InternalResolveResult> => {
		try {
			const client = getApiClient({
				serviceFetch: env.API_SERVICE,
			});
			// Budgeted: this raw service-binding call previously had no deadline, so
			// one wedged call pinned this slug's shared in-flight promise (and every
			// joiner) until isolate recycle. Same budget as any single apps/api
			// attempt; a trip throws → the catch below degrades (`resolutionFailed`)
			// and the settled promise is evicted so the next request retries fresh.
			const selectionInput = {
				...(selection?.endpointPrefixes?.length
					? { endpointPrefixes: selection.endpointPrefixes }
					: {}),
				...(selection?.toolIds?.length ? { toolIds: selection.toolIds } : {}),
			};
			// An id-linked entry resolves through the batched endpoint, the one
			// path that resolves by id under the aggregate ownership rule.
			const result: UpstreamAppWithTools = await withStepBudget(
				"internal_tool_resolve",
				UPSTREAM_ATTEMPT_TIMEOUT_MS,
				source.appId
					? client.apps
							.getBySlugsWithTools({
								apps: [
									{
										slug: upstreamSlug,
										appId: source.appId,
										...(source.hostOrganizationId
											? { hostOrganizationId: source.hostOrganizationId }
											: {}),
										...selectionInput,
									},
								],
							})
							.then(({ results }) => results[0] ?? { app: null, tools: [] })
					: client.apps.getBySlugWithTools({
							slug: upstreamSlug,
							...selectionInput,
						}),
				upstreamSlug,
			);
			const resolved = toInternalResolveResult(upstreamSlug, result);
			if (!result.app) return resolved;
			if (cacheable) {
				setBoundedExpiringCacheEntry(
					internalToolCache,
					cacheKey,
					{
						result: resolved,
						expiresAt: Date.now() + INTERNAL_TOOL_CACHE_TTL_MS,
					},
					MAX_INTERNAL_TOOL_CACHE_ENTRIES,
				);
			}
			return resolved;
		} catch (err) {
			log.warn("Aggregate source app resolution failed", {
				event: "aggregate.source_resolution_failed",
				appSlug: upstreamSlug,
				outcome: "unavailable",
				error: contentFreeMcpException(err),
			});
			return {
				tools: [],
				appId: null,
				upstreamMcpUrl: null,
				connectionLabel: null,
				connectionProviderId: null,
				connectionScope: null,
				connectionScopes: null,
				catalogResources: [],
				catalogResourceTemplates: [],
				catalogPrompts: [],
				forwardedQueryParams: null,
				aggregateApps: [],
				resolutionFailed: true,
			};
		}
	})();

	if (!cacheable) return loadPromise;
	trackInFlightLoad(internalToolInFlight, cacheKey, loadPromise, {
		step: "internal_tool_in_flight",
		wedgeEvictMs: INTERNAL_TOOL_WEDGE_EVICT_MS,
		resource: upstreamSlug,
	});
	return joinInFlightLoad(internalToolInFlight, cacheKey, loadPromise, {
		step: "internal_tool_join",
		budgetMs: INTERNAL_TOOL_WEDGE_EVICT_MS,
		resource: upstreamSlug,
	});
}

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

function withAggregateConnectionProvider(
	config: Record<string, unknown>,
	provider: {
		connectionProviderId?: string;
		connectionScope?: "tenant" | "user" | "hybrid";
		connectionScopes?: string[];
	},
): Record<string, unknown> {
	if (!provider.connectionProviderId) return config;

	const existingAuth =
		typeof config.auth === "object" && config.auth !== null
			? ({ ...(config.auth as Record<string, unknown>) } as Record<
					string,
					unknown
				>)
			: null;

	if (existingAuth?.type && existingAuth.type !== "connection") return config;
	const auth = existingAuth ?? { type: "connection" };

	auth.connectionId = provider.connectionProviderId;
	if (provider.connectionScope) {
		auth.credentialScope = provider.connectionScope;
		auth.scope = provider.connectionScope;
	}
	if (provider.connectionScopes?.length) {
		auth.scopes = provider.connectionScopes;
	}

	return {
		...config,
		auth,
		_aggregateConnectionProviderId: provider.connectionProviderId,
	};
}

/**
 * Stamp the host app's organization onto its own `aggregateApps` entries.
 *
 * apps/api resolves an id-linked entry only when the target belongs to this
 * organization or to the platform organization, so the host is always taken
 * from the resolved app — never from a value stored in the entry itself. An
 * id-linked entry of a host with no known organization resolves to nothing.
 */
export function withAggregateHostOrganization(
	entries: AggregateAppEntry[],
	hostOrganizationId: string | null | undefined,
): AggregateAppEntry[] {
	return entries.map((entry) => {
		const { hostOrganizationId: _stored, ...rest } = entry;
		return hostOrganizationId ? { ...rest, hostOrganizationId } : rest;
	});
}

/**
 * Default aggregate entries' connection overrides from the host app's own
 * mcpConfig before resolution. Without it the base app's connection settings
 * win and a thin multi-tenant aggregator serves the base credential; see
 * `docs/engineering/mcp/runtime.md` "Edge Design Record".
 *
 * Per-field precedence after this step: explicit entry value > host app
 * mcpConfig > aggregated app mcpConfig (the last fallback lives in
 * aggregateAndPrefixToolsUncached's `entry.X ?? appX` resolution).
 *
 * Defaults apply only when the host declares its own `connectionProviderId` —
 * the override is meaningful as a bundle keyed on the provider id. A
 * host-level `connectionScope` or `connectionLabel` without one must not be
 * injected here (it qualifies the host's own direct tools, and the label
 * already reaches aggregated tools via `ctx.connectionLabel`).
 *
 * Applied at entry-build time, not inside the aggregate resolver: that keeps
 * nested aggregation correct and makes `aggregateSurfaceCacheKey` distinguish
 * hosts that aggregate the same base app with different credentials.
 */
export function applyHostConnectionDefaultsToAggregateEntries(
	entries: AggregateAppEntry[],
	hostMcpConfig:
		| {
				connectionLabel?: unknown;
				connectionInstanceId?: unknown;
				connectionProviderId?: unknown;
				connectionScope?: unknown;
				connectionScopes?: unknown;
		  }
		| null
		| undefined,
): AggregateAppEntry[] {
	const hostConnectionProviderId =
		typeof hostMcpConfig?.connectionProviderId === "string" &&
		hostMcpConfig.connectionProviderId
			? hostMcpConfig.connectionProviderId
			: null;
	if (!hostConnectionProviderId) return entries;

	const hostConnectionLabel =
		typeof hostMcpConfig?.connectionLabel === "string" &&
		hostMcpConfig.connectionLabel
			? hostMcpConfig.connectionLabel
			: undefined;
	const hostConnectionScope =
		hostMcpConfig?.connectionScope === "tenant" ||
		hostMcpConfig?.connectionScope === "user" ||
		hostMcpConfig?.connectionScope === "hybrid"
			? hostMcpConfig.connectionScope
			: undefined;
	const filteredHostConnectionScopes = Array.isArray(
		hostMcpConfig?.connectionScopes,
	)
		? hostMcpConfig.connectionScopes.filter(
				(scope): scope is string => typeof scope === "string",
			)
		: undefined;
	const hostConnectionScopes = filteredHostConnectionScopes?.length
		? filteredHostConnectionScopes
		: undefined;

	return entries.map((entry) => {
		if (
			hostMcpConfig?.connectionInstanceId &&
			entry.connectionProviderId &&
			entry.connectionProviderId !== hostConnectionProviderId
		)
			return entry;
		return {
			...entry,
			connectionProviderId:
				entry.connectionProviderId ?? hostConnectionProviderId,
			connectionLabel: entry.connectionLabel ?? hostConnectionLabel,
			connectionInstanceId:
				entry.connectionInstanceId ??
				(typeof hostMcpConfig?.connectionInstanceId === "string"
					? hostMcpConfig.connectionInstanceId
					: undefined),
			connectionScope: entry.connectionInstanceId
				? (entry.connectionScope ?? hostConnectionScope)
				: typeof hostMcpConfig?.connectionInstanceId === "string"
					? hostConnectionScope
					: (entry.connectionScope ?? hostConnectionScope),
			connectionScopes: entry.connectionScopes ?? hostConnectionScopes,
		};
	});
}

// =============================================================================
// ORG-wide aggregation
// =============================================================================

/**
 * Load tools from multiple source apps and prefix their names for aggregation.
 *
 * Uses internal D1 resolution (same path as resolveUpstreamToolsInternally) —
 * no HTTP, no 522 self-loopback risk. All source apps must be on the same zone.
 *
 * Tool naming: `{prefix}__{toolId}` — double-underscore separator allows reliable
 * parsing (split on first `__`) without conflicting with single-underscore names.
 *
 * Auth: rpc-transport tools need no extra config (use caller JWT + service binding).
 * external/mcp-transport tools should reference Descope outbound app IDs directly.
 */
// ── Durable L2 aggregate-surface cache (Workers Cache API) + stale-while-revalidate ──
// L1 (aggregateSurfaceCache) is in-memory per-isolate and lost on recycle; L2
// (`caches.default`) is a per-colo durable blob that survives isolate recycle —
// a cold isolate reads the precomputed surface instead of re-running the ~4-7s
// live D1/service-binding fan-out (Cloudflare's "cold isolate reads an artifact"
// pattern; no new binding, no edge D1 write).
//
// Stale-while-revalidate: an L2 entry is kept for AGGREGATE_L2_HARD_TTL but is
// treated as fresh only within the soft 120s window. Between soft and hard the
// stale surface is served immediately (no 4-7s block) while one background
// rebuild refreshes L1+L2 via ctx.waitUntil. This removes the cold-rebuild
// latency cliff for every request after the first populate. Worst-case staleness
// is bounded by the hard TTL, and the fingerprint key busts on deployments and
// aggregate config changes. Fully fail-safe: any Cache API error or
// background-rebuild failure falls through to (or leaves intact) a live rebuild.
const AGGREGATE_L2_HARD_TTL_MS = 600_000; // serve-stale ceiling (10 min)
const AGGREGATE_L2_HARD_TTL_SECONDS = AGGREGATE_L2_HARD_TTL_MS / 1000;
// One background revalidation per cache key at a time (no rebuild stampede).
const aggregateRevalidateInFlight = new Set<string>();
type AggregateL2Read = { surface: AggregatedMcpSurface; stale: boolean };

function aggregateL2Request(cacheKey: string): Request {
	return aggregateL2RequestFromHash(hashAggregateCacheKey(cacheKey));
}

function aggregateL2RequestFromHash(cacheKeyHash: string): Request {
	return new Request(
		`https://aggregate-cache.mcp.tedix.internal/v1/${cacheKeyHash}`,
	);
}
// Emit a cache-effectiveness datapoint to Analytics Engine (isolated by blob1
// = "aggregate_cache") so hit-rate / cold-miss / SWR effectiveness is queryable
// on prod, where Worker logs aren't tailable. Fully fail-safe: telemetry never
// breaks a request.
function emitAggregateCacheMetric(
	env: CloudflareEnv,
	event: McpAggregateCacheDataPointEvent,
): void {
	try {
		if ("ANALYTICS" in env && env.ANALYTICS) {
			env.ANALYTICS.writeDataPoint(buildMcpAggregateCacheDataPoint(event));
		}
	} catch {
		// swallow — never let telemetry break the aggregate path
	}
}
async function readAggregateL2(
	cacheKey: string,
): Promise<AggregateL2Read | null> {
	try {
		if (typeof caches === "undefined" || !caches.default) return null;
		// Budgeted (match + body read together): an unbudgeted Cache API hang here
		// sits at the top of the shared aggregate load — the silent-hang class in
		// `docs/engineering/mcp/runtime.md` "Edge Design Record". A trip emits the
		// diagnosis line and fails open to the next tier.
		const wrapped = await withStepBudget(
			"aggregate_l2_read",
			CACHE_TIER_BUDGET_MS,
			(async () => {
				const hit = await caches.default.match(aggregateL2Request(cacheKey));
				if (!hit) return null;
				return (await hit.json()) as {
					cachedAt?: number;
					surface?: AggregatedMcpSurface;
				};
			})(),
			cacheKey,
		);
		if (!wrapped) return null;
		const surface = wrapped?.surface;
		// Never serve a degraded/foreign snapshot — degraded surfaces are not
		// written, but guard defensively against an older/foreign entry.
		if (!surface || surface.degraded) return null;
		const age =
			Date.now() -
			(typeof wrapped.cachedAt === "number" ? wrapped.cachedAt : 0);
		if (age >= AGGREGATE_L2_HARD_TTL_MS) return null; // too stale → force rebuild
		return { surface, stale: age >= AGGREGATE_SURFACE_CACHE_TTL_MS };
	} catch (error) {
		// A budget trip already emitted its structured diagnosis line.
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("Aggregate cache read failed", {
				event: "aggregate.cache_read_failed",
				step: "l2",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
		return null;
	}
}
async function writeAggregateL2(
	cacheKey: string,
	result: AggregatedMcpSurface,
): Promise<void> {
	try {
		if (typeof caches === "undefined" || !caches.default) return;
		const body = new Response(
			JSON.stringify({ cachedAt: Date.now(), surface: result }),
			{
				headers: {
					"Content-Type": "application/json",
					"Cache-Control": `max-age=${AGGREGATE_L2_HARD_TTL_SECONDS}`,
				},
			},
		);
		// Budgeted: awaited on the request path, so a wedged put must fail open.
		await withStepBudget(
			"aggregate_l2_write",
			CACHE_TIER_BUDGET_MS,
			caches.default.put(aggregateL2Request(cacheKey), body),
			cacheKey,
		);
	} catch (error) {
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("Aggregate cache write failed", {
				event: "aggregate.cache_write_failed",
				step: "l2",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
	}
}

// ── L3: durable global aggregate cache (R2 bucket AGGREGATE_CACHE) ──
// L2 (`caches.default`) is per-colo and capped at 10 min; a cold isolate in a
// brand-new colo, or after the L2 hard TTL under sparse traffic, still pays the
// ~6.4s live fan-out (confirmed via the `aggregate_cache`/cold_rebuild ae
// metric). R2 is account-global and durable, so it serves the precomputed
// surface to the first cold isolate in any colo — Cloudflare's spec.json-in-R2
// pattern. SWR semantics like L2 but a longer 1h hard TTL (R2 is durable).
// Fully fail-safe: any R2 error falls through to the next tier / live rebuild.
const AGGREGATE_R2_HARD_TTL_MS = 3_600_000; // serve-stale ceiling (1 hour)
function aggregateR2Key(cacheKey: string): string {
	return `aggregate-surface/v1/${hashAggregateCacheKey(cacheKey)}`;
}
async function readAggregateR2(
	env: CloudflareEnv,
	cacheKey: string,
	options?: { allowExpired?: boolean },
): Promise<AggregateL2Read | null> {
	try {
		if (!("AGGREGATE_CACHE" in env) || !env.AGGREGATE_CACHE) return null;
		const bucket = env.AGGREGATE_CACHE;
		// Budgeted (get + body read together): this read also backs the
		// join-deadline and degraded-rebuild stale fallbacks, where an unbudgeted
		// R2 hang turned "serve stale instead of waiting" into a silent hang.
		const wrapped = await withStepBudget(
			"aggregate_r2_read",
			CACHE_TIER_BUDGET_MS,
			(async () => {
				const obj = await bucket.get(aggregateR2Key(cacheKey));
				if (!obj) return null;
				return (await obj.json()) as {
					cachedAt?: number;
					surface?: AggregatedMcpSurface;
				};
			})(),
			cacheKey,
		);
		if (!wrapped) return null;
		const surface = wrapped?.surface;
		if (!surface || surface.degraded) return null;
		const age =
			Date.now() -
			(typeof wrapped.cachedAt === "number" ? wrapped.cachedAt : 0);
		// allowExpired: stale-beats-degraded fallback — when a cold rebuild comes
		// back degraded (e.g. the API service binding is mid-deploy), an old full
		// surface is far better than a fresh 3-namespace toy surface.
		if (age >= AGGREGATE_R2_HARD_TTL_MS && !options?.allowExpired) return null;
		return { surface, stale: age >= AGGREGATE_SURFACE_CACHE_TTL_MS };
	} catch (error) {
		// A budget trip already emitted its structured diagnosis line.
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("Aggregate cache read failed", {
				event: "aggregate.cache_read_failed",
				step: "r2",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
		return null;
	}
}
async function writeAggregateR2(
	env: CloudflareEnv,
	cacheKey: string,
	result: AggregatedMcpSurface,
	rootSlug?: string,
): Promise<void> {
	try {
		if (!("AGGREGATE_CACHE" in env) || !env.AGGREGATE_CACHE) return;
		// Budgeted: awaited on the request path, so a wedged put must fail open.
		await withStepBudget(
			"aggregate_r2_write",
			CACHE_TIER_BUDGET_MS,
			env.AGGREGATE_CACHE.put(
				aggregateR2Key(cacheKey),
				JSON.stringify({ cachedAt: Date.now(), surface: result }),
				{ httpMetadata: { contentType: "application/json" } },
			),
			cacheKey,
		);
	} catch (error) {
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("Aggregate cache write failed", {
				event: "aggregate.cache_write_failed",
				step: "r2",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
		// Surface silent cache-write failures (e.g. the >1024-byte R2 key bug) as a
		// queryable metric — appSlug/appCount show which surface failed to cache.
		emitAggregateCacheMetric(env, {
			cacheEvent: "r2_write_failed",
			appSlug: rootSlug,
			toolCount: result.tools.length,
		});
	}
}
// Background rebuild after a stale L2/L3 serve; refreshes L1 + L2 + L3. Single-
// flight per key; failures are swallowed (the stale entry remains until hard TTL).
async function revalidateAggregate(
	cacheKey: string,
	entries: AggregateAppEntry[],
	env: CloudflareEnv,
	activationEpoch: string,
	rootSlug?: string,
): Promise<void> {
	if (aggregateRevalidateInFlight.has(cacheKey)) return;
	aggregateRevalidateInFlight.add(cacheKey);
	try {
		const fresh = await aggregateAndPrefixToolsUncached(
			entries,
			env,
			new Set(),
			"revalidate",
			rootSlug,
			activationEpoch,
			true,
		);
		if (!fresh.degraded) {
			setBoundedExpiringCacheEntry(
				aggregateSurfaceCache,
				cacheKey,
				{
					result: fresh,
					expiresAt: Date.now() + AGGREGATE_SURFACE_CACHE_TTL_MS,
				},
				MAX_AGGREGATE_SURFACE_CACHE_ENTRIES,
			);
			await writeAggregateL2(cacheKey, fresh);
			await writeAggregateR2(env, cacheKey, fresh, rootSlug);
			console.log(JSON.stringify({ _cm: "aggregate", event: "revalidated" }));
			emitAggregateCacheMetric(env, {
				cacheEvent: "revalidated",
				appSlug: rootSlug,
				toolCount: fresh.tools.length,
			});
		}
	} catch (error) {
		log.warn("Aggregate background revalidation failed", {
			event: "aggregate.revalidation_failed",
			outcome: "unavailable",
			error: contentFreeMcpException(error),
		});
	} finally {
		aggregateRevalidateInFlight.delete(cacheKey);
	}
}

export async function aggregateAndPrefixTools(
	entries: AggregateAppEntry[],
	env: CloudflareEnv,
	visited: Set<string> = new Set(),
	ctx?: ExecutionContext,
	// Root app slug (e.g. "tedix-unified") for cache-effectiveness telemetry, so
	// ae rows attribute hits/misses to a specific surface instead of inferring
	// from appCount.
	rootSlug?: string,
	activation?: { value: string; cacheable: boolean },
	cacheSnapshot = true,
): Promise<AggregatedMcpSurface> {
	if (visited.size > 0) {
		return aggregateAndPrefixToolsUncached(
			entries,
			env,
			visited,
			"cold",
			undefined,
			activation?.value ?? "nested",
			activation?.cacheable ?? true,
		);
	}

	// A deploy must never reuse a durable aggregate snapshot built from an older
	// tool contract. The original intent was "GIT_SHA is injected by the release
	// workflow" — it never was: the deployed var is the literal wrangler value
	// ("production"), so L2/R2 keys never rolled and a redeploy kept serving
	// snapshots with pre-deploy tool schemas (see `docs/engineering/mcp/runtime.md` "Edge Design Record").
	// `version_metadata` cannot drift the same way — the runtime stamps a fresh
	// id on every deploy, no CI cooperation required. GIT_SHA stays as the
	// fallback for local dev/tests.
	const activationState = await readAggregateActivationEpoch(env);
	const activationEpoch = activationState.value;
	const cacheKey = aggregateSurfaceCacheKey(
		entries,
		env.WORKER_VERSION?.id ?? env.GIT_SHA,
		activationEpoch,
	);
	if (!activationState.cacheable) {
		return aggregateAndPrefixToolsUncached(
			entries,
			env,
			visited,
			"cold",
			rootSlug,
			activationEpoch,
			false,
		);
	}
	pruneExpiredCacheEntries(aggregateSurfaceCache);
	// Consent-composed roots duplicate shared schemas across organizations when
	// serialized. Keep source-app caches and in-flight sharing, but do not retain
	// or deserialize the combined catalog in any snapshot tier.
	const cached = cacheSnapshot
		? aggregateSurfaceCache.get(cacheKey)
		: undefined;
	if (cached && cached.expiresAt > Date.now()) return cached.result;

	const inFlight = aggregateSurfaceInFlight.get(cacheKey);
	if (inFlight) {
		return joinAggregateLoad(
			inFlight,
			cacheKey,
			env,
			rootSlug,
			"joined",
			undefined,
			cacheSnapshot,
		);
	}

	const loadPromise = (async () => {
		// L2 (durable, cross-isolate) before the expensive live rebuild.
		const l2 = cacheSnapshot ? await readAggregateL2(cacheKey) : null;
		if (l2) {
			setBoundedExpiringCacheEntry(
				aggregateSurfaceCache,
				cacheKey,
				{
					result: l2.surface,
					expiresAt: Date.now() + AGGREGATE_SURFACE_CACHE_TTL_MS,
				},
				MAX_AGGREGATE_SURFACE_CACHE_ENTRIES,
			);
			if (l2.stale) {
				// Stale-while-revalidate: serve now, refresh in the background.
				console.log(
					JSON.stringify({ _cm: "aggregate", event: "l2_stale_revalidate" }),
				);
				emitAggregateCacheMetric(env, {
					cacheEvent: "l2_stale_revalidate",
					appSlug: rootSlug,
				});
				const job = revalidateAggregate(
					cacheKey,
					entries,
					env,
					activationEpoch,
					rootSlug,
				);
				if (ctx) ctx.waitUntil(job);
				else void job.catch(() => {});
			} else {
				console.log(JSON.stringify({ _cm: "aggregate", event: "l2_hit" }));
				emitAggregateCacheMetric(env, {
					cacheEvent: "l2_hit",
					appSlug: rootSlug,
				});
			}
			return l2.surface;
		}
		// L3 (durable, global across colos) before the expensive live rebuild.
		const l3 = cacheSnapshot ? await readAggregateR2(env, cacheKey) : null;
		if (l3) {
			setBoundedExpiringCacheEntry(
				aggregateSurfaceCache,
				cacheKey,
				{
					result: l3.surface,
					expiresAt: Date.now() + AGGREGATE_SURFACE_CACHE_TTL_MS,
				},
				MAX_AGGREGATE_SURFACE_CACHE_ENTRIES,
			);
			// Promote R2 → this colo's L2 so subsequent local reads stay warm.
			await writeAggregateL2(cacheKey, l3.surface);
			if (l3.stale) {
				console.log(
					JSON.stringify({ _cm: "aggregate", event: "r2_stale_revalidate" }),
				);
				emitAggregateCacheMetric(env, {
					cacheEvent: "r2_stale_revalidate",
					appSlug: rootSlug,
				});
				const job = revalidateAggregate(
					cacheKey,
					entries,
					env,
					activationEpoch,
					rootSlug,
				);
				if (ctx) ctx.waitUntil(job);
				else void job.catch(() => {});
			} else {
				console.log(JSON.stringify({ _cm: "aggregate", event: "r2_hit" }));
				emitAggregateCacheMetric(env, {
					cacheEvent: "r2_hit",
					appSlug: rootSlug,
				});
			}
			return l3.surface;
		}
		const result = await aggregateAndPrefixToolsUncached(
			entries,
			env,
			visited,
			"cold",
			rootSlug,
			activationEpoch,
			true,
		);
		if (!cacheSnapshot) return result;
		if (!result.degraded) {
			setBoundedExpiringCacheEntry(
				aggregateSurfaceCache,
				cacheKey,
				{
					result,
					expiresAt: Date.now() + AGGREGATE_SURFACE_CACHE_TTL_MS,
				},
				MAX_AGGREGATE_SURFACE_CACHE_ENTRIES,
			);
			await writeAggregateL2(cacheKey, result);
			await writeAggregateR2(env, cacheKey, result, rootSlug);
			return result;
		}
		// Stale-beats-degraded: a degraded cold rebuild (upstream entries dropped —
		// typically the API service binding mid-deploy) silently served a toy
		// surface, so Code Mode namespaces "disappeared" ("skills is not defined").
		// Prefer any previously-known full surface from R2, however old, and let a
		// background revalidate replace it once upstreams recover. The degraded
		// build is served only when no full surface has ever been cached.
		const expired = await readAggregateR2(env, cacheKey, {
			allowExpired: true,
		});
		if (expired) {
			console.warn(
				JSON.stringify({
					_cm: "aggregate",
					event: "degraded_stale_fallback",
					degradedToolCount: result.tools.length,
					staleToolCount: expired.surface.tools.length,
				}),
			);
			emitAggregateCacheMetric(env, {
				cacheEvent: "degraded_stale_fallback",
				appSlug: rootSlug,
				toolCount: expired.surface.tools.length,
			});
			setBoundedExpiringCacheEntry(
				aggregateSurfaceCache,
				cacheKey,
				{
					result: expired.surface,
					expiresAt: Date.now() + AGGREGATE_SURFACE_CACHE_TTL_MS,
				},
				MAX_AGGREGATE_SURFACE_CACHE_ENTRIES,
			);
			const job = revalidateAggregate(
				cacheKey,
				entries,
				env,
				activationEpoch,
				rootSlug,
			);
			if (ctx) ctx.waitUntil(job);
			else void job.catch(() => {});
			return expired.surface;
		}
		return result;
	})();

	// Wedge eviction: if the load somehow never settles despite every await
	// inside it being budgeted, drop it from the dedupe map so the next request
	// rebuilds fresh instead of joining a poisoned promise.
	trackInFlightLoad(aggregateSurfaceInFlight, cacheKey, loadPromise, {
		step: "aggregate_surface_in_flight",
		wedgeEvictMs: AGGREGATE_LOAD_WEDGE_EVICT_MS,
		resource: rootSlug,
	});
	return joinAggregateLoad(
		loadPromise,
		cacheKey,
		env,
		rootSlug,
		"cold",
		undefined,
		cacheSnapshot,
	);
}

/**
 * How long any caller will wait on an aggregate surface load before serving a
 * previously-cached (expired) snapshot instead.
 *
 * This does not make the rebuild faster — it stops the rebuild from being
 * something a request has to survive, because every caller joins the one
 * in-flight rebuild and a single cold key can otherwise stall every concurrent
 * request on the surface. The rebuild is never cancelled; it keeps running and
 * populates the caches for whoever comes next. See `docs/engineering/mcp/runtime.md` "Edge Design Record".
 */
/** Sentinel so a deadline win is distinguishable from a legitimate surface. */
const AGGREGATE_DEADLINE = Symbol("aggregate-join-deadline");

const AGGREGATE_JOIN_DEADLINE_MS = 8_000;

/**
 * Await an aggregate load, but never longer than {@link AGGREGATE_JOIN_DEADLINE_MS}.
 *
 * On deadline, fall back to the newest snapshot R2 has, however old. That is the
 * same "stale beats nothing" judgement the degraded-rebuild path below already
 * makes, applied to slowness instead of upstream failure. If R2 has nothing at
 * all — a genuinely first-ever build for this key — waiting is the only correct
 * option, because an empty surface would silently hide every tool.
 */
export async function joinAggregateLoad(
	load: Promise<AggregatedMcpSurface>,
	cacheKey: string,
	env: CloudflareEnv,
	rootSlug: string | undefined,
	kind: "cold" | "joined",
	deadlineMs: number = AGGREGATE_JOIN_DEADLINE_MS,
	cacheSnapshot = true,
): Promise<AggregatedMcpSurface> {
	// Transient roots have no safe serialized fallback. The shared load itself
	// remains bounded by its upstream step budgets.
	if (!cacheSnapshot) return load;
	// The load owns its own lifecycle; a deadline here must never turn into an
	// unhandled rejection when we stop waiting on it.
	load.catch(() => {});

	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<typeof AGGREGATE_DEADLINE>((resolve) => {
		timer = setTimeout(() => resolve(AGGREGATE_DEADLINE), deadlineMs);
	});
	try {
		const winner = await Promise.race([load, deadline]);
		if (winner !== AGGREGATE_DEADLINE) return winner;
	} finally {
		if (timer) clearTimeout(timer);
	}

	const expired = await readAggregateR2(env, cacheKey, { allowExpired: true });
	if (expired) {
		console.warn(
			JSON.stringify({
				_cm: "aggregate",
				event: "join_deadline_stale_fallback",
				kind,
				deadlineMs,
				staleToolCount: expired.surface.tools.length,
			}),
		);
		emitAggregateCacheMetric(env, {
			cacheEvent: "join_deadline_stale_fallback",
			appSlug: rootSlug,
			toolCount: expired.surface.tools.length,
		});
		return expired.surface;
	}

	// Nothing cached has ever existed for this key. Serving an empty surface here
	// would look like "all tools disappeared", which is worse than being slow.
	console.warn(
		JSON.stringify({
			_cm: "aggregate",
			event: "join_deadline_no_fallback",
			kind,
			deadlineMs,
		}),
	);
	return load;
}

/**
 * Slugs per batched `apps.getBySlugsWithTools` call.
 *
 * A memory bound, not a bound-parameter one (the query chunks its own
 * `inArray`s): hydrating several app surfaces at once in one isolate is what
 * produced the `exceededMemory` kills on `getAppBySlugWithTools`. See
 * `docs/engineering/mcp/runtime.md` "Edge Design Record".
 */
const AGGREGATE_PREFETCH_CHUNK = 20;

/**
 * Coalescing window for aggregate prefetches.
 *
 * A nested aggregate's entries are only discovered once its parent resolves,
 * so each nested level would call the prefetch again with a single entry and
 * pay a full cold apps/api round trip. Parents resolve concurrently, so those
 * nested prefetches land within a short window of each other — a coalescing
 * problem, not a recursion problem. Buffering arrivals and flushing them as
 * one chunked batch leaves recursion semantics untouched, and subsumes the
 * earlier same-set single-flight guard (concurrent rebuilds of the same
 * aggregate merge into one buffer and issue exactly one batched call).
 * Rationale: `docs/engineering/mcp/runtime.md` "Edge Design Record".
 */
const AGGREGATE_PREFETCH_COALESCE_MS = 25;

type AggregatePrefetchRequest = {
	slug: string;
	appId?: string;
	hostOrganizationId?: string;
	endpointPrefixes?: string[];
	toolIds?: string[];
	cacheable: boolean;
};

/** Keys awaiting the next flush. Swapped out wholesale when the window closes. */
let aggregatePrefetchBuffer = new Map<string, AggregatePrefetchRequest>();
/** The in-flight flush that will include everything currently buffered. */
let aggregatePrefetchFlush: Promise<void> | null = null;

/**
 * Deadline for the batched prefetch. Same budget as one ordinary upstream
 * attempt ({@link UPSTREAM_ATTEMPT_TIMEOUT_MS}), because that is exactly what it
 * is: one apps/api call that may land on a cold isolate. On timeout the prefetch
 * simply seeds nothing and every entry falls back to its own resolve, which is
 * the pre-batch behaviour — never a rebuild failure.
 */
const AGGREGATE_PREFETCH_TIMEOUT_MS = UPSTREAM_ATTEMPT_TIMEOUT_MS;

/**
 * Resolve every aggregate entry in one upstream call per 20 apps, seeding the
 * per-slug L1 cache that {@link resolveUpstreamToolsInternally} already reads.
 * This removes the entry-resolution fan-out that degraded whole surfaces; see
 * `docs/engineering/mcp/runtime.md` "Edge Design Record".
 *
 * Deliberately a cache seed and not a new resolution path: entry resolution,
 * cycle detection, per-entry timeouts, nested-aggregate recursion, the
 * `resolutionFailed` degrade and the L1 TTL are all untouched. If this call
 * fails, times out, or returns short, the entries resolve exactly as they did
 * before — one at a time. Fail-open by construction.
 */
/**
 * Run one chunked batch for everything buffered when the window closed.
 * Fail-open: prefetch is optional acceleration, so a rejection is reported and
 * swallowed — every entry still resolves itself through the normal path.
 */
async function flushAggregatePrefetch(env: CloudflareEnv): Promise<void> {
	const buffered = aggregatePrefetchBuffer;
	aggregatePrefetchBuffer = new Map();
	aggregatePrefetchFlush = null;
	if (buffered.size === 0) return;

	const requests = [...buffered.entries()];
	const started = Date.now();
	try {
		const client = getApiClient({
			serviceFetch: env.API_SERVICE,
		});
		const chunks: Array<typeof requests> = [];
		for (let i = 0; i < requests.length; i += AGGREGATE_PREFETCH_CHUNK) {
			chunks.push(requests.slice(i, i + AGGREGATE_PREFETCH_CHUNK));
		}
		await withUpstreamAttemptDeadline(
			Promise.all(
				chunks.map(async (chunk) => {
					const { results } = await client.apps.getBySlugsWithTools({
						apps: chunk.map(([, request]) => request),
					});
					// Positional contract: results[i] answers apps[i]. A short or
					// misaligned response seeds only what it can prove, and the rest
					// falls back to per-entry resolution.
					chunk.forEach(([cacheKey, request], index) => {
						const result = results[index];
						if (!result || result.slug !== request.slug) return;
						// A batched `app: null` is an answer, so it is seeded like any
						// other. (The single-slug path leaves not-found uncached; here
						// that would mean a dead aggregate entry re-creating one cold
						// apps/api isolate per rebuild forever.) It cannot delay a newly
						// created app noticeably: this TTL is 120s and the aggregate
						// surface it feeds is itself cached for at least that long.
						if (request.cacheable) {
							setBoundedExpiringCacheEntry(
								internalToolCache,
								cacheKey,
								{
									result: toInternalResolveResult(request.slug, result),
									expiresAt: Date.now() + INTERNAL_TOOL_CACHE_TTL_MS,
								},
								MAX_INTERNAL_TOOL_CACHE_ENTRIES,
							);
						}
					});
				}),
			),
			AGGREGATE_PREFETCH_TIMEOUT_MS,
		);
		console.log(
			JSON.stringify({
				_cm: "aggregate",
				event: "prefetch",
				apps: requests.length,
				calls: chunks.length,
				ms: Date.now() - started,
			}),
		);
	} catch (error) {
		log.warn("Aggregate prefetch failed", {
			event: "aggregate.prefetch_failed",
			outcome: "unavailable",
			durationMs: Date.now() - started,
			error: contentFreeMcpException(error),
		});
	}
}

async function prefetchAggregateEntries(
	entries: AggregateAppEntry[],
	env: CloudflareEnv,
	visited: Set<string>,
	activationEpoch: string,
	cacheable: boolean,
): Promise<void> {
	const now = Date.now();
	const wanted = new Map<string, AggregatePrefetchRequest>();
	for (const entry of entries) {
		if (isAggregateSourceVisited(visited, entry)) continue;
		const selection = {
			...(entry.endpointPrefixes?.length
				? { endpointPrefixes: entry.endpointPrefixes }
				: {}),
			...(entry.toolIds?.length ? { toolIds: entry.toolIds } : {}),
		};
		const cacheKey = internalToolCacheKey(entry, selection, activationEpoch);
		if (wanted.has(cacheKey)) continue;
		if (cacheable) pruneExpiredCacheEntries(internalToolCache);
		const cached = cacheable ? internalToolCache.get(cacheKey) : undefined;
		if (cached && cached.expiresAt > now) continue;
		if (cacheable && internalToolInFlight.has(cacheKey)) continue;
		wanted.set(cacheKey, {
			slug: entry.slug,
			...(entry.appId
				? {
						appId: entry.appId,
						...(entry.hostOrganizationId
							? { hostOrganizationId: entry.hostOrganizationId }
							: {}),
					}
				: {}),
			...selection,
			cacheable,
		});
	}
	if (wanted.size === 0) return;

	// Buffer, then join the pending window. Adding and scheduling happen with no
	// await in between, so the window cannot close between them and drop these
	// keys into a flush this caller is not awaiting.
	for (const [cacheKey, request] of wanted) {
		if (!aggregatePrefetchBuffer.has(cacheKey)) {
			aggregatePrefetchBuffer.set(cacheKey, request);
		}
	}
	aggregatePrefetchFlush ??= new Promise<void>((resolve) => {
		setTimeout(() => {
			resolve(flushAggregatePrefetch(env));
		}, AGGREGATE_PREFETCH_COALESCE_MS);
	});
	await aggregatePrefetchFlush.catch(() => undefined);
}

/** Bound one prefetch so a wedged upstream cannot delay the per-entry fallback. */
function withUpstreamAttemptDeadline<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(new Error(`aggregate prefetch timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);
	});
	promise.catch(() => {});
	return Promise.race([promise, deadline]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

async function aggregateAndPrefixToolsUncached(
	entries: AggregateAppEntry[],
	env: CloudflareEnv,
	visited: Set<string> = new Set(),
	// "cold" = a real cold miss (L1+L2+L3 all missed); "revalidate" = a background
	// SWR refresh (which emits its own `revalidated` metric). Only "cold" emits the
	// `cold_rebuild` metric, so the cold-miss rate isn't inflated by revalidations.
	reason: "cold" | "revalidate" = "cold",
	rootSlug?: string,
	activationEpoch = "direct",
	cacheable = true,
): Promise<AggregatedMcpSurface> {
	// Per-stage timing: aggregate hydration is the dominant Code Mode cold-start
	// cost (live D1/service-binding fan-out across the aggregate apps). Time each
	// upstream resolution and emit a `_cm:"aggregate"` summary at the top level so
	// slow cold inits are diagnosable from logs without guesswork (pairs with the
	// existing `_cm:"rpc"`/`_cm:"exec"` lines). Only the top frame (visited.size
	// === 0) logs; nested recursion contributes timings but stays quiet.
	const aggregateStart = Date.now();
	// one upstream call per 20 apps instead of one per app. Everything below is
	// unchanged and still correct if this seeds nothing.
	if (cacheable) {
		await prefetchAggregateEntries(
			entries,
			env,
			visited,
			activationEpoch,
			cacheable,
		);
	}
	const entryTimings: Array<{ slug: string; resolveMs: number }> = [];
	const results = await Promise.all(
		entries.map(async (entry) => {
			// Cycle guard: skip if this source is already on the resolution stack.
			if (isAggregateSourceVisited(visited, entry)) {
				console.warn(
					`[aggregate] Cycle detected: ${entry.appId ?? entry.slug} already in [${[...visited].join(", ")}], skipping`,
				);
				return { tools: [], resources: [], resourceTemplates: [], prompts: [] };
			}
			const resolveStart = Date.now();
			// Soft per-entry timeout: race the upstream resolve against a deadline
			// that yields `null`. A timed-out (flapping) app is dropped as a degraded
			// partial via the existing resolutionFailed path below, so it cannot hold
			// the whole `Promise.all` open.
			let entryTimer: ReturnType<typeof setTimeout> | undefined;
			const resolved = await Promise.race([
				resolveUpstreamToolsInternally(
					entry,
					env,
					{
						endpointPrefixes: entry.endpointPrefixes,
						toolIds: entry.toolIds,
					},
					activationEpoch,
					cacheable,
				),
				new Promise<null>((resolveTimeout) => {
					entryTimer = setTimeout(() => {
						console.warn(
							JSON.stringify({
								_cm: "aggregate",
								event: "entry_timeout",
								slug: entry.slug,
								timeoutMs: AGGREGATE_ENTRY_TIMEOUT_MS,
							}),
						);
						emitAggregateCacheMetric(env, {
							cacheEvent: "entry_timeout",
							appSlug: rootSlug,
							slug: entry.slug,
							totalMs: AGGREGATE_ENTRY_TIMEOUT_MS,
						});
						resolveTimeout(null);
					}, AGGREGATE_ENTRY_TIMEOUT_MS);
				}),
			]);
			if (entryTimer) clearTimeout(entryTimer);
			entryTimings.push({
				slug: entry.slug,
				resolveMs: Date.now() - resolveStart,
			});
			if (!resolved) {
				return {
					tools: [],
					resources: [],
					resourceTemplates: [],
					prompts: [],
					degraded: true,
				};
			}
			const {
				tools,
				appId: sourceAppId,
				appSlug: resolvedAppSlug,
				organizationId: sourceOrganizationId,
				upstreamMcpUrl,
				aggregateApps: nestedAggregateApps,
				connectionLabel: appConnectionLabel,
				connectionInstanceId: appConnectionInstanceId,
				connectionProviderId: appConnectionProviderId,
				connectionScope: appConnectionScope,
				connectionScopes: appConnectionScopes,
				catalogResources: appCatalogResources,
				catalogResourceTemplates: appCatalogResourceTemplates,
				catalogPrompts: appCatalogPrompts,
				forwardedQueryParams: appForwardedQueryParams,
				resolutionFailed,
				toolScopes: appToolScopes,
			} = resolved;
			if (resolutionFailed) {
				return {
					tools: [],
					resources: [],
					resourceTemplates: [],
					prompts: [],
					degraded: true,
				};
			}
			const prefix = entry.prefix ?? entry.slug;
			const forwardedQueryParams =
				entry.forwardedQueryParams ?? appForwardedQueryParams ?? undefined;

			// A tool with no recorded write capability is withheld, not exposed:
			// the rule only ever admits what is positively known to be a read.
			const mountable = entry.readOnly
				? tools.filter((tool) => tool.writeCapability === "read")
				: tools;
			// The source app's current slug. An id-linked entry may still store the
			// slug the app had when it was linked.
			const sourceSlug = resolvedAppSlug ?? entry.slug;
			// Nested entries live in this source app's `aggregateApps`, so its
			// organization is their host for the id ownership rule. Without a
			// resolved organization an id-linked nested entry resolves to nothing.
			const nestedHostOrganizationId = sourceOrganizationId ?? undefined;
			const nestedEntries = ensurePlatformOperatorAggregateApps(
				sourceSlug,
				nestedAggregateApps ?? [],
			).map((sub) => {
				const providerId =
					entry.connectionProviderId ??
					sub.connectionProviderId ??
					appConnectionProviderId;
				const subAccount =
					(!sub.connectionProviderId ||
						sub.connectionProviderId === providerId) &&
					"connectionInstanceId" in sub
						? sub.connectionInstanceId
						: undefined;
				const appAccount =
					appConnectionProviderId === providerId
						? appConnectionInstanceId
						: undefined;
				return {
					slug: sub.slug,
					...(typeof sub.appId === "string" && sub.appId
						? {
								appId: sub.appId,
								...(nestedHostOrganizationId
									? { hostOrganizationId: nestedHostOrganizationId }
									: {}),
							}
						: {}),
					organizationId: entry.organizationId,
					toolIds: sub.toolIds,
					endpointPrefixes: sub.endpointPrefixes,
					readOnly: entry.readOnly === true || sub.readOnly === true,
					// Apps inside a Connect organization mount keep their own
					// namespace; deeper nesting still groups under its parent.
					prefix: entry.organizationMount
						? organizationAppNamespace(prefix, sub)
						: prefix,
					legacyNamespace: entry.organizationMount
						? prefix
						: entry.legacyNamespace,
					connectionLabel:
						entry.connectionLabel ??
						sub.connectionLabel ??
						appConnectionLabel ??
						undefined,
					connectionProviderId:
						entry.connectionProviderId ??
						sub.connectionProviderId ??
						appConnectionProviderId ??
						undefined,
					connectionInstanceId:
						entry.connectionInstanceId ?? subAccount ?? appAccount,
					connectionScope: entry.connectionInstanceId
						? entry.connectionScope
						: subAccount
							? sub.connectionScope
							: appAccount
								? (appConnectionScope ?? undefined)
								: (entry.connectionScope ??
									sub.connectionScope ??
									(appConnectionInstanceId ? undefined : appConnectionScope) ??
									undefined),
					connectionScopes:
						entry.connectionScopes ??
						sub.connectionScopes ??
						appConnectionScopes ??
						undefined,
					forwardedQueryParams:
						entry.forwardedQueryParams ??
						sub.forwardedQueryParams ??
						appForwardedQueryParams ??
						undefined,
				};
			});
			// Connect evaluates scopes against its own config. Carry the selected
			// organization's reviewed scopes to the namespaces Connect serves: the
			// gateway's per-app keys, and each mounted app's own per-tool keys.
			const entryToolScopes: Record<string, string[]> = {
				...(entry.legacyNamespace
					? mountedAppToolScopes(
							prefix,
							mountable.map((tool) => tool.toolId),
							appToolScopes,
						)
					: {}),
				...(entry.organizationMount
					? organizationMountToolScopes(
							prefix,
							ensurePlatformOperatorAggregateApps(
								sourceSlug,
								nestedAggregateApps ?? [],
							),
							appToolScopes,
						)
					: {}),
			};
			const loadNestedSurface = () => {
				const nestedVisited = new Set(visited);
				// Record the source by current slug and by id so a cycle is caught
				// whichever way a descendant links back to it.
				if (!entry.appId) nestedVisited.add(entry.slug);
				nestedVisited.add(sourceSlug);
				if (sourceAppId) nestedVisited.add(sourceAppId);
				return aggregateAndPrefixTools(
					nestedEntries,
					env,
					nestedVisited,
					undefined,
					undefined,
					{ value: activationEpoch, cacheable },
				);
			};

			// D1 path: app has native tools stored in D1. A zero-tool proxy may
			// still expose the catalog resources/prompts inherited from its base app;
			// those surfaces must not prevent the nested aggregate below from loading
			// the base app's tools. The nested result carries the same catalog surface.
			if (
				mountable.length > 0 ||
				((!nestedAggregateApps || nestedAggregateApps.length === 0) &&
					(appCatalogResources.length > 0 ||
						appCatalogResourceTemplates.length > 0 ||
						appCatalogPrompts.length > 0))
			) {
				const effectiveLabel =
					entry.connectionLabel ?? appConnectionLabel ?? undefined;
				const effectiveConnectionProviderId =
					entry.connectionProviderId ?? appConnectionProviderId ?? undefined;
				const inheritedAccount =
					effectiveConnectionProviderId === appConnectionProviderId
						? appConnectionInstanceId
						: undefined;
				const effectiveConnectionInstanceId =
					entry.connectionInstanceId ?? inheritedAccount;
				const effectiveConnectionScope = entry.connectionInstanceId
					? (entry.connectionScope ?? appConnectionScope ?? undefined)
					: inheritedAccount
						? (appConnectionScope ?? undefined)
						: (entry.connectionScope ??
							(appConnectionInstanceId ? undefined : appConnectionScope) ??
							undefined);
				const effectiveConnectionScopes =
					entry.connectionScopes ?? appConnectionScopes ?? undefined;
				const d1Tools = mountable.map((tool): InternalAppTool => {
					const existingConfig =
						typeof tool.config === "object" && tool.config !== null
							? (tool.config as Record<string, unknown>)
							: {};
					const aggregateConfig = withAggregateConnectionProvider(
						existingConfig,
						{
							connectionProviderId: effectiveConnectionProviderId,
							connectionScope: effectiveConnectionScope,
							connectionScopes: effectiveConnectionScopes,
						},
					);
					return {
						...tool,
						toolId: `${prefix}__${tool.toolId}`,
						title: `${prefix}__${tool.title}`,
						config: {
							...aggregateConfig,
							...(sourceAppId ? { _sourceAppId: sourceAppId } : {}),
							_sourceAppSlug: sourceSlug,
							...(entry.organizationId
								? { _multiOrgOrganizationId: entry.organizationId }
								: {}),
							_sourceAuthRequired: tool.authRequired ?? false,
							_sourceVisibility: tool.visibility ?? "public",
							// _aggregateNamespace: when the aggregating entry sets `prefix`,
							// force resolveNamespace() to use it instead of deriving from
							// `endpoint`. Resolves namespace collisions when multiple
							// per-tenant proxies share the same endpoint domain (e.g.
							// several tenant content proxies all use `content/*`
							// endpoints).
							...(entry.prefix ? { _aggregateNamespace: entry.prefix } : {}),
							...(entry.legacyNamespace
								? { _aggregateLegacyNamespace: entry.legacyNamespace }
								: {}),
							...(effectiveLabel !== undefined
								? { _aggregateConnectionLabel: effectiveLabel }
								: {}),
							...(effectiveConnectionInstanceId
								? {
										_aggregateConnectionInstanceId:
											effectiveConnectionInstanceId,
									}
								: {}),
							...(forwardedQueryParams
								? { _forwardedQueryParams: forwardedQueryParams }
								: {}),
						},
					};
				});
				// A selected organization's unified gateway can own tools and also
				// aggregate source apps. Include both under its verified namespace.
				const nestedSurface =
					entry.organizationId && nestedEntries.length > 0
						? await loadNestedSurface()
						: null;

				return {
					tools: [...d1Tools, ...(nestedSurface?.tools ?? [])],
					resources: [
						...appCatalogResources.map((resource) => ({
							...resource,
							connectionProviderId:
								effectiveConnectionProviderId ??
								resource.connectionProviderId ??
								null,
							connectionScope:
								effectiveConnectionScope ?? resource.connectionScope ?? null,
							connectionScopes:
								effectiveConnectionScopes ?? resource.connectionScopes ?? null,
						})),
						...(nestedSurface?.resources ?? []),
					],
					resourceTemplates: [
						...appCatalogResourceTemplates.map((template) => ({
							...template,
							connectionProviderId:
								effectiveConnectionProviderId ??
								template.connectionProviderId ??
								null,
							connectionScope:
								effectiveConnectionScope ?? template.connectionScope ?? null,
							connectionScopes:
								effectiveConnectionScopes ?? template.connectionScopes ?? null,
						})),
						...(nestedSurface?.resourceTemplates ?? []),
					],
					prompts: [
						...appCatalogPrompts.map((prompt) => ({
							...prompt,
							promptName: `${prefix}__${prompt.promptName}`,
							upstreamPromptName: prompt.promptName,
							connectionProviderId:
								effectiveConnectionProviderId ??
								prompt.connectionProviderId ??
								null,
							connectionScope:
								effectiveConnectionScope ?? prompt.connectionScope ?? null,
							connectionScopes:
								effectiveConnectionScopes ?? prompt.connectionScopes ?? null,
						})),
						...(nestedSurface?.prompts ?? []),
					],
					degraded: nestedSurface?.degraded,
					toolScopes: {
						...entryToolScopes,
						...nestedSurface?.toolScopes,
					},
				};
			}

			if (upstreamMcpUrl) {
				console.warn(
					`[aggregate] App ${entry.slug} has upstreamMcpUrl but no D1 app_tools; app-level upstream URL execution is disabled. Run catalog.sync_catalog_tools_to_app to sync tools.`,
				);
				return { tools: [], resources: [], resourceTemplates: [], prompts: [] };
			}

			// Nested-aggregate fallback: upstream has no tools and no upstreamMcpUrl,
			// but uses its own aggregateApps. Recurse, preserving this entry's prefix
			// (so all chained tools group under the top-level app's namespace) and
			// passing through the entry's connectionLabel (defaults to upstream's own
			// label if the entry didn't override). E.g. tedix-unified → cloudflare-tedix
			// (aggregateApps:[cloudflare]) → cloudflare D1 tools, prefixed cloudflare-tedix__*.
			if (nestedEntries.length > 0) {
				const nested = await loadNestedSurface();
				return {
					...nested,
					toolScopes: { ...entryToolScopes, ...nested.toolScopes },
				};
			}

			return { tools: [], resources: [], resourceTemplates: [], prompts: [] };
		}),
	);
	const surface = {
		tools: results.flatMap((result) => result.tools),
		resources: results.flatMap((result) => result.resources),
		resourceTemplates: results.flatMap((result) => result.resourceTemplates),
		prompts: results.flatMap((result) => result.prompts),
		degraded: results.some((result) => result.degraded),
		toolScopes: Object.assign(
			{},
			...results.map(
				(result) =>
					(result as { toolScopes?: Record<string, string[]> }).toolScopes ??
					{},
			),
		) as Record<string, string[]>,
	};
	if (visited.size === 0) {
		const slowest = [...entryTimings]
			.sort((a, b) => b.resolveMs - a.resolveMs)
			.slice(0, 5);
		const totalMs = Date.now() - aggregateStart;
		console.log(
			JSON.stringify({
				_cm: "aggregate",
				totalMs,
				appCount: entries.length,
				toolCount: surface.tools.length,
				resourceCount: surface.resources.length,
				degraded: surface.degraded,
				slowestResolves: slowest,
			}),
		);
		// cold_rebuild = a full live fan-out from a true cold miss (L1+L2+L3 all
		// missed). Background revalidations (reason "revalidate") also run this
		// summary but emit `revalidated` instead, so they must not count as cold
		// misses — otherwise the cold-miss rate is inflated by SWR refreshes.
		if (reason === "cold") {
			emitAggregateCacheMetric(env, {
				cacheEvent: "cold_rebuild",
				appSlug: rootSlug,
				totalMs,
				appCount: entries.length,
				toolCount: surface.tools.length,
				degraded: surface.degraded,
			});
		}
	}
	return surface;
}

// =============================================================================
// stateless MCP handler
// =============================================================================

/**
 * Handle MCP request statelessly — new McpServer per request.
 * Tool data cached in Worker memory (60s TTL).
 */
function normalizeOrigin(origin: string): string | null {
	try {
		return new URL(origin).origin;
	} catch {
		return null;
	}
}

function getAllowedMcpOrigins(
	request: Request,
	env: CloudflareEnv,
	resolvedApp?: ResolvedApp | null,
): string[] {
	const allowed = new Set(buildCorsOrigins(env, resolvedApp?.metadata ?? null));
	allowed.add(new URL(request.url).origin);
	return [...allowed]
		.map((origin) => normalizeOrigin(origin))
		.filter((origin): origin is string => Boolean(origin));
}

function validateMcpOrigin(
	request: Request,
	env: CloudflareEnv,
	resolvedApp?: ResolvedApp | null,
): { response: Response; reason: McpAccessDenialReason } | null {
	const requestOrigin =
		request.headers.get("Origin") ?? request.headers.get("origin");
	if (!requestOrigin) return null;

	const normalizedOrigin = normalizeOrigin(requestOrigin);
	if (!normalizedOrigin) {
		return {
			response: new Response(
				JSON.stringify({
					error: "forbidden_origin",
					message: "Invalid Origin header",
				}),
				{ status: 403, headers: { "Content-Type": "application/json" } },
			),
			reason: "invalid_origin",
		};
	}

	const allowedOrigins = getAllowedMcpOrigins(request, env, resolvedApp);
	if (allowedOrigins.includes(normalizedOrigin)) return null;

	return {
		response: new Response(
			JSON.stringify({
				error: "forbidden_origin",
				message: "Origin is not allowed for this MCP endpoint",
			}),
			{ status: 403, headers: { "Content-Type": "application/json" } },
		),
		reason: "forbidden_origin",
	};
}

export async function enforceMcpAccess(params: {
	request: Request;
	hostname: string;
	resolvedApp: ResolvedApp;
	env: CloudflareEnv;
	oauthJwtPayload: unknown;
	/** Only populated by the per-request live multi-org grant verifier. */
	multiOrgSelection?: MultiOrgMcpSelection | null;
	isDev: boolean;
}): Promise<{ response: Response; reason: McpAccessDenialReason } | null> {
	const {
		request,
		hostname,
		resolvedApp,
		env,
		oauthJwtPayload,
		multiOrgSelection,
		isDev,
	} = params;
	const { app, metadata, tools } = resolvedApp;
	if (request.headers.get("x-tedix-auth-credential-mode") === "delegated-mcp") {
		const requested = await extractMcpToolCallName(request);
		if (requested && requested !== "code") {
			const tool = tools.find((candidate) => candidate.toolId === requested);
			const namespace = tool
				? resolveMcpToolNamespace(
						tool,
						metadata?.mcpConfig?.codeModeNamespaces as
							| Record<string, string>
							| undefined,
					)
				: (requested.split("__")[0] ?? "");
			if (
				isDelegatedWorkTool(
					requested,
					namespace,
					tool?.config,
					tool?.toolTypeId,
				)
			) {
				return {
					response: new Response(
						JSON.stringify({ error: "delegated_work_tool_denied" }),
						{
							status: 403,
							headers: { "Content-Type": "application/json" },
						},
					),
					reason: "insufficient_scope",
				};
			}
		}
	}
	const mcpAuthMode = metadata?.mcpConfig?.authMode ?? "authenticated";

	if (
		(mcpAuthMode === "authenticated" || mcpAuthMode === "proxy-target") &&
		!request.headers.get("x-tedix-auth-type")
	) {
		const advertisedScopes = collectAdvertisedScopes({
			mcpConfig: metadata?.mcpConfig,
			tools: tools.map((tool) => ({
				name: tool.toolId,
				description: tool.description ?? undefined,
			})),
		});
		const hasOAuth = advertisedScopes.length > 0;
		const wwwAuth = hasOAuth
			? buildWwwAuthenticate(
					hostname,
					undefined,
					undefined,
					metadata?.mcpConfig?.challengeScopes,
				)
			: 'Bearer realm="MCP"';

		return {
			response: new Response(
				JSON.stringify({
					error: "Authentication required",
					message:
						"This MCP server requires authentication. Provide a Bearer token in the Authorization header.",
				}),
				{
					status: 401,
					headers: {
						"Content-Type": "application/json",
						"WWW-Authenticate": wwwAuth,
					},
				},
			),
			reason: "authentication_required",
		};
	}

	if (
		request.headers.get("x-tedix-auth-credential-mode") === "direct-tedi-jwt" &&
		app.organizationId
	) {
		return {
			response: new Response(
				JSON.stringify({
					error: "direct_tedi_jwt_not_allowed",
					message:
						"Tedi access-key JWTs do not directly authorize app MCP servers. Resolve assigned app credentials through the identity provider.",
				}),
				{
					status: 403,
					headers: { "Content-Type": "application/json" },
				},
			),
			reason: "direct_tedi_jwt_not_allowed",
		};
	}

	if (app.organizationId) {
		const payload =
			typeof oauthJwtPayload === "object" && oauthJwtPayload !== null
				? (oauthJwtPayload as { entityType?: unknown })
				: null;
		// Connect authority comes from the verified selected organizations, not
		// the browser session's active tenant. Ordinary app grants retain dct matching.
		const verifiedConnectSelection =
			hostname === "connect.mcp.tedix.dev" &&
			app.slug === "connect" &&
			metadata?.mcpConfig?.multiOrgConsent === true &&
			(multiOrgSelection?.organizations.length ?? 0) > 0;
		const verifiedConnectTarget =
			hostname === "connect.mcp.tedix.dev" &&
			multiOrgSelection?.organizations.some(
				(organization) =>
					organization.organizationId === app.organizationId &&
					organization.gatewaySlug === app.slug,
			) === true;
		if (
			!verifiedConnectSelection &&
			!verifiedConnectTarget &&
			shouldEnforceTenantMatchForOAuth(request.headers, payload)
		) {
			let match: { ok: true } | { ok: false; reason: string };
			try {
				match = await jwtTenantMatchesApp(
					oauthJwtPayload as Parameters<typeof jwtTenantMatchesApp>[0],
					app.organizationId,
					env,
				);
			} catch (error) {
				log.error("Tenant match check failed; denying request", {
					event: "router.tenant_match_failed",
					appId: app.id,
					appSlug: app.slug,
					organizationId: app.organizationId,
					outcome: "denied",
					error: contentFreeMcpException(error),
				});
				match = { ok: false, reason: "tenant_match_check_failed" };
			}
			if (!match.ok) {
				console.warn(
					`[MCP TenantMatch] reject — app=${app.slug} org=${app.organizationId} reason=${match.reason}`,
				);
				return {
					response: new Response(
						JSON.stringify({
							error: "tenant_mismatch",
							message:
								"Your token was issued for a different tenant. Switch to the correct organization in Tedix OS before connecting this MCP server.",
							detail: match.reason,
						}),
						{
							status: 403,
							headers: { "Content-Type": "application/json" },
						},
					),
					reason:
						match.reason === "tenant_match_check_failed"
							? "tenant_match_check_failed"
							: "tenant_mismatch",
				};
			}
		}
	}
	const mcpConfig = metadata?.mcpConfig as Record<string, unknown> | undefined;
	const enforcePolicies = mcpConfig?.enforcePolicies === true;
	const toolScopes = mcpConfig?.toolScopes as
		| Record<string, string[]>
		| undefined;
	if (
		toolScopes ||
		enforcePolicies ||
		tools.some((tool) => tool.authRequired)
	) {
		const requiredScopes = enforcePolicies
			? await extractPolicyRequiredScopes(request, mcpConfig)
			: await extractRequiredScopes(request, toolScopes, tools, mcpConfig);
		if (requiredScopes && requiredScopes.length > 0) {
			const authType = request.headers.get("x-tedix-auth-type");
			if (!authType) {
				if (mcpAuthMode === "hybrid") {
					// SEP-2350: the RFC 6750 `scope` parameter is what lets a client
					// compute the union of its existing grant and the newly required
					// scopes and re-authorize. Carrying the list only in the human
					// `error_description` leaves the challenge machine-unreadable.
					const wwwAuthValue = buildWwwAuthenticate(
						hostname,
						"insufficient_scope",
						`Authentication required. Scopes needed: ${requiredScopes.join(" ")}`,
						requiredScopes,
					);
					let rpcId: string | number | null = null;
					try {
						const body = (await request.clone().json()) as {
							id?: string | number;
						};
						rpcId = body?.id ?? null;
					} catch {
						/* not JSON-RPC */
					}

					return {
						response: new Response(
							JSON.stringify({
								jsonrpc: "2.0",
								id: rpcId,
								result: {
									content: [
										{
											type: "text",
											text: `Authentication required: you need to log in to use this tool. Required scopes: ${requiredScopes.join(", ")}`,
										},
									],
									_meta: {
										"mcp/www_authenticate": [wwwAuthValue],
									},
									isError: true,
								},
							}),
							{
								status: 200,
								headers: {
									"Content-Type": "application/json",
									"WWW-Authenticate": wwwAuthValue,
								},
							},
						),
						reason: "authentication_required",
					};
				}
				return {
					response: new Response(
						JSON.stringify({
							error: "authentication_required",
							required_scopes: requiredScopes,
							message: "This tool requires authentication.",
						}),
						{
							status: 401,
							headers: {
								"Content-Type": "application/json",
								// SEP-2350: advertise the scopes this call needs so the
								// client can request them on first authorization instead of
								// discovering the gap one denial at a time.
								"WWW-Authenticate": buildWwwAuthenticate(
									hostname,
									undefined,
									undefined,
									requiredScopes,
								),
							},
						},
					),
					reason: "authentication_required",
				};
			}
			if (shouldEnforceMcpToolScopes(authType)) {
				const tokenScopes = (request.headers.get("x-tedix-auth-scopes") ?? "")
					.split(" ")
					.filter(Boolean);
				const missingScopes = requiredScopes.filter(
					(scope) => !hasScope(tokenScopes, scope),
				);
				if (missingScopes.length > 0) {
					return {
						response: new Response(
							JSON.stringify({
								error: "insufficient_scope",
								required_scopes: requiredScopes,
								missing_scopes: missingScopes,
							}),
							{
								status: 403,
								headers: {
									"Content-Type": "application/json",
									"WWW-Authenticate": buildWwwAuthenticate(
										hostname,
										"insufficient_scope",
										`Missing scopes: ${missingScopes.join(" ")}`,
										missingScopes,
									),
								},
							},
						),
						reason: "insufficient_scope",
					};
				}
			} else if (authType === "service" && isDev) {
				console.log(
					`[MCP Auth] Service binding accessing scope-restricted tool (scopes: ${requiredScopes.join(", ")})`,
				);
			}
		}
	}

	return null;
}

export async function handleMcpRequest(
	request: Request,
	resolvedApp: ResolvedApp,
	env: CloudflareEnv,
	ctx: ExecutionContext,
	multiOrgSelection?: MultiOrgMcpSelection | null,
	interactionEventsEnabled = resolvedApp.metadata?.mcpConfig
		?.interactionEvents === true &&
		Boolean((env as McpSubscriptionBindingEnv).MCP_SUBSCRIPTIONS),
): Promise<Response> {
	const eventResponse = await maybeHandleInteractionEvents(
		request,
		env,
		interactionEventsEnabled,
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
	// A programmatic direct call to a first-class home/kernel surface tool — e.g. a
	// skill-runtime goal-loop calling `ask` through the env.MCP bridge —
	// does not need the aggregate-app fan-out (the home surface is mounted
	// separately below, and `home__*`/`kernel__*` tools never come from the
	// aggregate). Skipping the fan-out removes the cold multi-second aggregate build
	// from the hot path for those direct calls. Operator/Code Mode/oauth callers and
	// aggregate-tool calls are unaffected (they don't satisfy the bypass).
	const directHomeKernelCall =
		!!requestedToolName &&
		(requestedToolName === "ask" ||
			requestedToolName.startsWith("home__") ||
			requestedToolName.startsWith("kernel__")) &&
		shouldBypassCodeModeForCaller(callerIdentity, requestedToolName);
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
		requestedCodeModeNamespaces,
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
			requestedCodeModeNamespaces &&
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
		requestedCodeModeNamespaces,
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

	// First-class "home" namespace (docs/engineering/product/tedix-os.md Home MCP Contract): expose
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
			}),
		);
	}
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
	return mountMcp(server, request, {
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
			supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
			serverInfo: resolvedMcpServerInfo(resolvedApp),
			instructions: modernDiscoverInstructions(resolvedApp),
			capabilities: {
				...(interactionEventsEnabled ? { events: {} } : {}),
				tools: hasSubscriptionStream ? { listChanged: true } : {},
				resources: hasSubscriptionStream
					? { listChanged: true, subscribe: true }
					: {},
				extensions: {
					"io.modelcontextprotocol/apps": {},
					"io.modelcontextprotocol/ui": {},
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

export interface JsonRpcEnvelope {
	body: Record<string, unknown>;
	isSingleItemBatch: boolean;
}

type JsonRpcEnvelopeRead = JsonRpcEnvelope | { tooLarge: true } | null;

function jsonRpcEnvelopeResponse(
	envelope: JsonRpcEnvelope,
	result: Record<string, unknown>,
	init?: ResponseInit,
): Response {
	const payload = {
		jsonrpc: "2.0",
		id: envelope.body.id ?? null,
		result,
	};
	const headers = new Headers(init?.headers);
	headers.set("Content-Type", "application/json");
	return new Response(
		JSON.stringify(envelope.isSingleItemBatch ? [payload] : payload),
		{
			...init,
			headers,
		},
	);
}

function resolvedMcpServerInfo(resolvedApp: ResolvedApp) {
	return {
		name:
			(resolvedApp.metadata?.mcpConfig?.serverName as string | undefined) ??
			`${resolvedApp.app.name} MCP`,
		version:
			(resolvedApp.metadata?.mcpConfig?.serverVersion as string | undefined) ??
			"1.0.0",
	};
}

function decorateModernFastPathResult(
	envelope: JsonRpcEnvelope,
	resolvedApp: ResolvedApp,
	result: Record<string, unknown>,
): Record<string, unknown> {
	const params = isRecord(envelope.body.params) ? envelope.body.params : {};
	const meta = isRecord(params._meta) ? params._meta : {};
	if (meta[MCP_PROTOCOL_VERSION_META_KEY] !== MCP_MODERN_PROTOCOL_VERSION) {
		return result;
	}
	const resultMeta = isRecord(result._meta) ? result._meta : {};
	return {
		...result,
		_meta: {
			...resultMeta,
			[MCP_SERVER_INFO_META_KEY]: resolvedMcpServerInfo(resolvedApp),
		},
	};
}

async function readJsonRpcEnvelope(
	request: Request,
): Promise<JsonRpcEnvelopeRead> {
	try {
		const maxBytes = 4 * 1024 * 1024;
		const clone = request.clone();
		if (Number(clone.headers.get("content-length")) > maxBytes) {
			return { tooLarge: true };
		}
		if (!clone.body) return null;
		const reader = clone.body.getReader();
		const chunks: Uint8Array[] = [];
		let received = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > maxBytes) {
					await reader.cancel();
					return { tooLarge: true };
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(received);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		const body = JSON.parse(new TextDecoder().decode(bytes));
		if (isRecord(body)) {
			return { body, isSingleItemBatch: false };
		}
		if (Array.isArray(body) && body.length === 1 && isRecord(body[0])) {
			return { body: body[0], isSingleItemBatch: true };
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Fast-path JSON-RPC error envelope. Every emission site here runs only for
 * modern (2026-07-28) callers — the ladder codes (`-32600`/`-32020`/`-32021`)
 * and `-32022` answer 400, while method-not-found (`-32601`, e.g.
 * `subscriptions/listen` without the `MCP_SUBSCRIPTIONS` binding) answers 404
 * per the modern spec's method-not-found → HTTP 404 mapping.
 */
export function jsonRpcEnvelopeErrorResponse(
	envelope: JsonRpcEnvelope,
	code: number,
	message: string,
	data?: Record<string, unknown>,
): Response {
	const payload = {
		jsonrpc: "2.0",
		id: envelope.body.id ?? null,
		error: { code, message, ...(data ? { data } : {}) },
	};
	return new Response(
		JSON.stringify(envelope.isSingleItemBatch ? [payload] : payload),
		{
			status: code === -32_601 ? 404 : 400,
			headers: { "Content-Type": "application/json" },
		},
	);
}

/** Early version gate used before auth/routing; preserve an echoable JSON-RPC id. */
export async function unsupportedProtocolVersionResponse(
	request: Request,
): Promise<Response> {
	const envelope = await readJsonRpcEnvelope(request);
	if (envelope && "tooLarge" in envelope) return requestBodyTooLargeResponse();
	const requestId = envelope?.body.id;
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id:
				typeof requestId === "string" || typeof requestId === "number"
					? requestId
					: null,
			error: {
				code: -32_022,
				message: `Unsupported MCP protocol version: Tedix requires ${MCP_MODERN_PROTOCOL_VERSION}`,
			},
		}),
		{ status: 400, headers: { "Content-Type": "application/json" } },
	);
}

async function readJsonRpcBody(
	request: Request,
): Promise<Record<string, unknown> | null> {
	const envelope = await readJsonRpcEnvelope(request);
	return envelope && "body" in envelope ? envelope.body : null;
}

function requestBodyTooLargeResponse(): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32_000,
				message:
					"Payload Too Large: Request body must not exceed 4194304 bytes",
			},
		}),
		{ status: 413, headers: { "Content-Type": "application/json" } },
	);
}

const SUBSCRIPTIONS_LISTEN_METHOD = "subscriptions/listen";

export async function maybeHandleInteractionEvents(
	request: Request,
	env: CloudflareEnv,
	enabled: boolean,
): Promise<Response | null> {
	if (request.method !== "POST" || !enabled) return null;
	const envelope = await readJsonRpcEnvelope(request);
	if (envelope && "tooLarge" in envelope) return requestBodyTooLargeResponse();
	if (
		!envelope ||
		!["events/list", "events/subscribe", "events/unsubscribe"].includes(
			String(envelope.body.method),
		)
	)
		return null;
	const violation = validateModernFastPathRequest(request, envelope);
	if (violation) return violation;
	if (
		request.headers.get("MCP-Protocol-Version") !== MCP_MODERN_PROTOCOL_VERSION
	)
		return jsonRpcEnvelopeErrorResponse(
			envelope,
			-32022,
			"Events require MCP 2026-07-28",
		);
	const params = isRecord(envelope.body.params) ? envelope.body.params : {};
	if (envelope.body.method === "events/list")
		return jsonRpcEnvelopeResponse(envelope, {
			resultType: "complete",
			events: [interactionReplyEventDefinition],
		});
	try {
		const unsubscribe = envelope.body.method === "events/unsubscribe";
		const target = interactionEventTarget(params.arguments);
		const authorization = request.headers.get("Authorization");
		if (!authorization?.startsWith("Bearer "))
			throw new InteractionEventError(-32003, "Human OAuth required");
		const resource = new URL(request.url);
		resource.pathname = "/mcp";
		resource.search = "";
		resource.hash = "";
		const credential = {
			authorization,
			mcpUrl: resource.toString(),
			...target,
		};
		const binding = (env as McpSubscriptionBindingEnv).MCP_SUBSCRIPTIONS!;
		const response = await binding
			.get(
				binding.idFromName(
					interactionEventShard(target.organizationId, target.requestId),
				),
			)
			.fetch(
				`https://mcp-subscriptions.internal/events/${unsubscribe ? "unsubscribe" : "subscribe"}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(
						unsubscribe ? { credential, params } : { credential, params },
					),
				},
			);
		const result = (await response.json()) as Record<string, unknown>;
		if (isRecord(result.error))
			return jsonRpcEnvelopeErrorResponse(
				envelope,
				typeof result.error.code === "number" ? result.error.code : -32603,
				typeof result.error.message === "string"
					? result.error.message
					: "Event operation unavailable",
				isRecord(result.error.data) ? result.error.data : undefined,
			);
		return jsonRpcEnvelopeResponse(envelope, {
			resultType: "complete",
			...result,
		});
	} catch (error) {
		return jsonRpcEnvelopeErrorResponse(
			envelope,
			error instanceof InteractionEventError ? error.code : -32603,
			error instanceof InteractionEventError
				? error.message
				: "Event operation unavailable",
		);
	}
}

function validateModernFastPathRequest(
	request: Request,
	envelope: JsonRpcEnvelope,
): Response | null {
	const method =
		typeof envelope.body.method === "string" ? envelope.body.method : "";
	const params = isRecord(envelope.body.params) ? envelope.body.params : {};
	const violation = validateModernProtocolHeaders({
		headers: request.headers,
		method,
		params,
	});
	if (!violation) return null;
	return jsonRpcEnvelopeErrorResponse(
		envelope,
		violation.code,
		violation.message,
		violation.data,
	);
}

const SUBSCRIPTION_FORWARD_HEADER_ALLOWLIST = new Set([
	"authorization",
	"x-api-key",
	"x-service-binding",
	"x-tedix-acting-user",
	"x-tedix-kernel",
	"x-tedix-org-id",
	"x-tedix-tedi-id",
	"x-tedix-skill-id",
	"x-tedix-skill-run-id",
]);

type McpSubscriptionBindingEnv = CloudflareEnv & {
	MCP_SUBSCRIPTIONS?: DurableObjectNamespace;
};

type McpSubscriptionPublishBody = {
	kind?: "interaction_response";
	requestId?: string;
	responseId?: string;
	respondedAt?: string;
	appId?: string;
	appIds?: string[];
	organizationId?: string | null;
	method?: string;
	taskId?: string;
	state?: Record<string, unknown>;
	uri?: string;
	params?: Record<string, unknown>;
};

function collectSubscriptionForwardHeaders(
	headers: Headers,
): Record<string, string> {
	const forwarded: Record<string, string> = {};
	for (const [name, value] of headers) {
		const lower = name.toLowerCase();
		if (
			SUBSCRIPTION_FORWARD_HEADER_ALLOWLIST.has(lower) ||
			lower.startsWith("x-tedix-auth-")
		) {
			forwarded[name] = value;
		}
	}
	return forwarded;
}

async function publishSubscriptionEventToApp(
	env: CloudflareEnv,
	appId: string,
	event: Record<string, unknown>,
): Promise<number> {
	const binding = (env as McpSubscriptionBindingEnv).MCP_SUBSCRIPTIONS;
	if (!binding) return 0;
	const response = await binding
		.get(binding.idFromName(appId))
		.fetch("https://mcp-subscriptions.internal/publish", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(event),
		});
	if (!response.ok) return 0;
	const payload = (await response.json().catch(() => ({}))) as {
		delivered?: unknown;
	};
	return typeof payload.delivered === "number" ? payload.delivered : 0;
}

async function handleInternalSubscriptionPublish(
	request: Request,
	env: CloudflareEnv,
): Promise<Response> {
	if (!isServiceBinding(request.headers)) {
		return new Response(JSON.stringify({ error: "Forbidden" }), {
			status: 403,
			headers: { "Content-Type": "application/json" },
		});
	}
	let body: McpSubscriptionPublishBody;
	try {
		body = (await request.json()) as McpSubscriptionPublishBody;
	} catch {
		return new Response(JSON.stringify({ error: "Bad Request" }), {
			status: 400,
			headers: { "Content-Type": "application/json" },
		});
	}
	if (isRecord(body) && body.kind === "interaction_response") {
		try {
			const target = interactionEventTarget({
				organization_id: body.organizationId,
				request_id: body.requestId,
			});
			const binding = (env as McpSubscriptionBindingEnv).MCP_SUBSCRIPTIONS;
			if (!binding)
				return Response.json(
					{ ok: false, error: "Event delivery unavailable" },
					{ status: 503 },
				);
			const response = await binding
				.get(
					binding.idFromName(
						interactionEventShard(target.organizationId, target.requestId),
					),
				)
				.fetch("https://mcp-subscriptions.internal/events/publish", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						...target,
						responseId: body.responseId,
						respondedAt: body.respondedAt,
					}),
				});
			const result = (await response.json()) as {
				accepted?: number;
				error?: unknown;
			};
			return Response.json(
				{ ok: response.ok && !result.error, accepted: result.accepted ?? 0 },
				{ status: response.ok && !result.error ? 200 : 503 },
			);
		} catch {
			return Response.json(
				{ ok: false, error: "Invalid reply event" },
				{ status: 400 },
			);
		}
	}
	const appIds = [
		...(typeof body.appId === "string" ? [body.appId] : []),
		...(Array.isArray(body.appIds)
			? body.appIds.filter((id): id is string => typeof id === "string")
			: []),
	].filter((id, index, all) => id && all.indexOf(id) === index);
	if (appIds.length === 0 || typeof body.method !== "string") {
		return new Response(
			JSON.stringify({ error: "appId/appIds and method are required" }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}

	let delivered = 0;
	for (const appId of appIds) {
		delivered += await publishSubscriptionEventToApp(env, appId, {
			organizationId: body.organizationId ?? null,
			method: body.method,
			...(body.taskId ? { taskId: body.taskId } : {}),
			...(body.state ? { state: body.state } : {}),
			...(body.uri ? { uri: body.uri } : {}),
			...(body.params ? { params: body.params } : {}),
		});
	}
	return new Response(JSON.stringify({ ok: true, appIds, delivered }), {
		headers: { "Content-Type": "application/json" },
	});
}

async function maybeHandleSubscriptionsListen(
	request: Request,
	resolvedApp: ResolvedApp,
	env: CloudflareEnv,
): Promise<Response | null> {
	if (request.method !== "POST") return null;
	const envelope = await readJsonRpcEnvelope(request);
	if (envelope && "tooLarge" in envelope) return requestBodyTooLargeResponse();
	if (envelope?.body.method !== SUBSCRIPTIONS_LISTEN_METHOD) return null;

	if (request.headers.get("MCP-Protocol-Version") !== "2026-07-28") {
		return jsonRpcEnvelopeErrorResponse(
			envelope,
			-32022,
			"Unsupported protocol version: subscriptions/listen requires MCP-Protocol-Version 2026-07-28",
		);
	}
	const validationError = validateModernFastPathRequest(request, envelope);
	if (validationError) return validationError;

	const binding = (env as McpSubscriptionBindingEnv).MCP_SUBSCRIPTIONS;
	if (!binding) {
		return jsonRpcEnvelopeErrorResponse(
			envelope,
			-32601,
			"Method not found: subscriptions/listen is not configured for this MCP Worker",
		);
	}

	const allowedOrigins = getAllowedMcpOrigins(request, env, resolvedApp);
	const corsOrigin =
		normalizeOrigin(
			request.headers.get("Origin") ?? request.headers.get("origin") ?? "",
		) ??
		allowedOrigins[0] ??
		new URL(request.url).origin;
	const stub = binding.get(binding.idFromName(resolvedApp.app.id));
	return stub.fetch("https://mcp-subscriptions.internal/listen", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			requestId: envelope.body.id ?? null,
			params: isRecord(envelope.body.params) ? envelope.body.params : {},
			mcpUrl: request.url,
			authHeaders: collectSubscriptionForwardHeaders(request.headers),
			corsOrigin,
			organizationId:
				request.headers.get("x-tedix-auth-org-id") ??
				resolvedApp.app.organizationId ??
				null,
		}),
	});
}

const CODEMODE_BUILTIN_GLOBALS = new Set([
	"Array",
	"BigInt",
	"Boolean",
	"Date",
	"Error",
	"JSON",
	"Map",
	"Math",
	"Number",
	"Object",
	"Promise",
	"Reflect",
	"RegExp",
	"Set",
	"String",
	"Symbol",
	"console",
	"globalThis",
]);

export function extractCodeModeProviderNamespacesFromCode(
	code: string,
): Set<string> | null {
	if (/\bdiscover\s*\./.test(code)) {
		// Recognize only a complete, single discovery expression with JSON
		// literal input. JSON.parse rejects executable/mutable arguments and
		// additional statements. General programs retain full hydration; this
		// changes loading, never the selected organizations or dispatch gates.
		const literalCall = code
			.trim()
			.match(
				/^async\s*\(\s*\)\s*=>\s*(?:await\s+)?discover\s*\.\s*(search|describe)\s*\(([\s\S]*)\)\s*;?$/,
			);
		if (!literalCall) return null;
		try {
			const input: unknown = JSON.parse(literalCall[2]!);
			if (literalCall[1] === "search") {
				const namespace = isRecord(input) ? input.namespace : undefined;
				return typeof namespace === "string" &&
					/^[A-Za-z_$][\w$]*$/.test(namespace)
					? new Set([namespace])
					: null;
			}
			const callable =
				typeof input === "string"
					? input
					: isRecord(input)
						? input.callable
						: undefined;
			const match =
				typeof callable === "string"
					? /^([A-Za-z_$][\w$]*)\.[A-Za-z_$][\w$]*$/.exec(callable)
					: null;
			return match ? new Set([match[1]!]) : null;
		} catch {
			return null;
		}
	}

	const namespaces = new Set<string>();
	const callPattern =
		/(?:^|[^A-Za-z0-9_$])([A-Za-z_$][\w$]*)\s*(?:\.\s*[A-Za-z_$][\w$]*|\[\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*\])\s*\(/g;
	let match = callPattern.exec(code);
	while (match !== null) {
		const namespace = match[1];
		if (namespace && !CODEMODE_BUILTIN_GLOBALS.has(namespace)) {
			namespaces.add(namespace);
		}
		match = callPattern.exec(code);
	}
	// The built-in `flow.*` provider dispatches through other namespaces at
	// execute time (skills.record_skills + <tedi>.run_skill_workflow/status/
	// inspect), which this pre-execution scan cannot see — a snippet like
	// `flow.status({ runId })` mentions no tedi at all, so the lazy hydrator
	// would mount nothing and the dispatch would fail with "not mounted".
	// When flow is requested, hydrate its
	// dependencies: the skills namespace, the default flow tedi, and any tedi
	// named by a literal tediSlug argument.
	if (namespaces.has("flow")) {
		namespaces.add("skills");
		namespaces.add("cto");
		const slugPattern = /tediSlug\s*:\s*["']([A-Za-z0-9_-]{1,64})["']/g;
		let slug = slugPattern.exec(code);
		while (slug !== null) {
			const literal = slug[1];
			if (literal) namespaces.add(literal.replace(/-/g, "_"));
			slug = slugPattern.exec(code);
		}
	}
	return namespaces;
}

async function extractRequestedCodeModeNamespaces(
	request: Request,
): Promise<Set<string> | null> {
	const body = await readJsonRpcBody(request);
	if (body?.method !== "tools/call") return null;
	const params = isRecord(body.params) ? body.params : {};
	if (params.name !== "code") return null;
	const args = isRecord(params.arguments) ? params.arguments : {};
	const code = typeof args.code === "string" ? args.code : "";
	if (!code) return new Set();
	return extractCodeModeProviderNamespacesFromCode(code);
}

export function filterAggregateAppsForCodeNamespaces(
	entries: AggregateAppEntry[],
	namespaces: Set<string> | null,
	namespaceOverrides?: Record<string, string>,
): AggregateAppEntry[] {
	if (!namespaces) return entries;
	if (namespaces.size === 0) return [];
	const matchedNamespaces = new Set<string>();
	const filtered = entries.filter((entry) => {
		const candidates = aggregateAppNamespaceCandidates(
			entry,
			namespaceOverrides,
		);
		let matched = false;
		for (const candidate of candidates) {
			if (namespaces.has(candidate)) {
				matchedNamespaces.add(candidate);
				matched = true;
			}
		}
		if (entry.organizationMount) {
			for (const ns of namespaces) {
				if (isOrganizationMountNamespace(entry.prefix ?? entry.slug, ns)) {
					matchedNamespaces.add(ns);
					matched = true;
				}
			}
		}
		if (matched) return true;
		// The platform-operator admin app (slug "tedix") stores tools whose Code
		// Mode namespaces are derived from endpoint path prefixes (e.g.
		// "tedis/list" → namespace "tedis", "workflows/listRuns" → "workflows").
		// These do not match the entry slug "tedix", so the standard candidate
		// check above misses them. When a directly-called namespace matches any
		// platform-operator Code Mode namespace, include the "tedix" entry so
		// those tools are hydrated on demand — same lazy, bounded behavior as
		// aggregate app hydration.
		if (candidates.has(PLATFORM_OPERATOR_ADMIN_APP_SLUG)) {
			const platformMatches = [...namespaces].filter((ns) =>
				PLATFORM_OPERATOR_CODE_MODE_NAMESPACES.has(ns),
			);
			for (const ns of platformMatches) matchedNamespaces.add(ns);
			return platformMatches.length > 0;
		}
		return false;
	});
	// Fail-open for unmatched namespaces: PLATFORM_OPERATOR_CODE_MODE_NAMESPACES
	// only covers the statically-defined tool endpoints, but the admin app also
	// serves a long tail of D1-synced namespaces (skills, memory, rationale,
	// kernel, submissions, …) that discovery can see. A snippet calling
	// `skills.list_skills_by_org(...)` directly (no `discover.` reference) used
	// would filter the admin entry out, so the namespace was never mounted and
	// the sandbox threw a misleading "skills is not defined". When any
	// requested namespace matched nothing, include the
	// platform-operator admin entry so its D1 tail is hydrated. Local variables
	// in the snippet can land here too (`results.map(...)`) — that only costs
	// one extra entry hydration, never correctness.
	const hasUnmatched = [...namespaces].some((ns) => !matchedNamespaces.has(ns));
	if (hasUnmatched) {
		const adminEntry = entries.find((entry) =>
			aggregateAppNamespaceCandidates(entry, namespaceOverrides).has(
				PLATFORM_OPERATOR_ADMIN_APP_SLUG,
			),
		);
		if (adminEntry && !filtered.includes(adminEntry)) {
			filtered.push(adminEntry);
		}
	}
	return filtered;
}

export function filterAggregateTedisForCodeNamespaces(
	entries: AggregateTediEntry[] | undefined,
	namespaces: Set<string> | null,
): AggregateTediEntry[] | undefined {
	if (!entries || !namespaces) return entries;
	if (namespaces.size === 0) return [];
	// flow.* resolves its owner from mounted workflow capabilities. Hydrate the
	// small configured workforce so tenant gateways without a `cto` namespace can
	// select their sole operator; ambiguous gateways require an explicit tediSlug.
	if (namespaces.has("flow")) return entries;
	return entries.filter((entry) =>
		namespaces.has(aggregateTediNamespace(entry)),
	);
}

async function maybeHandleBootstrapFastMcp(
	request: Request,
	resolvedApp: ResolvedApp,
): Promise<Response | null> {
	if (request.method !== "POST") return null;
	const envelope = await readJsonRpcEnvelope(request);
	if (envelope && "tooLarge" in envelope) return requestBodyTooLargeResponse();
	if (!envelope) return null;
	const modernError = validateModernFastPathRequest(request, envelope);
	if (modernError) return modernError;
	const body = envelope.body;
	if (body?.method !== "tools/call") return null;
	const params = isRecord(body.params) ? body.params : {};
	if (
		params.name === "get_profile" &&
		accountProfileEnabled(resolvedApp.metadata?.mcpConfig)
	) {
		return jsonRpcEnvelopeResponse(
			envelope,
			decorateModernFastPathResult(envelope, resolvedApp, {
				resultType: "complete",
				...accountProfileResult(
					extractCallerIdentity(request),
					params.arguments ?? {},
				),
			}),
		);
	}
	// get_info needs the same full authenticated registry as session bootstrap.
	// Its no-loader response is built after selected-org routing and hydration.
	return null;
}

function compactCodeModeToolDescription(resolvedApp: ResolvedApp): string {
	const appSlug = resolvedApp.app.slug;
	return [
		`Execute JavaScript against the ${appSlug} Code Mode surface.`,
		'Find tools and skills with bounded discovery, for example `async () => await discover.search({"query":"list_mcp_authorizations","limit":3})`; this loads the aggregate catalog. Use each returned tool callable exactly, including its namespace prefix; follow the returned load expression for skills. Once the namespace is known, a single JSON-literal search with that exact `namespace` value or an exact `async () => await discover.describe("namespace.tool")` expression loads only that namespace.',
		"Call `codemode.__runtime()` for execution-surface proof.",
	].join(" ");
}

function modernDiscoverInstructions(
	resolvedApp: ResolvedApp,
): string | undefined {
	const mcpConfig = resolvedApp.metadata?.mcpConfig;
	const configured =
		typeof mcpConfig?.serverInstructions === "string"
			? mcpConfig.serverInstructions.trim()
			: "";
	const codeMode =
		mcpConfig?.codeMode === true
			? [
					"Use Code Mode for broad Tedix operations.",
					'Find tools and skills with bounded discovery, for example async () => await discover.search({"query":"list_mcp_authorizations","limit":3}); this loads the aggregate catalog. Use each returned tool callable exactly, including its namespace prefix; follow the returned load expression for skills. Once the namespace is known, a single JSON-literal search with that exact namespace value or an exact async () => await discover.describe("namespace.tool") expression loads only that namespace.',
					"Long-running work may return task handles; poll tasks/get and provide requested input through tasks/update.",
					"For operator-to-tedi validation, prefer the governed Home/kernel path or direct tedi namespace run_tedi_turn/messages_read when explicitly requested.",
				].join(" ")
			: "";
	const instructions = [configured, codeMode].filter(Boolean).join("\n\n");
	return instructions || undefined;
}

// Exported for the outer-surface lane conformance test: the stateless fast
// path deliberately advertises `code` + `get_info` and not `ask` — see
// outer-surface-lanes.test.ts and docs/engineering/mcp/codemode.md.
export function compactCodeModeTools(
	resolvedApp: ResolvedApp,
	requestHeaders: Headers,
): Array<Record<string, unknown>> {
	const appName = resolvedApp.app.name ?? "Tedix";
	const tools: Array<Record<string, unknown>> = [
		{
			name: "code",
			title: "Code Mode",
			annotations: CODE_MODE_TOOL_ANNOTATIONS,
			...codeModeSecurityMeta(resolvedApp.metadata?.mcpConfig),
			_meta: codeModeSecurityMeta(resolvedApp.metadata?.mcpConfig),
			description: compactCodeModeToolDescription(resolvedApp),
			inputSchema: {
				type: "object",
				properties: {
					code: {
						type: "string",
						description:
							"JavaScript async arrow function. Example: async () => await codemode.__runtime()",
					},
					payment: {
						anyOf: [{ type: "string", minLength: 1 }, { type: "object" }],
						description:
							'Optional x402 payment proof for paid inner tools. Accepts an encoded facilitator payment string or an object proof and forwards it as _meta["x402/payment"].',
					},
					agentSessionId: {
						type: "string",
						format: "uuid",
						description:
							"Optional owner-host Agent-Session id (session.id from start_external_agent_session_for_host). When the caller is a signed-in human, Tedix calls in this run act as that Agent-Session for Work admission; an invalid id fails the call. Ignored for machine credentials.",
					},
				},
				required: ["code"],
			},
		},
		{
			name: "get_info",
			title: `${appName} Info`,
			description: `Get metadata about the ${appName} MCP server itself.`,
			inputSchema: { type: "object", properties: {} },
			annotations: {
				readOnlyHint: true,
				openWorldHint: false,
				destructiveHint: false,
			},
		},
		...(accountProfileEnabled(resolvedApp.metadata?.mcpConfig)
			? [accountProfileTool]
			: []),
	];
	const config = resolvedApp.metadata?.mcpConfig;
	const caller = parseMcpCallerFromHeaders(requestHeaders);
	const overrides = config?.codeModeNamespaces as
		| Record<string, string>
		| undefined;
	const rows = (resolvedApp.tools ?? []).filter((tool) =>
		isConfiguredCatalogTool(tool, config),
	);
	const names = new Map<string, number>();
	for (const tool of resolvedApp.tools ?? [])
		names.set(tool.toolId, (names.get(tool.toolId) ?? 0) + 1);
	const baseNames = new Set(tools.map((tool) => tool.name));
	for (const tool of rows) {
		if (names.get(tool.toolId) !== 1 || baseNames.has(tool.toolId)) continue;
		if (
			!isMcpToolVisibleToCaller(
				tool,
				resolveMcpToolNamespace(tool, overrides),
				config,
				caller,
			)
		)
			continue;
		if (
			requestHeaders.get("x-tedix-auth-credential-mode") === "delegated-mcp" &&
			isDelegatedWorkTool(
				tool.toolId,
				resolveMcpToolNamespace(tool, overrides),
				tool.config,
				tool.toolTypeId,
			)
		)
			continue;
		const scopes = resolveMcpToolRequiredScopes(
			tool,
			resolveMcpToolNamespace(tool, overrides),
			config,
		);
		const securitySchemes = [{ type: "oauth2", scopes }];
		tools.push({
			name: tool.toolId,
			title: tool.title,
			description: tool.description ?? "",
			inputSchema: tool.inputSchema,
			...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
			annotations: resolveToolAnnotations({
				annotations: tool.annotations,
				writeCapability: tool.writeCapability ?? null,
				meta: tool.meta,
			}),
			securitySchemes,
			_meta: { ...tool.meta, securitySchemes },
		});
	}
	// Directory listings read the display name from `annotations.title`
	// (the 2025-03-26 location); newer clients read the top-level `title`.
	for (const tool of tools) {
		const annotations = tool.annotations as Record<string, unknown> | undefined;
		if (typeof tool.title === "string" && annotations?.title === undefined)
			tool.annotations = { ...annotations, title: tool.title };
	}
	return sortToolsDeterministically(tools);
}

async function maybeHandleCodeModeCompactMcp(
	request: Request,
	resolvedApp: ResolvedApp,
	env: CloudflareEnv,
	interactionEventsEnabled = false,
): Promise<Response | null> {
	if (request.method !== "POST") return null;
	if (resolvedApp.metadata?.mcpConfig?.codeMode !== true) return null;

	const envelope = await readJsonRpcEnvelope(request);
	if (envelope && "tooLarge" in envelope) return requestBodyTooLargeResponse();
	if (!envelope) return null;
	const body = envelope.body;
	const method = typeof body.method === "string" ? body.method : "";
	if (method === "initialize") {
		return jsonRpcEnvelopeErrorResponse(
			envelope,
			-32_601,
			"Method not found: the initialize handshake is removed in MCP 2026-07-28; use server/discover",
		);
	}
	const modernError = validateModernFastPathRequest(request, envelope);
	if (modernError) return modernError;

	if (method === "server/discover") {
		const exposesHomeTasks = shouldExposeHomeSurface({
			appSlug: resolvedApp.app.slug,
			metadata: resolvedApp.metadata,
		});
		const hasSubscriptionStream = Boolean(
			(env as McpSubscriptionBindingEnv).MCP_SUBSCRIPTIONS,
		);
		return jsonRpcEnvelopeResponse(
			envelope,
			decorateModernFastPathResult(envelope, resolvedApp, {
				resultType: "complete",
				supportedVersions: [MCP_MODERN_PROTOCOL_VERSION],
				capabilities: {
					...(interactionEventsEnabled ? { events: {} } : {}),
					tools: hasSubscriptionStream ? { listChanged: true } : {},
					resources: hasSubscriptionStream
						? { listChanged: true, subscribe: true }
						: {},
					extensions: {
						"io.modelcontextprotocol/apps": {},
						"io.modelcontextprotocol/ui": {},
						"io.modelcontextprotocol/skills": {},
						...(exposesHomeTasks ? { [MCP_TASKS_EXTENSION]: {} } : {}),
					},
				},
				instructions: modernDiscoverInstructions(resolvedApp),
				...DEFAULT_MCP_CACHE_HINT,
			}),
		);
	}

	if (method === "tools/list") {
		// SEP-2549 CacheableResult on this fast path: the 60s/private default
		// mirrors the app-resolution cache backing the compact tool list
		// (APP_RESOLUTION_TTL_MS in resolution.ts).
		const page = paginateSortedToolsList(
			compactCodeModeTools(resolvedApp, request.headers),
			isRecord(body.params) ? body.params.cursor : undefined,
		);
		if (!page.ok)
			return jsonRpcEnvelopeErrorResponse(
				envelope,
				-32_602,
				"Invalid params: unrecognized tools/list cursor",
			);
		return jsonRpcEnvelopeResponse(
			envelope,
			decorateModernFastPathResult(envelope, resolvedApp, {
				resultType: "complete",
				tools: page.tools,
				...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
				...DEFAULT_MCP_CACHE_HINT,
			}),
		);
	}

	return null;
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
		// (see `docs/engineering/mcp/runtime.md` "Edge Design Record"). Purge rolls the
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
				let deleted = 0;
				let l2Deleted = 0;
				const activationEpoch = crypto.randomUUID();
				await writeAggregateActivationEpoch(env, activationEpoch);
				if ("AGGREGATE_CACHE" in env && env.AGGREGATE_CACHE) {
					const l2Requests: Request[] = [];
					// One object per aggregate host — a short list, never paginated in
					// practice, but honor cursors so growth cannot silently strand
					// stale snapshots.
					let cursor: string | undefined;
					do {
						const page = await env.AGGREGATE_CACHE.list({
							prefix: "aggregate-surface/v1/",
							...(cursor ? { cursor } : {}),
						});
						if (page.objects.length > 0) {
							l2Requests.push(
								...page.objects.map((object) =>
									aggregateL2RequestFromHash(object.key.split("/").at(-1)!),
								),
							);
							await env.AGGREGATE_CACHE.delete(
								page.objects.map((object) => object.key),
							);
							deleted += page.objects.length;
						}
						cursor = page.truncated ? page.cursor : undefined;
					} while (cursor);
					if (typeof caches !== "undefined" && caches.default) {
						for (const request of l2Requests) {
							if (await caches.default.delete(request)) l2Deleted++;
						}
					}
				}
				const localEntries =
					aggregateSurfaceCache.size + internalToolCache.size;
				aggregateSurfaceCache.clear();
				internalToolCache.clear();
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

		// Tedix gateways are current-spec-only. Do not negotiate, initialize, or
		// create sessions for older MCP hosts: every protocol POST must bind the
		// finalized revision explicitly.
		if (
			request.method === "POST" &&
			(url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) &&
			request.headers.get(MCP_PROTOCOL_VERSION_HEADER)?.trim() !==
				MCP_MODERN_PROTOCOL_VERSION
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
		// `docs/engineering/mcp/runtime.md` "Edge Design Record".
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
		if (
			isMcpPath &&
			hasAnyAuth &&
			(hostnameInfo.type === "subdomain" || hostnameInfo.type === "custom")
		) {
			try {
				earlyResolvedApp = await resolveAppFromHostname(hostnameInfo, env);
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
						const selection = await validateHumanMcpSelection(
							authResult.payload,
							env,
							{
								audience: expectedAudience,
								mcpServerId,
								multiOrganization: config?.multiOrgConsent === true,
							},
						);
						if (!selection)
							return new Response(
								JSON.stringify({
									error: "human_mcp_grant_invalid",
									message: "Reconnect this application to review permissions.",
								}),
								{
									status: 403,
									headers: { "Content-Type": "application/json" },
								},
							);
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
							headers.set("x-tedix-auth-scopes", aihM2mClient.scopes.join(" "));
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
						}
						// A tedi M2M grant is bound to this exact AIH server. Its effective
						// scopes are the intersection of the registered client's scopes
						// and the current D1 capability profile, resolved during hydration.
						// Neither a stale-broad client nor a broader live profile can widen
						// the other side's grant. Non-tedi clients keep their registration.
						// `resolveAihM2mClientScopeContext` applies the live profile
						// intersection to tedi clients after cached or fresh lookup;
						// external-agent and other clients retain their registration.
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
			const { allowed } = await checkRateLimit(
				env.MCP_RATE_LIMITER,
				`${app.id}:${clientIp}`,
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

					const { allowed } = await checkRateLimit(
						env.MCP_RATE_LIMITER,
						`${resolvedApp.app.id}:${clientIp}`,
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

						const { allowed } = await checkRateLimit(
							env.MCP_RATE_LIMITER,
							`${result.app.id}:${clientIp}`,
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
		return worker.fetch(request, this.env, this.ctx);
	}
}

export default {
	fetch(
		request: Request,
		env: CloudflareEnv,
		ctx: ExecutionContext,
	): Promise<Response> {
		return worker.fetch(stripServiceBindingMarker(request), env, ctx);
	},
};
