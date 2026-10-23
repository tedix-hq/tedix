import type { AggregateAppEntry } from "./aggregate-types";
import { getApiClient } from "./lib/api-client";
import { UPSTREAM_ATTEMPT_TIMEOUT_MS } from "./upstream";
import {
	internalToolCache,
	internalToolInFlight,
	internalToolCacheKey,
	isAggregateSourceVisited,
	toInternalResolveResult,
	INTERNAL_TOOL_CACHE_TTL_MS,
	MAX_INTERNAL_TOOL_CACHE_ENTRIES,
} from "./aggregate-internal-tools";
import {
	pruneExpiredCacheEntries,
	setBoundedExpiringCacheEntry,
} from "./lib/bounded-cache";
import { contentFreeMcpException, createMcpLogger } from "./log";
const log = createMcpLogger("mcp.router");

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

type AggregatePrefetchBatch = {
	buffer: Map<string, AggregatePrefetchRequest>;
	flush: Promise<void> | null;
};

const aggregatePrefetchBatches = new WeakMap<Fetcher, AggregatePrefetchBatch>();

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
async function flushAggregatePrefetch(
	serviceFetch: Fetcher,
	batch: AggregatePrefetchBatch,
): Promise<void> {
	const buffered = batch.buffer;
	batch.buffer = new Map();
	batch.flush = null;
	if (buffered.size === 0) return;

	const requests = [...buffered.entries()];
	const started = Date.now();
	try {
		const client = getApiClient({
			serviceFetch,
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

export async function prefetchAggregateEntries(
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
	let batch = aggregatePrefetchBatches.get(env.API_SERVICE);
	if (!batch) {
		batch = { buffer: new Map(), flush: null };
		aggregatePrefetchBatches.set(env.API_SERVICE, batch);
	}

	// Buffer, then join the pending window. Adding and scheduling happen with no
	// await in between, so the window cannot close between them and drop these
	// keys into a flush this caller is not awaiting.
	for (const [cacheKey, request] of wanted) {
		if (!batch.buffer.has(cacheKey)) {
			batch.buffer.set(cacheKey, request);
		}
	}
	batch.flush ??= new Promise<void>((resolve) => {
		setTimeout(() => {
			resolve(flushAggregatePrefetch(env.API_SERVICE, batch));
		}, AGGREGATE_PREFETCH_COALESCE_MS);
	});
	await batch.flush.catch(() => undefined);
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
