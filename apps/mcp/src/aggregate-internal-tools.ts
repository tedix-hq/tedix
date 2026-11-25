import { type ApiClient, getApiClient } from "./lib/api-client";
import type { InternalResolveResult } from "./aggregate-types";
import { UPSTREAM_ATTEMPT_TIMEOUT_MS } from "./upstream";
import { setBoundedCacheEntry } from "./lib/bounded-cache";
import {
	JOINED_LOAD_BUDGET_MS,
	StepBudgetExceededError,
	trackInFlightLoad,
	withStepBudget,
} from "./lib/step-budget";
import {
	logToolDefinitionsMiss,
	readToolDefinitionsL2,
	writeToolDefinitionsL2,
} from "./aggregate-tool-definitions-cache";
import { contentFreeMcpException, createMcpLogger } from "./log";
const log = createMcpLogger("mcp.router");

export const internalToolCache = new Map<
	string,
	{ result: InternalResolveResult; expiresAt: number; invalidated?: boolean }
>();
export const internalToolInFlight = new Map<
	string,
	Promise<InternalResolveResult>
>();
const toolDefinitionsReady = new WeakMap<
	Promise<InternalResolveResult>,
	Promise<InternalResolveResult>
>();
export const MAX_INTERNAL_TOOL_CACHE_ENTRIES = 64;
export const MAX_INTERNAL_TOOL_CACHE_ROWS = 4_000;
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
		: ref.hostOrganizationId
			? `slug:${ref.slug}@${ref.hostOrganizationId}`
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
	selection?: {
		endpointPrefixes?: string[];
		toolIds?: string[];
		projection?: "contract";
	},
	activationEpoch = "direct",
): string {
	const normalized = {
		...(selection?.endpointPrefixes?.length
			? { endpointPrefixes: selection.endpointPrefixes }
			: {}),
		...(selection?.toolIds?.length ? { toolIds: selection.toolIds } : {}),
		...(selection?.projection ? { projection: selection.projection } : {}),
	};
	return `internal:${activationEpoch}:${aggregateSourceKey(source)}:${JSON.stringify(normalized)}`;
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
export type UpstreamAppWithTools = Awaited<
	ReturnType<ApiClient["apps"]["getBySlugWithTools"]>
>;

/** Seed the per-isolate L1 entry for a resolved source app. */
export function rememberInternalTools(
	cacheKey: string,
	result: InternalResolveResult,
): void {
	// Index rebuilds visit organizations sequentially; retaining their source
	// schemas must not accumulate the entire selection behind the index.
	internalToolCache.delete(cacheKey);
	if (result.tools.length > MAX_INTERNAL_TOOL_CACHE_ROWS) return;
	let rows = result.tools.length;
	for (const cached of internalToolCache.values())
		rows += cached.result.tools.length;
	for (const [key, cached] of internalToolCache) {
		if (rows <= MAX_INTERNAL_TOOL_CACHE_ROWS) break;
		internalToolCache.delete(key);
		rows -= cached.result.tools.length;
	}
	setBoundedCacheEntry(
		internalToolCache,
		cacheKey,
		{ result, expiresAt: Date.now() + INTERNAL_TOOL_CACHE_TTL_MS },
		MAX_INTERNAL_TOOL_CACHE_ENTRIES,
	);
}

/** Scope changes refresh definitions without discarding the fallback. */
export function invalidateToolDefinitionsByScope(): void {
	for (const entry of internalToolCache.values()) {
		entry.expiresAt = 0;
		entry.invalidated = true;
	}
}

/** Shared by prefetch and direct resolution, including the entire refresh. */
export async function loadInternalTools(
	cacheKey: string,
	upstreamSlug: string,
	fetchUpstream: () => Promise<UpstreamAppWithTools>,
	ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<InternalResolveResult> {
	const cached = internalToolCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) return cached.result;
	let serveStale: ((result: InternalResolveResult) => void) | undefined;
	const staleReady = new Promise<InternalResolveResult>((resolve) => {
		serveStale = resolve;
	});
	let pending = internalToolInFlight.get(cacheKey);
	const ownsLoad = !pending;
	if (!pending) {
		pending = (async () => {
			let stale = cached?.result;
			let expired = !!cached;
			try {
				const durable = cached?.invalidated
					? null
					: await readToolDefinitionsL2<UpstreamAppWithTools>(
							cacheKey,
							upstreamSlug,
							() => {
								expired = true;
							},
						);
				if (durable?.payload.app) {
					stale = toInternalResolveResult(upstreamSlug, durable.payload);
					rememberInternalTools(cacheKey, stale);
					if (!durable.stale) return stale;
					serveStale?.(stale);
				}
				logToolDefinitionsMiss(
					cacheKey,
					cached?.invalidated
						? "invalidated_by_scope"
						: expired || durable
							? "expired"
							: "never_set",
				);
				const result = await fetchUpstream();
				const resolved = toInternalResolveResult(upstreamSlug, result);
				rememberInternalTools(cacheKey, resolved);
				if (result.app)
					await writeToolDefinitionsL2(cacheKey, result, ctx, upstreamSlug);
				return resolved;
			} catch (error) {
				logToolDefinitionsMiss(cacheKey, "fetch_failed");
				if (!stale) throw error;
				// Keep the fallback through refusals; the ordinary L1 TTL spaces retries.
				rememberInternalTools(cacheKey, stale);
				return stale;
			}
		})();
		toolDefinitionsReady.set(pending, Promise.race([pending, staleReady]));
		trackInFlightLoad(internalToolInFlight, cacheKey, pending, {
			step: "internal_tool_in_flight",
			wedgeEvictMs: INTERNAL_TOOL_WEDGE_EVICT_MS,
			resource: upstreamSlug,
		});
		ctx?.waitUntil(pending.catch(() => {}));
	}
	if (cached) return cached.result;
	try {
		return await withStepBudget(
			"internal_tool_join",
			ownsLoad ? INTERNAL_TOOL_WEDGE_EVICT_MS : JOINED_LOAD_BUDGET_MS,
			toolDefinitionsReady.get(pending) ?? pending,
			upstreamSlug,
		);
	} catch (error) {
		if (
			error instanceof StepBudgetExceededError &&
			internalToolInFlight.get(cacheKey) === pending
		)
			internalToolInFlight.delete(cacheKey);
		throw error;
	}
}

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
		...(mcpConfig?.embeddedHostDelegation
			? { embeddedHostDelegation: true as const }
			: {}),
	};
}

export async function resolveUpstreamToolsInternally(
	source: AggregateSourceRef,
	env: CloudflareEnv,
	selection?: {
		endpointPrefixes?: string[];
		toolIds?: string[];
		projection?: "contract";
	},
	activationEpoch = "direct",
	cacheable = true,
	ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<InternalResolveResult> {
	const upstreamSlug = source.slug;
	const cacheKey = internalToolCacheKey(source, selection, activationEpoch);
	const cached = cacheable ? internalToolCache.get(cacheKey) : undefined;
	if (cached && cached.expiresAt > Date.now()) return cached.result;

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
				...(selection?.projection ? { projection: selection.projection } : {}),
				...(selection?.endpointPrefixes?.length
					? { endpointPrefixes: selection.endpointPrefixes }
					: {}),
				...(selection?.toolIds?.length ? { toolIds: selection.toolIds } : {}),
			};
			// An id-linked entry resolves through the batched endpoint, the one
			// path that resolves by id under the aggregate ownership rule.
			const fetchUpstream = (): Promise<UpstreamAppWithTools> =>
				withStepBudget(
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
								...(source.hostOrganizationId
									? { hostOrganizationId: source.hostOrganizationId }
									: {}),
								...selectionInput,
							}),
					upstreamSlug,
				);
			if (cacheable)
				return await loadInternalTools(
					cacheKey,
					upstreamSlug,
					fetchUpstream,
					ctx,
				);
			return toInternalResolveResult(upstreamSlug, await fetchUpstream());
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

	return loadPromise;
}
