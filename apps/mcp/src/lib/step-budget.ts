/**
 * MCP Worker — per-step budgets for the surface-build path.
 *
 * The surface build has explicit budgets for the expensive upstream calls
 * (skill-cache fetches, `withUpstreamRetry`, the aggregate entry/join
 * deadlines), but every other await on the same path needs one too: the durable
 * cache tiers (R2 `get`/`put`, `caches.default.match`/`put`), the raw
 * `apps.getBySlugWithTools` inside the internal tool resolver, and the direct
 * `skills.listByApp`/`listByOrg` calls in `registerAppSkills`. An unbudgeted
 * await that wedges produces a silent hang with no log line — and several sit
 * inside shared in-flight dedupe promises that are only evicted when the
 * promise settles, so a single wedged await would serve the same silent hang to
 * every subsequent request until the isolate recycles.
 *
 * Three primitives bound the class:
 *
 *  - {@link withStepBudget} — bound one await and, when the budget trips, emit
 *    one structured error event naming the wedged step.
 *  - {@link trackInFlightLoad} — register a shared in-flight promise with a
 *    wedge-eviction timer: if it has not settled by `wedgeEvictMs`, it is
 *    removed from the dedupe map (and the eviction reported), so the next
 *    request retries fresh instead of joining a poisoned promise.
 *  - {@link joinInFlightLoad} — bound each caller in its own request context,
 *    including callers whose shared load outlives its originating request.
 */

import { createMcpLogger } from "../log";

const log = createMcpLogger("mcp.step_budget");

/**
 * Budget for one durable-cache-tier operation (R2 get/put, Workers Cache API
 * match/put, including reading the returned body). Matches the skill-cache
 * per-app fetch budget (`SKILL_SUMMARY_FETCH_TIMEOUT_MS`): a cache tier is
 * strictly cheaper than the upstream fetch it fronts, so it never deserves a
 * larger budget than that fetch — every caller is fail-open and falls through
 * to the next tier or the live path.
 */
export const CACHE_TIER_BUDGET_MS = 2_500;

export class StepBudgetExceededError extends Error {
	readonly code = "STEP_BUDGET_EXCEEDED";
	readonly step: string;
	readonly budgetMs: number;

	constructor(step: string, budgetMs: number) {
		super(`${step} exceeded its ${budgetMs}ms budget`);
		this.name = "StepBudgetExceededError";
		this.step = step;
		this.budgetMs = budgetMs;
	}
}

/** The single structured diagnosis line for a wedged step. */
function reportStepBudgetExceeded(
	step: string,
	budgetMs: number,
	resource?: string,
): void {
	log.error("Step budget exceeded", {
		event: "step_budget.exceeded",
		step,
		budgetMs,
		resourceKey: resource,
		outcome: "unavailable",
		error: new StepBudgetExceededError(step, budgetMs),
	});
}

/**
 * Await `promise`, but never longer than `budgetMs`. On the budget tripping,
 * emit the structured diagnosis line and reject with
 * {@link StepBudgetExceededError}. The underlying promise keeps running; its
 * eventual settlement never surfaces as an unhandled rejection.
 */
export function withStepBudget<T>(
	step: string,
	budgetMs: number,
	promise: Promise<T>,
	resource?: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reportStepBudgetExceeded(step, budgetMs, resource);
			reject(new StepBudgetExceededError(step, budgetMs));
		}, budgetMs);
	});
	promise.catch(() => {});
	return Promise.race([promise, deadline]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/**
 * Register a shared in-flight load in its dedupe map with wedge eviction.
 *
 * Every await inside the loads that use this is individually budgeted, so a
 * healthy or merely-slow load always settles well inside `wedgeEvictMs` — the
 * timer is defense-in-depth for the failure mode the budgets cannot prove
 * impossible: a promise that never settles. When it fires, the entry is
 * evicted (next request builds fresh) and the eviction is reported with the
 * same structured diagnosis line. Settlement (either way) clears the timer and
 * evicts normally, so callers must not delete the entry themselves.
 */
export function trackInFlightLoad<K, V>(
	map: Map<K, Promise<V>>,
	key: K,
	load: Promise<V>,
	options: { step: string; wedgeEvictMs: number; resource?: string },
): void {
	map.set(key, load);
	const timer = setTimeout(() => {
		if (map.get(key) === load) {
			map.delete(key);
			reportStepBudgetExceeded(
				options.step,
				options.wedgeEvictMs,
				options.resource,
			);
		}
	}, options.wedgeEvictMs);
	load
		.catch(() => {})
		.finally(() => {
			clearTimeout(timer);
			if (map.get(key) === load) {
				map.delete(key);
			}
		});
}

/** Bound this request's wait even when the request that owns the load has ended.
 * Evict only that load on timeout, so a later request can rebuild safely.
 */
export async function joinInFlightLoad<K, V>(
	map: Map<K, Promise<V>>,
	key: K,
	load: Promise<V>,
	options: { step: string; budgetMs: number; resource?: string },
): Promise<V> {
	try {
		return await withStepBudget(
			options.step,
			options.budgetMs,
			load,
			options.resource,
		);
	} catch (error) {
		if (error instanceof StepBudgetExceededError && map.get(key) === load) {
			map.delete(key);
		}
		throw error;
	}
}
