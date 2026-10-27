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
import {
	pruneExpiredCacheEntries,
	setBoundedCacheEntry,
} from "./lib/bounded-cache";
import {
	CACHE_TIER_BUDGET_MS,
	StepBudgetExceededError,
	withStepBudget,
} from "./lib/step-budget";
import { contentFreeMcpException, createMcpLogger } from "./log";
const log = createMcpLogger("mcp.router");

export type AggregateSurfaceCacheEntry = {
	result: AggregatedMcpSurface;
	expiresAt: number;
	/** Content hash of the serialized snapshot this object was built from. */
	generation?: string;
};
export const aggregateSurfaceCache = new Map<
	string,
	AggregateSurfaceCacheEntry
>();
export const aggregateSurfaceInFlight = new Map<
	string,
	Promise<AggregatedMcpSurface>
>();
// Surfaces retain complete parsed schemas. Bound isolate retention under
// arbitrary namespace subsets and activation epochs; L2/R2 remain available.
// A consent-composed connect root retains one entry per mounted organization
// and nested gateway (14+ on the Tedix connect surface), so the bound leaves
// room for one such root without evicting its own members.
const MAX_AGGREGATE_SURFACE_CACHE_ENTRIES = 32;
export const AGGREGATE_SURFACE_CACHE_TTL_MS = 120_000;
// An expired entry stays reusable this long: a durable tier holding the same
// generation then returns it without parsing (see AggregateTierReadOptions).
const AGGREGATE_SURFACE_REUSE_GRACE_MS = AGGREGATE_SURFACE_CACHE_TTL_MS;

/** Release entries past their reuse grace, including keys never read again. */
export function pruneAggregateSurfaceCache(now = Date.now()): void {
	pruneExpiredCacheEntries(
		aggregateSurfaceCache,
		now - AGGREGATE_SURFACE_REUSE_GRACE_MS,
	);
}

/**
 * Retain a surface in L1. Nested graphs under a cached root are not retained:
 * the root already holds their tools. Nested graphs under a transient
 * (consent-composed) root are retained, because that root is recomposed from
 * them on every request.
 */
export function rememberAggregateSurface(
	cacheKey: string,
	result: AggregatedMcpSurface,
	retain: boolean,
	generation?: string,
) {
	if (!retain) return;
	pruneAggregateSurfaceCache();
	setBoundedCacheEntry(
		aggregateSurfaceCache,
		cacheKey,
		{
			result,
			expiresAt: Date.now() + AGGREGATE_SURFACE_CACHE_TTL_MS,
			...(generation ? { generation } : {}),
		},
		MAX_AGGREGATE_SURFACE_CACHE_ENTRIES,
	);
}

/**
 * One serialized aggregate snapshot, shared by the L2 and R2 writes.
 *
 * Root surfaces serialize to ~25 MB. Serializing once per write tier doubled
 * the transient heap of every rebuild on the 128 MB isolate that is also
 * serving requests (2026-10-27 `exceededMemory` on connect). `generation` is a
 * content hash of `body`, so a reader can recognize a snapshot it already
 * holds in memory without parsing it again.
 */
export type SerializedAggregateSnapshot = {
	body: string;
	generation: string;
	cachedAt: number;
};

export function serializeAggregateSnapshot(
	result: AggregatedMcpSurface,
	cachedAt = Date.now(),
): SerializedAggregateSnapshot {
	const body = JSON.stringify(result);
	return { body, generation: hashAggregateCacheKey(body), cachedAt };
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
type AggregateL2Read = {
	surface: AggregatedMcpSurface;
	stale: boolean;
	generation?: string;
	/** True when the in-memory `reuse` object was returned without parsing. */
	reused: boolean;
};
type AggregateTierReadOptions = {
	allowExpired?: boolean;
	/**
	 * The isolate's last copy for this key, possibly expired. A tier holding the
	 * same generation returns this object and never reads its body: parsing a
	 * root snapshot allocates ~25 MB of text plus its object graph, and a new
	 * object also discards every revision-owned catalog projection.
	 */
	reuse?: AggregateSurfaceCacheEntry;
};
const AGGREGATE_CACHED_AT_HEADER = "X-Tedix-Aggregate-Cached-At";
const AGGREGATE_GENERATION_HEADER = "X-Tedix-Aggregate-Generation";

function aggregateL2Request(cacheKey: string): Request {
	return aggregateL2RequestFromHash(hashAggregateCacheKey(cacheKey));
}

function aggregateL2RequestFromHash(cacheKeyHash: string): Request {
	return new Request(
		`https://aggregate-cache.mcp.tedix.internal/v1/${cacheKeyHash}`,
	);
}

// Releasing an unread body is best effort and never awaited: cancelling one
// branch of a teed stream settles only once every branch is cancelled.
function cancelSnapshotBody(cancel: () => unknown): void {
	void Promise.resolve()
		.then(cancel)
		.catch(() => {});
}

type SnapshotBodySource = {
	cachedAt: string | null | undefined;
	generation: string | null | undefined;
	json: () => Promise<unknown>;
	cancel: () => unknown;
};

type SnapshotBodyRead = {
	surface: AggregatedMcpSurface | undefined;
	cachedAt: number;
	generation?: string;
	reused: boolean;
};

/**
 * Decode one tier's snapshot. Current snapshots carry their age and generation
 * as metadata, so a reader can decide to skip the body before reading it.
 * Bodies without that metadata use the original `{ cachedAt, surface }` shape.
 */
async function readSnapshotBody(
	source: SnapshotBodySource,
	reuse: AggregateSurfaceCacheEntry | undefined,
	isAbandoned: () => boolean,
): Promise<SnapshotBodyRead | null> {
	if (isAbandoned()) {
		cancelSnapshotBody(source.cancel);
		return null;
	}
	const cachedAt = Number(source.cachedAt);
	if (source.generation && Number.isFinite(cachedAt)) {
		if (reuse?.generation === source.generation) {
			cancelSnapshotBody(source.cancel);
			return {
				surface: reuse.result,
				cachedAt,
				generation: source.generation,
				reused: true,
			};
		}
		return {
			surface: (await source.json()) as AggregatedMcpSurface,
			cachedAt,
			generation: source.generation,
			reused: false,
		};
	}
	const legacy = (await source.json()) as {
		cachedAt?: number;
		surface?: AggregatedMcpSurface;
	};
	return {
		surface: legacy?.surface,
		cachedAt: typeof legacy?.cachedAt === "number" ? legacy.cachedAt : 0,
		reused: false,
	};
}

function toTierRead(
	read: SnapshotBodyRead | null,
	hardTtlMs: number,
	allowExpired = false,
): AggregateL2Read | null {
	const surface = read?.surface;
	// Never serve a degraded/foreign snapshot — degraded surfaces are not
	// written, but guard defensively against an older/foreign entry.
	if (!read || !surface || surface.degraded) return null;
	const age = Date.now() - read.cachedAt;
	if (age >= hardTtlMs && !allowExpired) return null; // too stale → rebuild
	return {
		surface,
		stale: age >= AGGREGATE_SURFACE_CACHE_TTL_MS,
		...(read.generation ? { generation: read.generation } : {}),
		reused: read.reused,
	};
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
	options: AggregateTierReadOptions = {},
): Promise<AggregateL2Read | null> {
	// A budget trip stops waiting but cannot cancel the read. Without this flag
	// the abandoned read went on to parse the snapshot while the caller built a
	// second copy on the next tier.
	let abandoned = false;
	try {
		if (typeof caches === "undefined" || !caches.default) return null;
		// Budgeted (match + body read together): an unbudgeted Cache API hang here
		// sits at the top of the shared aggregate load — the silent-hang class in
		// `docs/engineering/mcp/runtime.md`. A trip emits the
		// diagnosis line and fails open to the next tier.
		const read = await withStepBudget(
			"aggregate_l2_read",
			CACHE_TIER_BUDGET_MS,
			(async () => {
				const hit = await caches.default.match(aggregateL2Request(cacheKey));
				if (!hit) return null;
				return readSnapshotBody(
					{
						cachedAt: hit.headers.get(AGGREGATE_CACHED_AT_HEADER),
						generation: hit.headers.get(AGGREGATE_GENERATION_HEADER),
						json: () => hit.json(),
						cancel: () => hit.body?.cancel(),
					},
					options.reuse,
					() => abandoned,
				);
			})(),
			cacheKey,
		).catch((error: unknown) => {
			abandoned = true;
			throw error;
		});
		return toTierRead(read, AGGREGATE_L2_HARD_TTL_MS);
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
	snapshot: SerializedAggregateSnapshot,
): Promise<void> {
	try {
		if (typeof caches === "undefined" || !caches.default) return;
		const body = new Response(snapshot.body, {
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": `max-age=${AGGREGATE_L2_HARD_TTL_SECONDS}`,
				[AGGREGATE_CACHED_AT_HEADER]: String(snapshot.cachedAt),
				[AGGREGATE_GENERATION_HEADER]: snapshot.generation,
			},
		});
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

// A stale snapshot used to be rebuilt by every isolate whose 120s L1 entry
// expired, because each one found its own last write stale. Each rebuild holds
// a second root surface plus its serialized text next to the copy the isolate
// is serving, which is how connect isolates crossed 128 MB. A short colo-local
// lease lets one isolate rebuild a key while the others keep serving the stale
// snapshot, which stays bounded by the hard TTL. Any lease failure fails open
// to the previous behavior (rebuild).
const AGGREGATE_REVALIDATION_LEASE_SECONDS = 60;

function aggregateRevalidationLeaseRequest(cacheKey: string): Request {
	return new Request(
		`https://aggregate-cache.mcp.tedix.internal/v1/revalidation-lease/${hashAggregateCacheKey(cacheKey)}`,
	);
}

export async function claimAggregateRevalidationLease(
	cacheKey: string,
): Promise<boolean> {
	try {
		if (typeof caches === "undefined" || !caches.default) return true;
		const request = aggregateRevalidationLeaseRequest(cacheKey);
		return await withStepBudget(
			"aggregate_revalidation_lease",
			CACHE_TIER_BUDGET_MS,
			(async () => {
				const held = await caches.default.match(request);
				if (held) {
					cancelSnapshotBody(() => held.body?.cancel());
					return false;
				}
				await caches.default.put(
					request,
					new Response("1", {
						headers: {
							"Cache-Control": `max-age=${AGGREGATE_REVALIDATION_LEASE_SECONDS}`,
						},
					}),
				);
				return true;
			})(),
			cacheKey,
		);
	} catch {
		return true;
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
	options: AggregateTierReadOptions = {},
): Promise<AggregateL2Read | null> {
	let abandoned = false;
	try {
		if (!("AGGREGATE_CACHE" in env) || !env.AGGREGATE_CACHE) return null;
		const bucket = env.AGGREGATE_CACHE;
		// Budgeted (get + body read together): this read also backs the
		// join-deadline and degraded-rebuild stale fallbacks, where an unbudgeted
		// R2 hang turned "serve stale instead of waiting" into a silent hang.
		const read = await withStepBudget(
			"aggregate_r2_read",
			CACHE_TIER_BUDGET_MS,
			(async () => {
				const obj = await bucket.get(aggregateR2Key(cacheKey));
				if (!obj) return null;
				return readSnapshotBody(
					{
						cachedAt: obj.customMetadata?.cachedAt,
						generation: obj.customMetadata?.generation,
						json: () => obj.json(),
						cancel: () => obj.body?.cancel(),
					},
					options.reuse,
					() => abandoned,
				);
			})(),
			cacheKey,
		).catch((error: unknown) => {
			abandoned = true;
			throw error;
		});
		// allowExpired: stale-beats-degraded fallback — when a cold rebuild comes
		// back degraded (e.g. the API service binding is mid-deploy), an old full
		// surface is far better than a fresh 3-namespace toy surface.
		return toTierRead(read, AGGREGATE_R2_HARD_TTL_MS, options.allowExpired);
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
	snapshot: SerializedAggregateSnapshot,
	rootSlug: string | undefined,
	toolCount: number,
): Promise<void> {
	try {
		if (!("AGGREGATE_CACHE" in env) || !env.AGGREGATE_CACHE) return;
		// Budgeted: awaited on the request path, so a wedged put must fail open.
		await withStepBudget(
			"aggregate_r2_write",
			CACHE_TIER_BUDGET_MS,
			env.AGGREGATE_CACHE.put(aggregateR2Key(cacheKey), snapshot.body, {
				httpMetadata: { contentType: "application/json" },
				customMetadata: {
					cachedAt: String(snapshot.cachedAt),
					generation: snapshot.generation,
				},
			}),
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
			toolCount,
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
