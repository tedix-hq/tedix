import {
	buildMcpAggregateCacheDataPoint,
	type McpAggregateCacheDataPointEvent,
} from "@tedix/api-contract/schemas/mcp-analytics";
import { createTelemetryWriter } from "@tedix/worker-kit/telemetry";
import type {
	AggregateAppEntry,
	AggregatedMcpSurface,
} from "./aggregate-types";
import { internalToolCache } from "./aggregate-internal-tools";
import { writeAggregateActivationEpoch } from "./aggregate-activation-epoch";
import { setBoundedExpiringCacheEntry } from "./lib/bounded-cache";
import {
	CACHE_TIER_BUDGET_MS,
	StepBudgetExceededError,
	withStepBudget,
} from "./lib/step-budget";
import { contentFreeMcpException, createMcpLogger } from "./log";
const log = createMcpLogger("mcp.router");

export const aggregateSurfaceCache = new Map<
	string,
	{ result: AggregatedMcpSurface; expiresAt: number }
>();
export const aggregateSurfaceInFlight = new Map<
	string,
	Promise<AggregatedMcpSurface>
>();
// Surfaces retain complete parsed schemas. Bound isolate retention under
// arbitrary namespace subsets and activation epochs; L2/R2 remain available.
const MAX_AGGREGATE_SURFACE_CACHE_ENTRIES = 8;
export const AGGREGATE_SURFACE_CACHE_TTL_MS = 120_000;

/** Nested graphs use durable snapshots without retaining duplicate schemas in L1. */
export function rememberAggregateSurface(
	cacheKey: string,
	result: AggregatedMcpSurface,
	visited: ReadonlySet<string>,
) {
	if (visited.size > 0) return;
	setBoundedExpiringCacheEntry(
		aggregateSurfaceCache,
		cacheKey,
		{ result, expiresAt: Date.now() + AGGREGATE_SURFACE_CACHE_TTL_MS },
		MAX_AGGREGATE_SURFACE_CACHE_ENTRIES,
	);
}

export function aggregateSurfaceCacheKey(
	entries: AggregateAppEntry[],
	deploymentFingerprint = "dev",
	activationEpoch = "initial",
	visited?: ReadonlySet<string>,
): string {
	return JSON.stringify({
		deploymentFingerprint,
		activationEpoch,
		...(visited?.size ? { visited: [...visited].sort() } : {}),
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
			organizationMount: entry.organizationMount ?? false,
			legacyNamespace: entry.legacyNamespace ?? null,
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
export const aggregateRevalidateInFlight = new Set<string>();
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
const writeAggregateTelemetry = createTelemetryWriter(
	"mcp.aggregate.analytics",
);

export function emitAggregateCacheMetric(
	env: CloudflareEnv,
	event: McpAggregateCacheDataPointEvent,
): void {
	writeAggregateTelemetry(() =>
		env.ANALYTICS?.writeDataPoint(buildMcpAggregateCacheDataPoint(event)),
	);
}
export async function readAggregateL2(
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
export async function writeAggregateL2(
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
export async function readAggregateR2(
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
export async function writeAggregateR2(
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
