import {
	buildMcpAggregateCacheDataPoint,
	type McpAggregateCacheDataPointEvent,
} from "@tedix/api-contract/schemas/mcp-analytics";
import { type ApiClient, getApiClient } from "./lib/api-client";
import {
	pruneExpiredCacheEntries,
	setBoundedExpiringCacheEntry,
} from "./lib/bounded-cache";
import {
	CACHE_TIER_BUDGET_MS,
	JOINED_LOAD_BUDGET_MS,
	joinInFlightLoad,
	StepBudgetExceededError,
	trackInFlightLoad,
	withStepBudget,
} from "./lib/step-budget";
import { contentFreeMcpException, createMcpLogger } from "./log";
import {
	mountedAppToolScopes,
	organizationAppNamespace,
	organizationMountToolScopes,
} from "./mcp/aggregate-namespaces";
import { ensurePlatformOperatorAggregateApps } from "./mcp/platform-operator-aggregation";
import { UPSTREAM_ATTEMPT_TIMEOUT_MS } from "./upstream";

const log = createMcpLogger("mcp.router");

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

export type AggregateAppEntry = {
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
export function withMountToolScopes<T extends { mcpConfig?: unknown } | null>(
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
export const AGGREGATE_SURFACE_CACHE_TTL_MS = 120_000;
// Degrade-on-flap: cap how long a single aggregate app's upstream resolution may
// hold the whole surface. A healthy cold init resolves every app in a few
// seconds (slowest ~4.5s, see `_cm:"aggregate"` logs); under the documented
// remote-binding flap a stuck app quantizes at n×~48s and would otherwise block
// the entire `Promise.all`. When an entry exceeds this, it is dropped as a
// degraded partial (surface returns with the healthy apps + `degraded:true`)
// instead of stalling discovery to the ~100s edge 524.
const AGGREGATE_ENTRY_TIMEOUT_MS = 12_000;
/**
 * Wedge-eviction bounds for the shared in-flight dedupe maps: a never-settling
 * shared promise otherwise serves the same silent hang to every request until
 * the isolate recycles. Every await inside these loads is individually
 * budgeted, so these fire only for a genuinely wedged promise, and each is
 * sized above the worst-case SUM of the inner budgets (internal tool resolve
 * one 12s upstream call → 30s; aggregate surface load ~35s → 45s). The
 * arithmetic: `docs/engineering/mcp/runtime.md`.
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
			budgetMs: JOINED_LOAD_BUDGET_MS,
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
 * `docs/engineering/mcp/runtime.md`.
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
		// `docs/engineering/mcp/runtime.md`. A trip emits the
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
	// snapshots with pre-deploy tool schemas (see `docs/engineering/mcp/runtime.md`).
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
 * populates the caches for whoever comes next. See `docs/engineering/mcp/runtime.md`.
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
 * `docs/engineering/mcp/runtime.md`.
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
 * Rationale: `docs/engineering/mcp/runtime.md`.
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
 * `docs/engineering/mcp/runtime.md`.
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

export async function purgeAggregateSurfaceCaches(env: CloudflareEnv) {
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
	const localEntries = aggregateSurfaceCache.size + internalToolCache.size;
	aggregateSurfaceCache.clear();
	internalToolCache.clear();
	return { deleted, l2Deleted, localEntries, activationEpoch };
}
