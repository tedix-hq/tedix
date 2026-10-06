import type { ApiClient } from "../lib/api-client";
import { setBoundedCacheEntry } from "../lib/bounded-cache";
import { CACHE_TIER_BUDGET_MS, withStepBudget } from "../lib/step-budget";
import { UPSTREAM_ATTEMPT_TIMEOUT_MS } from "../upstream";

const SKILL_SUMMARY_CACHE_TTL_MS = 5 * 60_000;
const SKILL_SUMMARY_NEGATIVE_CACHE_TTL_MS = 30_000;
const SKILL_SUMMARY_FETCH_TIMEOUT_MS = 2_500;
const MAX_SKILL_SUMMARY_CACHE_ENTRIES = 500;
/**
 * Budget for one batched `skills.listSummariesByApps` call.
 *
 * A shorter budget (8s) timed out on aggregate rebuilds that landed on a cold
 * isolate — the batch was correct, its budget was not.
 *
 * The right number is the one this repo already stands behind for "one apps/api
 * call that may land on a cold isolate": {@link UPSTREAM_ATTEMPT_TIMEOUT_MS}.
 * That constant is calibrated against apps/api cold-start cost, and this
 * call is exactly that shape — one invocation, one org-scoped D1 read chunked at
 * 50 app ids. Importing it rather than copying a literal means the two move
 * together: whoever earns the right to bring the upstream deadline back down
 * brings this down with it.
 *
 * Where the 12s can actually be spent — this is foreground, not background.
 * `AGGREGATE_JOIN_DEADLINE_MS` (8s) bounds waiting on the aggregate *surface*,
 * but skill enrichment runs later, in `buildMcpServer` on the request path
 * (`buildServerInstructions` and `enrichToolsWithSkills`), so it is not covered
 * by that deadline. Worst-case foreground therefore rises from 8+8=16s to
 * 8+12=20s, still comfortably inside the MCP client's 60s negotiation probe —
 * the budget a real negotiation timeout actually blew. Both call sites share one cache key (`limit: 50`), so a
 * request pays this at most once.
 *
 * A slower timeout is only safe because a failing upstream now stops being
 * re-asked after one batch — see {@link recordSkillSummaryBatchFailure}.
 */
export const SKILL_SUMMARY_BATCH_FETCH_TIMEOUT_MS = UPSTREAM_ATTEMPT_TIMEOUT_MS;

/**
 * Skill summaries are optional enrichment — every failure path here already
 * degrades to `[]` and the server builds fine without them. They must therefore
 * never be able to dominate request latency.
 *
 * The per-app negative cache does not bound this on its own, because each
 * distinct app pays the timeout once; fanned out, those waits stack on top of
 * the aggregate rebuild and can exceed the MCP client's negotiation probe.
 *
 * When the upstream is unhealthy the Nth timeout tells us nothing the 1st did
 * not. After BREAKER_THRESHOLD consecutive timeouts the breaker opens and every
 * remaining lookup returns `[]` immediately for BREAKER_COOLDOWN_MS, bounding the
 * whole fan-out to roughly one timeout's worth of latency. Any single success
 * closes it again, so a healthy API is never penalised.
 */
const BREAKER_THRESHOLD = 3;
const BREAKER_COOLDOWN_MS = 30_000;

const skillSummaryBreaker = {
	consecutiveTimeouts: 0,
	openUntil: 0,
};

function breakerIsOpen(): boolean {
	return Date.now() < skillSummaryBreaker.openUntil;
}

function recordSkillSummaryFailure(): void {
	skillSummaryBreaker.consecutiveTimeouts += 1;
	if (skillSummaryBreaker.consecutiveTimeouts >= BREAKER_THRESHOLD) {
		skillSummaryBreaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
	}
}

/**
 * A BATCH failure opens the breaker immediately.
 *
 * The breaker's premise is unchanged ("the Nth timeout tells us nothing the 1st
 * did not") — what changed is how many calls a request makes. Pre-batching, one
 * rebuild issued ~40 lookups, so BREAKER_THRESHOLD consecutive failures were
 * reached within a single request and the remaining apps cost nothing. Batched,
 * a request makes exactly one call, so a threshold of 3 would need three whole
 * requests to trip — three requests each paying the full timeout. Since one
 * batch carries what ~40 calls used to, treating its failure as decisive
 * restores the original blast radius instead of widening it.
 */
function recordSkillSummaryBatchFailure(): void {
	skillSummaryBreaker.consecutiveTimeouts = BREAKER_THRESHOLD;
	skillSummaryBreaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
}

function recordSkillSummarySuccess(): void {
	skillSummaryBreaker.consecutiveTimeouts = 0;
	skillSummaryBreaker.openUntil = 0;
}

/** Exposed for tests; isolate-local state must not leak between cases. */
/** @internal */
export function __resetSkillSummaryBreaker(): void {
	skillSummaryBreaker.consecutiveTimeouts = 0;
	skillSummaryBreaker.openUntil = 0;
}

/**
 * SEP-2549 result-level freshness hint for `resources/read` of skill content:
 * Per-skill `skill://…/SKILL.md` and skill directory template files change on
 * skill mutations and are served through
 * the skill-summary cache below, so the hint mirrors
 * `SKILL_SUMMARY_CACHE_TTL_MS` (5 min). Skills are org/app-scoped D1 rows —
 * a shared cache must not serve skill content across users → `"private"`.
 * Attached to the read result under `MCP_RESULT_CACHE_HINT_META_KEY`
 * (`@tedix/mcp-shared/transport`); the transport strips the marker and emits
 * the fields.
 */
export const SKILL_INDEX_CACHE_HINT = {
	ttlMs: SKILL_SUMMARY_CACHE_TTL_MS,
	cacheScope: "private",
} as const;

interface CachedSkillSummary {
	id: string;
	title: string;
	slug?: string | null;
	summary?: string | null;
	description?: string | null;
	tags?: string[] | null;
	toolIds?: string[] | null;
	successCount: number;
	revision: number;
	audience?: string[] | null;
	appId?: string | null;
	r2Path?: string | null;
}

// L1: in-memory per-isolate. Lost on isolate recycle.
const skillSummaryCache = new Map<
	string,
	{ summaries: CachedSkillSummary[]; expiresAt: number }
>();
const skillSummaryInFlight = new Map<string, Promise<CachedSkillSummary[]>>();

function cacheSkillSummaries(
	key: string,
	value: { summaries: CachedSkillSummary[]; expiresAt: number },
): void {
	setBoundedCacheEntry(
		skillSummaryCache,
		key,
		value,
		MAX_SKILL_SUMMARY_CACHE_ENTRIES,
	);
}

function skillSummaryCacheKey(params: {
	appId: string;
	orgId: string | undefined;
	tediId?: string;
	limit?: number;
}): string {
	return JSON.stringify({
		appId: params.appId,
		// skills.listByApp is org-scoped server-side (requireOrgId on the
		// X-Tedix-Org-Id the apiClient was built with). Shared base apps are
		// aggregated by many orgs under the same appId, so omitting the org
		// here would serve one org's skill summaries to another org's
		// enrichment on the same isolate/colo.
		orgId: params.orgId ?? "no-org",
		tediId: params.tediId ?? "",
		limit: params.limit ?? null,
	});
}

// ── L2: durable per-colo skill-summary cache (Workers Cache API) ──
// L1 is per-isolate, so a cold isolate re-fans-out `skills.listByApp` for every
// source app during Code Mode skill enrichment — even when the aggregate surface
// itself is served from its own L2/R2. That burst is a chunk of the cold-connect
// cost (and a local remote-D1 flap trigger). caches.default survives isolate
// recycle, keyed per (appId, orgId, tediId) like L1. Only successful reads are written
// durably (a flap-induced empty must not poison the colo). Fully fail-safe: any
// Cache API error falls through to L1/the live fetch.
const SKILL_SUMMARY_L2_TTL_SECONDS = SKILL_SUMMARY_CACHE_TTL_MS / 1000;
function skillSummaryL2Request(key: string): Request {
	return new Request(
		`https://skill-cache.mcp.tedix.internal/v1/${encodeURIComponent(key)}`,
	);
}
async function readSkillSummaryL2(
	key: string,
): Promise<CachedSkillSummary[] | null> {
	try {
		if (typeof caches === "undefined" || !caches.default) return null;
		// Budgeted (match + body read together): this read runs inside the shared
		// per-key in-flight promise, so an unbudgeted Cache API hang would wedge
		// every request for the key (the silent-hang class). A trip emits
		// the structured diagnosis line and fails open to the live fetch.
		return await withStepBudget(
			"skill_summary_l2_read",
			CACHE_TIER_BUDGET_MS,
			(async () => {
				const hit = await caches.default.match(skillSummaryL2Request(key));
				if (!hit) return null;
				return (await hit.json()) as CachedSkillSummary[];
			})(),
		);
	} catch {
		return null;
	}
}
async function writeSkillSummaryL2(
	key: string,
	summaries: CachedSkillSummary[],
): Promise<void> {
	try {
		if (typeof caches === "undefined" || !caches.default) return;
		// Budgeted: awaited on the request path, so a wedged put must fail open.
		await withStepBudget(
			"skill_summary_l2_write",
			CACHE_TIER_BUDGET_MS,
			caches.default.put(
				skillSummaryL2Request(key),
				new Response(JSON.stringify(summaries), {
					headers: {
						"Content-Type": "application/json",
						"Cache-Control": `max-age=${SKILL_SUMMARY_L2_TTL_SECONDS}`,
					},
				}),
			),
		);
	} catch {
		// swallow — never let the cache break enrichment
	}
}

export async function getCachedSkillSummaries(params: {
	apiClient: ApiClient;
	appId: string;
	/**
	 * Org the apiClient authenticates as (X-Tedix-Org-Id) — required in the
	 * cache key because listByApp results are org-scoped. Required-but-
	 * undefinable so every call site states it explicitly; undefined callers
	 * share one "no-org" bucket, which resolves identically server-side.
	 */
	orgId: string | undefined;
	tediId?: string;
	limit?: number;
}): Promise<CachedSkillSummary[]> {
	const key = skillSummaryCacheKey(params);
	const now = Date.now();
	const cached = skillSummaryCache.get(key);
	if (cached && cached.expiresAt > now) {
		return cached.summaries;
	}

	// Upstream is known-unhealthy: skip the doomed round-trip entirely. These
	// summaries are optional, and the alternative is paying the full timeout once
	// per app across the whole fan-out.
	if (breakerIsOpen()) return [];

	const inFlight = skillSummaryInFlight.get(key);
	if (inFlight) return inFlight;

	const request = (async (): Promise<CachedSkillSummary[]> => {
		// L2 (durable, cross-isolate) before the remote listByApp fan-out.
		const l2 = await readSkillSummaryL2(key);
		if (l2) {
			cacheSkillSummaries(key, {
				summaries: l2,
				expiresAt: Date.now() + SKILL_SUMMARY_CACHE_TTL_MS,
			});
			return l2;
		}
		try {
			const result = await withTimeout(
				params.apiClient.skills.listByApp({
					appId: params.appId,
					tediId: params.tediId,
					summaryOnly: true,
					...(params.limit ? { limit: params.limit } : {}),
				}),
				SKILL_SUMMARY_FETCH_TIMEOUT_MS,
				`skills.listByApp(${params.appId})`,
			);
			const summaries = result.summaries ?? [];
			recordSkillSummarySuccess();
			cacheSkillSummaries(key, {
				summaries,
				expiresAt: Date.now() + SKILL_SUMMARY_CACHE_TTL_MS,
			});
			// Only successful reads are written durably — a flap-induced empty
			// (the catch branch) must not poison the colo for 5 minutes.
			await writeSkillSummaryL2(key, summaries);
			return summaries;
		} catch (error) {
			recordSkillSummaryFailure();
			if (cached) return cached.summaries;
			console.warn(
				`[MCP] Optional skill summary lookup skipped for ${params.appId}:`,
				error instanceof Error ? error.message : error,
			);
			cacheSkillSummaries(key, {
				summaries: [],
				expiresAt: Date.now() + SKILL_SUMMARY_NEGATIVE_CACHE_TTL_MS,
			});
			return [];
		}
	})().finally(() => {
		skillSummaryInFlight.delete(key);
	});

	skillSummaryInFlight.set(key, request);
	return request;
}

/**
 * Batched {@link getCachedSkillSummaries}: one `skills.listSummariesByApps` call
 * for every cache-missing app instead of one `listByApp` per app.
 *
 * This fixes the fan-out itself, not just its blast radius: a cold apps/api
 * invocation burns seconds of CPU (the `worker-app` graph is evaluated per
 * isolate), so collapsing one request per app into one request removes a cold
 * isolate initialisation per app per rebuild.
 *
 * L1/L2 caching, the negative cache and the circuit breaker all still apply;
 * only the transport shape changes. A cache hit never reaches the network, and
 * an open breaker returns `[]` for the remaining apps without a round trip.
 */
export async function getCachedSkillSummariesForApps(params: {
	apiClient: ApiClient;
	appIds: string[];
	orgId: string | undefined;
	tediId?: string;
	limit?: number;
}): Promise<Map<string, CachedSkillSummary[]>> {
	const now = Date.now();
	const out = new Map<string, CachedSkillSummary[]>();
	const missing: string[] = [];

	for (const appId of new Set(params.appIds.filter(Boolean))) {
		const key = skillSummaryCacheKey({ ...params, appId });
		const cached = skillSummaryCache.get(key);
		if (cached && cached.expiresAt > now) {
			out.set(appId, cached.summaries);
			continue;
		}
		const l2 = await readSkillSummaryL2(key);
		if (l2) {
			cacheSkillSummaries(key, {
				summaries: l2,
				expiresAt: now + SKILL_SUMMARY_CACHE_TTL_MS,
			});
			out.set(appId, l2);
			continue;
		}
		missing.push(appId);
	}

	if (missing.length === 0) return out;
	if (breakerIsOpen()) {
		for (const appId of missing) out.set(appId, []);
		return out;
	}

	try {
		const result = await withTimeout(
			params.apiClient.skills.listSummariesByApps({
				appIds: missing,
				tediId: params.tediId,
				...(params.limit ? { limit: params.limit } : {}),
			}),
			// One call now carries what ~40 used to, so it earns a cold-isolate
			// budget rather than the single-app one. 8s was not enough: production
			// timed this exact call out at 35 apps on every rebuild.
			SKILL_SUMMARY_BATCH_FETCH_TIMEOUT_MS,
			`skills.listSummariesByApps(${missing.length} apps)`,
		);
		recordSkillSummarySuccess();
		const byApp = result.summariesByApp ?? {};
		for (const appId of missing) {
			const summaries = (byApp[appId] ?? []) as CachedSkillSummary[];
			const key = skillSummaryCacheKey({ ...params, appId });
			cacheSkillSummaries(key, {
				summaries,
				expiresAt: Date.now() + SKILL_SUMMARY_CACHE_TTL_MS,
			});
			await writeSkillSummaryL2(key, summaries);
			out.set(appId, summaries);
		}
	} catch (error) {
		recordSkillSummaryBatchFailure();
		console.warn(
			`[MCP] Optional skill summary batch skipped for ${missing.length} app(s):`,
			error instanceof Error ? error.message : error,
		);
		// Negative-cache the batch so a failing upstream is not re-asked per app
		// for the next 30s, and degrade to empty — these summaries are optional.
		for (const appId of missing) {
			cacheSkillSummaries(skillSummaryCacheKey({ ...params, appId }), {
				summaries: [],
				expiresAt: Date.now() + SKILL_SUMMARY_NEGATIVE_CACHE_TTL_MS,
			});
			out.set(appId, []);
		}
	}
	return out;
}

/**
 * Run one direct `skills.*` list call under the skill-cache discipline: the
 * per-app fetch budget ({@link SKILL_SUMMARY_FETCH_TIMEOUT_MS}) plus the shared
 * circuit breaker.
 *
 * `registerAppSkills` (tool-registration.ts) issues `skills.listByApp` /
 * `skills.listByOrg` calls directly — full content, so they cannot ride the
 * summary cache. Without a budget and the breaker, a stalled apps/api skills
 * endpoint would hang every tools/list silently for its full stall, while the
 * budgeted summary paths degrade in 2.5s.
 *
 * Returns `null` when the breaker is open (upstream known-unhealthy — skip the
 * doomed round-trip; skills are optional enrichment). On the budget tripping
 * the helper has already emitted the structured diagnosis line and recorded the
 * failure toward the breaker; the raised `StepBudgetExceededError` tells the
 * caller not to retry — an immediate retry of a full-budget timeout cannot
 * succeed.
 */
export async function fetchSkillListWithBudget<T>(
	step: string,
	resource: string,
	thunk: () => Promise<T>,
): Promise<T | null> {
	if (breakerIsOpen()) return null;
	try {
		const result = await withStepBudget(
			step,
			SKILL_SUMMARY_FETCH_TIMEOUT_MS,
			thunk(),
			resource,
		);
		recordSkillSummarySuccess();
		return result;
	} catch (error) {
		recordSkillSummaryFailure();
		throw error;
	}
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	label: string,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			reject(new Error(`${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	});

	return Promise.race([promise, timeoutPromise]).finally(() => {
		if (timeout) clearTimeout(timeout);
	});
}

export async function mapWithConcurrency<T, R>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	const workerCount = Math.max(1, Math.min(limit, items.length));
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (nextIndex < items.length) {
				const index = nextIndex++;
				results[index] = await worker(items[index]!);
			}
		}),
	);
	return results;
}
