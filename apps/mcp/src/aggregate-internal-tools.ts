import { type ApiClient, getApiClient } from "./lib/api-client";
import type { InternalResolveResult } from "./aggregate-types";
import { UPSTREAM_ATTEMPT_TIMEOUT_MS } from "./upstream";
import {
	pruneExpiredCacheEntries,
	setBoundedExpiringCacheEntry,
} from "./lib/bounded-cache";
import {
	JOINED_LOAD_BUDGET_MS,
	joinInFlightLoad,
	trackInFlightLoad,
	withStepBudget,
} from "./lib/step-budget";
import { contentFreeMcpException, createMcpLogger } from "./log";
const log = createMcpLogger("mcp.router");

export const internalToolCache = new Map<
	string,
	{ result: InternalResolveResult; expiresAt: number }
>();
export const internalToolInFlight = new Map<
	string,
	Promise<InternalResolveResult>
>();
export const MAX_INTERNAL_TOOL_CACHE_ENTRIES = 64;
export const INTERNAL_TOOL_CACHE_TTL_MS = 120_000;
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
export function isAggregateSourceVisited(
	visited: Set<string>,
	ref: AggregateSourceRef,
): boolean {
	return ref.appId ? visited.has(ref.appId) : visited.has(ref.slug);
}

export function internalToolCacheKey(
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
export function toInternalResolveResult(
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

export async function resolveUpstreamToolsInternally(
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
