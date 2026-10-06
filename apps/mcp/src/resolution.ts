/**
 * MCP Worker — App resolution and caching
 */

import type { AppMetadata, AppTool } from "@tedix/api-contract/schemas/app";
import type { HostnameInfo } from "./hostname";
import { getApiClient } from "./lib/api-client";
import { setBoundedCacheEntry } from "./lib/bounded-cache";
import { contentFreeMcpException, createMcpLogger } from "./log";
import {
	CACHE_TIER_BUDGET_MS,
	StepBudgetExceededError,
	joinInFlightLoad,
	trackInFlightLoad,
	withStepBudget,
} from "./lib/step-budget";
import type {
	CatalogMcpMetadata,
	CatalogMcpResource,
	CatalogMcpResourceTemplate,
	CatalogMcpPrompt,
} from "./mcp/server-context";
import { withUpstreamRetry } from "./upstream";

const log = createMcpLogger("mcp.resolution");

// =============================================================================
// APP DATA TYPES
// =============================================================================

/**
 * Resolved app data from API
 */
export interface AppData {
	id: string;
	name: string;
	slug: string;
	domain: string | null;
	organizationId?: string;
	description?: string | null;
	logoUrl?: string | null;
	customMcpDomain?: string | null;
	openaiAppId?: string | null;
	appStoreStatus?: string | null;
	discoveryStatus?: string | null;
	visibility?: "public" | "private" | "disabled" | null;
	openaiChallengeToken?: string | null;
	metadata?: AppMetadata | null;
}

// =============================================================================
// APP RESOLUTION
// =============================================================================

export interface ResolvedApp {
	app: AppData;
	metadata: AppMetadata | null;
	tools: AppTool[];
	catalogMcp?: CatalogMcpMetadata | null;
	catalogResources?: CatalogMcpResource[];
	catalogResourceTemplates?: CatalogMcpResourceTemplate[];
	catalogPrompts?: CatalogMcpPrompt[];
}

interface CachedResolvedApp {
	value: ResolvedApp | null;
	expiresAt: number;
	epoch: string | null;
}

const APP_RESOLUTION_TTL_MS = 60_000;
const APP_RESOLUTION_NEGATIVE_TTL_MS = 5_000;
const MAX_APP_RESOLUTION_CACHE_ENTRIES = 500;
const appResolutionCache = new Map<string, CachedResolvedApp>();
const appResolutionInFlight = new Map<string, Promise<ResolvedApp | null>>();

// ── L2: durable GLOBAL app-resolution cache (R2 bucket AGGREGATE_CACHE) ──
//
// L1 above is an isolate-local Map, so it dies with the isolate. Every cold
// isolate in every colo therefore re-resolves from scratch, and resolving means
// `apps.getBySlugWithTools` — which for the aggregate gateway app hydrates
// hundreds of tools' raw input_schema out of apps/api.
//
// That is on the handshake's critical path: MCP version negotiation
// (`client.connect()`) resolves the app before it can answer, so a cold or
// overloaded apps/api can push the handshake past its client budget.
//
// R2 is account-global and durable, so the first cold isolate in any colo gets a
// precomputed surface instead of paying apps/api. Mirrors the L3 aggregate cache
// in index.ts, with two deliberate differences:
//
//   * Shorter hard TTL (10 min, not 1h). App resolution is more
//     staleness-sensitive than the tool surface — it decides which app a
//     hostname is — so the serve-stale ceiling is tighter.
//   * negative results are never written here. A miss is cheap to recompute,
//     and caching "no such app" globally would hide a newly-created app from
//     every colo at once. Negatives stay L1-only at 5s, as before.
//
// Fully fail-safe: any R2 error falls through to the live resolve.
const APP_RESOLUTION_R2_HARD_TTL_MS = 600_000;

/**
 * Wedge-eviction bound for one shared resolver in `appResolutionInFlight`.
 *
 * Every await inside the resolver is budgeted (L2 read/write at
 * {@link CACHE_TIER_BUDGET_MS}; the live resolve inside `withUpstreamRetry` at
 * 2 × UPSTREAM_ATTEMPT_TIMEOUT_MS + 150ms ≈ 24.2s), so a resolver that has not
 * settled by 30s is wedged, not slow. A never-settling shared promise here
 * would serve the same silent hang to every request for the app until the
 * isolate recycles.
 */
const APP_RESOLUTION_WEDGE_EVICT_MS = 30_000;

function appResolutionR2Key(cacheKey: string): string {
	// Keys are short and already opaque (`mcp-subdomain:<slug>` /
	// `custom:<domain>`); encode so a domain cannot escape the prefix.
	return `app-resolution/v1/${encodeURIComponent(cacheKey)}`;
}

function appResolutionEpochR2Key(cacheKey: string): string {
	return `app-resolution-epoch/v1/${encodeURIComponent(cacheKey)}`;
}

async function readAppResolutionEpoch(
	env: CloudflareEnv,
	cacheKey: string,
): Promise<string | null | undefined> {
	if (!("AGGREGATE_CACHE" in env) || !env.AGGREGATE_CACHE) return null;
	try {
		const value = await withStepBudget(
			"app_resolution_epoch_read",
			CACHE_TIER_BUDGET_MS,
			(async () => {
				const object = await env.AGGREGATE_CACHE!.get(
					appResolutionEpochR2Key(cacheKey),
				);
				if (!object) return null;
				return (await object.json()) as { epoch?: unknown };
			})(),
			cacheKey,
		);
		return typeof value?.epoch === "string" ? value.epoch : null;
	} catch (error) {
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("App resolution epoch read failed", {
				event: "resolution.epoch_read_failed",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
		return undefined;
	}
}

/**
 * Remove the exact L1/L2 app-resolution entries affected by an app metadata
 * update. Discovery documents are cache-tagged separately, but their contents
 * are built from this resolution cache first; purging only Workers Cache left
 * OAuth metadata stale for up to the durable cache horizon.
 *
 * Await an existing single-flight resolver before deletion so it cannot write
 * the old value back after the purge completes.
 */
export async function purgeAppResolutionCacheKeys(
	env: CloudflareEnv,
	cacheKeys: string[],
): Promise<{ localEntries: number; r2Deleted: number }> {
	const keys = [
		...new Set(
			cacheKeys.filter(
				(key) => key.startsWith("mcp-subdomain:") || key.startsWith("custom:"),
			),
		),
	];
	const epoch = crypto.randomUUID();
	if (keys.length > 0 && "AGGREGATE_CACHE" in env && env.AGGREGATE_CACHE) {
		// Publish the fence before deleting payloads. A resolver already running in
		// another isolate may write its old payload after deletion, but it cannot
		// write this new epoch and therefore can never make that payload readable.
		await Promise.all(
			keys.map((key) =>
				env.AGGREGATE_CACHE!.put(
					appResolutionEpochR2Key(key),
					JSON.stringify({ epoch }),
				),
			),
		);
	}
	await Promise.allSettled(
		keys.flatMap((key) =>
			[...appResolutionInFlight.entries()]
				.filter(([loadKey]) => loadKey.startsWith(`${key}\n`))
				.map(([, inFlight]) => inFlight),
		),
	);

	let localEntries = 0;
	for (const key of keys) {
		if (appResolutionCache.delete(key)) localEntries += 1;
	}

	let r2Deleted = 0;
	if (keys.length > 0 && "AGGREGATE_CACHE" in env && env.AGGREGATE_CACHE) {
		await env.AGGREGATE_CACHE.delete(keys.map(appResolutionR2Key));
		r2Deleted = keys.length;
	}
	return { localEntries, r2Deleted };
}

async function readAppResolutionR2(
	env: CloudflareEnv,
	cacheKey: string,
	epoch: string | null,
	options?: { allowExpired?: boolean },
): Promise<{ value: ResolvedApp; stale: boolean } | null> {
	try {
		if (!("AGGREGATE_CACHE" in env) || !env.AGGREGATE_CACHE) return null;
		const bucket = env.AGGREGATE_CACHE;
		// Budgeted (get + body read together): an unbudgeted R2 hang here wedges
		// the shared in-flight resolver below into a silent hang. On the budget
		// tripping the helper emits the
		// structured diagnosis line and this read fails open to the live resolve.
		const wrapped = await withStepBudget(
			"app_resolution_l2_read",
			CACHE_TIER_BUDGET_MS,
			(async () => {
				const obj = await bucket.get(appResolutionR2Key(cacheKey));
				if (!obj) return null;
				return (await obj.json()) as {
					cachedAt?: number;
					app?: ResolvedApp;
					epoch?: string | null;
				};
			})(),
			cacheKey,
		);
		if (!wrapped) return null;
		const value = wrapped?.app;
		if (!value?.app) return null;
		if ((wrapped.epoch ?? null) !== epoch) return null;
		const age =
			Date.now() -
			(typeof wrapped.cachedAt === "number" ? wrapped.cachedAt : 0);
		if (age >= APP_RESOLUTION_R2_HARD_TTL_MS && !options?.allowExpired) {
			return null;
		}
		return { value, stale: age >= APP_RESOLUTION_TTL_MS };
	} catch (error) {
		// A budget trip already emitted its structured diagnosis line.
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("App resolution cache read failed", {
				event: "resolution.cache_read_failed",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
		return null;
	}
}

async function writeAppResolutionR2(
	env: CloudflareEnv,
	cacheKey: string,
	value: ResolvedApp,
	epoch: string | null,
): Promise<void> {
	try {
		if (!("AGGREGATE_CACHE" in env) || !env.AGGREGATE_CACHE) return;
		// Budgeted: this write is awaited on the request path (see the caller), so
		// a wedged R2 put must fail open, not hang the resolve.
		await withStepBudget(
			"app_resolution_l2_write",
			CACHE_TIER_BUDGET_MS,
			env.AGGREGATE_CACHE.put(
				appResolutionR2Key(cacheKey),
				JSON.stringify({ cachedAt: Date.now(), app: value, epoch }),
				{ httpMetadata: { contentType: "application/json" } },
			),
			cacheKey,
		);
	} catch (error) {
		if (!(error instanceof StepBudgetExceededError)) {
			log.warn("App resolution cache write failed", {
				event: "resolution.cache_write_failed",
				outcome: "unavailable",
				error: contentFreeMcpException(error),
			});
		}
	}
}

function getCachedResolvedApp(
	key: string,
	epoch: string | null,
): ResolvedApp | null | undefined {
	const cached = appResolutionCache.get(key);
	if (!cached) return undefined;
	if (Date.now() > cached.expiresAt || cached.epoch !== epoch) {
		appResolutionCache.delete(key);
		return undefined;
	}
	return cached.value;
}

function setCachedResolvedApp(
	key: string,
	value: ResolvedApp | null,
	epoch: string | null,
): void {
	const ttl = value ? APP_RESOLUTION_TTL_MS : APP_RESOLUTION_NEGATIVE_TTL_MS;
	setBoundedCacheEntry(
		appResolutionCache,
		key,
		{ value, expiresAt: Date.now() + ttl, epoch },
		MAX_APP_RESOLUTION_CACHE_ENTRIES,
	);
}

export async function resolveAppFromHostname(
	hostnameInfo: HostnameInfo,
	env: CloudflareEnv,
): Promise<ResolvedApp | null> {
	if (hostnameInfo.type === "base_domain") {
		return null;
	}

	const cacheKey =
		hostnameInfo.type === "subdomain"
			? `mcp-subdomain:${hostnameInfo.appSlug ?? "unknown"}`
			: `custom:${hostnameInfo.customDomain ?? "unknown"}`;
	const epoch = await readAppResolutionEpoch(env, cacheKey);
	const canUseCache = epoch !== undefined;
	if (canUseCache) {
		const cached = getCachedResolvedApp(cacheKey, epoch);
		if (cached !== undefined) return cached;
	}
	const loadKey = canUseCache
		? `${cacheKey}\nepoch:${epoch ?? "legacy"}`
		: `${cacheKey}\nepoch-unavailable:${crypto.randomUUID()}`;

	const inFlight = appResolutionInFlight.get(loadKey);
	if (inFlight)
		return joinInFlightLoad(appResolutionInFlight, loadKey, inFlight, {
			step: "app_resolution_join",
			budgetMs: APP_RESOLUTION_WEDGE_EVICT_MS,
			resource: cacheKey,
		});

	// Everything below — including the L2 read — must sit inside the promise that
	// gets registered in `appResolutionInFlight`, and that registration must
	// happen with no `await` between the check above and the set below. An await
	// there lets two concurrent callers both pass the check and both start their
	// own resolve, which is the thundering herd onto a warming apps/api that this
	// map exists to prevent. (Caught by the "evicts a timed-out resolver" test.)
	const client = getApiClient({
		serviceFetch: env.API_SERVICE,
		headers: { "X-Tedix-Tedi-Scopes": "apps:read" },
	});

	// L2 before the network. A fresh durable entry means this cold isolate never
	// touches apps/api at all, which is the whole point: only one isolate per TTL
	// per app pays the 694-tool hydration, globally, instead of every cold isolate
	// in every colo. A stale entry is deliberately not served here — the live
	// resolve is the correct path while apps/api is healthy, and staleness stays
	// bounded by the same 60s contract L1 already had.
	const fromDurable = async (): Promise<ResolvedApp | null | undefined> => {
		if (!canUseCache) return undefined;
		const durable = await readAppResolutionR2(env, cacheKey, epoch);
		return durable && !durable.stale ? durable.value : undefined;
	};

	// Bounded retry lives inside the resolver so it is shared by the single
	// in-flight promise — one retry budget serves all concurrent callers of this
	// cacheKey (retrying at the call site would fan out a thundering herd onto a
	// warming apps/api). A final failure still throws → nothing is cached.
	// A thunk, not an eagerly-started promise. `withUpstreamRetry` is async, so
	// calling it fires the request immediately — which would hit apps/api on every
	// resolve and make the L2 read pointless.
	const runLive = () =>
		withUpstreamRetry(
			async () => {
				if (hostnameInfo.type === "subdomain" && hostnameInfo.appSlug) {
					const result = await client.apps.getBySlugWithTools({
						slug: hostnameInfo.appSlug,
					});
					if (!result.app) return null;
					const metadata = result.app.metadata as AppMetadata | null;
					return {
						tools: result.tools ?? [],
						app: {
							id: result.app.id,
							name: result.app.name,
							slug: result.app.slug,
							domain: result.app.primaryDomain,
							organizationId: result.app.organizationId,
							description: result.app.description,
							logoUrl: result.app.logoUrl,
							customMcpDomain: result.app.customMcpDomain,
							openaiChallengeToken: result.app.openaiChallengeToken,
							openaiAppId: result.app.openaiAppId,
							appStoreStatus: result.app.appStoreStatus,
							visibility: result.app.visibility,
							discoveryStatus: result.app.discoveryStatus,
							metadata,
						},
						metadata: metadata ?? null,
						catalogMcp: result.catalogMcp ?? null,
						catalogResources: result.catalogResources ?? [],
						catalogResourceTemplates: result.catalogResourceTemplates ?? [],
						catalogPrompts: result.catalogPrompts ?? [],
					};
				}
				if (hostnameInfo.type === "custom" && hostnameInfo.customDomain) {
					const domainResult = await client.apps.getByDomain({
						domain: hostnameInfo.customDomain,
					});
					if (!domainResult.app) return null;

					const fullResult = await client.apps.getBySlugWithTools({
						slug: domainResult.app.slug,
					});
					const fullApp = fullResult.app;
					const metadata = (fullApp?.metadata as AppMetadata | null) ?? null;
					return {
						tools: fullResult.tools ?? [],
						app: {
							id: fullApp?.id ?? domainResult.app.id,
							name: fullApp?.name ?? domainResult.app.name,
							slug: fullApp?.slug ?? domainResult.app.slug,
							domain: fullApp?.primaryDomain ?? domainResult.app.domain,
							organizationId:
								fullApp?.organizationId ?? domainResult.app.organizationId,
							description: fullApp?.description ?? null,
							logoUrl: fullApp?.logoUrl ?? null,
							customMcpDomain: fullApp?.customMcpDomain ?? null,
							openaiChallengeToken: fullApp?.openaiChallengeToken ?? null,
							openaiAppId: fullApp?.openaiAppId ?? null,
							appStoreStatus: fullApp?.appStoreStatus ?? null,
							visibility: fullApp?.visibility ?? domainResult.app.visibility,
							discoveryStatus: fullApp?.discoveryStatus ?? null,
							metadata,
						},
						metadata: metadata ?? null,
						catalogMcp: fullResult.catalogMcp ?? null,
						catalogResources: fullResult.catalogResources ?? [],
						catalogResourceTemplates: fullResult.catalogResourceTemplates ?? [],
						catalogPrompts: fullResult.catalogPrompts ?? [],
					};
				}
				return null;
			},
			{ operation: "resolve_app", resource: cacheKey },
		);

	// `servedFromDurable` is load-bearing, not bookkeeping: writing R2 after an L2
	// hit would reset `cachedAt` on every read, so the entry would keep refreshing
	// itself and never expire — apps/api would never be consulted again and a tool
	// edit could never propagate. Only a live resolve may write.
	let servedFromDurable = false;
	const resolver = (async (): Promise<ResolvedApp | null> => {
		const durable = await fromDurable();
		if (durable !== undefined) {
			servedFromDurable = true;
			return durable;
		}
		return runLive();
	})();

	// Wedge eviction: if the resolver somehow never settles despite its inner
	// budgets, drop it from the dedupe map so the next request retries fresh
	// instead of joining a poisoned promise.
	trackInFlightLoad(appResolutionInFlight, loadKey, resolver, {
		step: "app_resolution_in_flight",
		wedgeEvictMs: APP_RESOLUTION_WEDGE_EVICT_MS,
		resource: cacheKey,
	});
	try {
		const resolved = await joinInFlightLoad(
			appResolutionInFlight,
			loadKey,
			resolver,
			{
				step: "app_resolution_join",
				budgetMs: APP_RESOLUTION_WEDGE_EVICT_MS,
				resource: cacheKey,
			},
		);
		if (canUseCache) setCachedResolvedApp(cacheKey, resolved, epoch);
		// Positive results only — see the L2 comment on why negatives never go
		// durable. Awaited rather than fired-and-forgotten: this function has no
		// ExecutionContext, so an un-awaited write can be cancelled with the
		// request, and a write that never lands is a cache that never helps.
		if (canUseCache && resolved && !servedFromDurable) {
			await writeAppResolutionR2(env, cacheKey, resolved, epoch);
		}
		return resolved;
	} catch (error) {
		// apps/api is unreachable or too slow. A stale surface beats no surface:
		// without this the MCP handshake fails outright. Bounded by the hard TTL,
		// and cached only briefly so recovery is picked up quickly.
		const fallback = canUseCache
			? await readAppResolutionR2(env, cacheKey, epoch, {
					allowExpired: true,
				})
			: null;
		if (fallback) {
			log.warn("Serving stale app resolution", {
				event: "resolution.stale_fallback",
				error: contentFreeMcpException(error),
				outcome: "unavailable",
			});
			setBoundedCacheEntry(
				appResolutionCache,
				cacheKey,
				{
					value: fallback.value,
					expiresAt: Date.now() + APP_RESOLUTION_NEGATIVE_TTL_MS,
					epoch: epoch ?? null,
				},
				MAX_APP_RESOLUTION_CACHE_ENTRIES,
			);
			return fallback.value;
		}
		log.error("Failed to resolve app", {
			event: "resolution.app_lookup_failed",
			error: contentFreeMcpException(error),
			outcome: "unavailable",
		});
		throw error;
	}
	// No finally-delete here: trackInFlightLoad owns eviction (on settle and on
	// wedge timeout).
}

// =============================================================================
// CORS CONFIGURATION
// =============================================================================

export function getCorsOrigins(env: CloudflareEnv): string[] {
	const origins: string[] = [];

	const envUrls = [env.MCP_URL, env.MCP_UI_URL, env.API_URL].filter(Boolean);

	for (const urlStr of envUrls) {
		if (!urlStr) continue;
		try {
			const url = new URL(urlStr);
			origins.push(url.origin);

			const hostParts = url.hostname.split(".");
			if (hostParts.length > 2) {
				const rootDomain = hostParts.slice(-2).join(".");
				origins.push(`${url.protocol}//${rootDomain}`);
			}
		} catch {
			// Invalid URL, skip
		}
	}

	return [...new Set(origins)];
}

export function buildCorsOrigins(
	env: CloudflareEnv,
	appMetadata?: AppMetadata | null,
): string[] {
	const envOrigins = getCorsOrigins(env);
	const appOrigins = appMetadata?.mcpConfig?.corsOrigins ?? [];
	return [...new Set([...envOrigins, ...appOrigins])];
}
