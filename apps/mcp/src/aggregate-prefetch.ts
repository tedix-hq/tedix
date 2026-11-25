import type { AggregateAppEntry } from "./aggregate-types";
import { getApiClient } from "./lib/api-client";
import { UPSTREAM_ATTEMPT_TIMEOUT_MS } from "./upstream";
import {
	internalToolCacheKey,
	internalToolInFlight,
	isAggregateSourceVisited,
	loadInternalTools,
	type UpstreamAppWithTools,
} from "./aggregate-internal-tools";
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
	projection?: "contract";
};

type AggregatePrefetchBatch = {
	buffer: Map<
		string,
		{
			request: AggregatePrefetchRequest;
			resolve: (result: UpstreamAppWithTools) => void;
			reject: (error: unknown) => void;
		}
	>;
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
		await Promise.all(
			chunks.map(async (chunk) => {
				try {
					const { results } = await withUpstreamAttemptDeadline(
						client.apps.getBySlugsWithTools({
							apps: chunk.map(([, item]) => item.request),
						}),
						AGGREGATE_PREFETCH_TIMEOUT_MS,
					);
					for (const [index, [, item]] of chunk.entries()) {
						const result = results[index];
						if (result?.slug === item.request.slug) item.resolve(result);
						else item.reject(new Error("Incomplete tool definitions batch"));
					}
				} catch (error) {
					for (const [, item] of chunk) item.reject(error);
					throw error;
				}
			}),
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
	ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<void> {
	const wanted = new Map<string, AggregatePrefetchRequest>();
	for (const entry of entries) {
		if (isAggregateSourceVisited(visited, entry)) continue;
		const selection = {
			...(entry.projection ? { projection: entry.projection } : {}),
			...(entry.endpointPrefixes?.length
				? { endpointPrefixes: entry.endpointPrefixes }
				: {}),
			...(entry.toolIds?.length ? { toolIds: entry.toolIds } : {}),
		};
		const cacheKey = internalToolCacheKey(entry, selection, activationEpoch);
		if (wanted.has(cacheKey)) continue;
		if (cacheable && internalToolInFlight.has(cacheKey)) continue;
		wanted.set(cacheKey, {
			slug: entry.slug,
			...(entry.appId ? { appId: entry.appId } : {}),
			...(entry.hostOrganizationId
				? { hostOrganizationId: entry.hostOrganizationId }
				: {}),
			...selection,
		});
	}
	if (wanted.size === 0) return;
	let batch = aggregatePrefetchBatches.get(env.API_SERVICE);
	if (!batch) {
		batch = { buffer: new Map(), flush: null };
		aggregatePrefetchBatches.set(env.API_SERVICE, batch);
	}

	const activeBatch = batch;
	await Promise.all(
		[...wanted].map(async ([cacheKey, request]) => {
			const fetchUpstream = () =>
				new Promise<UpstreamAppWithTools>((resolve, reject) => {
					const existing = activeBatch.buffer.get(cacheKey);
					if (existing) {
						const priorResolve = existing.resolve;
						const priorReject = existing.reject;
						existing.resolve = (result) => {
							priorResolve(result);
							resolve(result);
						};
						existing.reject = (error) => {
							priorReject(error);
							reject(error);
						};
					} else activeBatch.buffer.set(cacheKey, { request, resolve, reject });
					activeBatch.flush ??= new Promise<void>((done) => {
						setTimeout(
							() => done(flushAggregatePrefetch(env.API_SERVICE, activeBatch)),
							AGGREGATE_PREFETCH_COALESCE_MS,
						);
					});
				});
			try {
				if (cacheable)
					await loadInternalTools(cacheKey, request.slug, fetchUpstream, ctx);
				else await fetchUpstream();
			} catch {
				// Prefetch is optional; direct resolution reports a failed cold load.
			}
		}),
	);
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
