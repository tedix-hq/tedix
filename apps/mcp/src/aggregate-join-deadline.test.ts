/**
 * A request must never have to survive a cold aggregate rebuild.
 *
 * A full rebuild on the request path can outlast the client's patience. Because
 * every caller joins the single in-flight rebuild, one cold key would stall
 * every concurrent request on the surface, including the CLI's negotiation
 * probe.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AggregatedMcpSurface } from "./aggregate-types";
import { joinAggregateLoad } from "./aggregate-surface-cache";
import { CACHE_TIER_BUDGET_MS } from "./lib/step-budget";

function surface(toolCount: number): AggregatedMcpSurface {
	return {
		tools: Array.from({ length: toolCount }, (_, i) => ({
			name: `tool_${i}`,
		})),
		resources: [],
		resourceTemplates: [],
		prompts: [],
	} as unknown as AggregatedMcpSurface;
}

// No ANALYTICS and no R2 binding: readAggregateR2 finds nothing, which is the
// "first ever build for this key" case.
const emptyEnv = {} as never;

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("aggregate join deadline", () => {
	/**
	 * After the join deadline fires, the stale fallback must not await an
	 * unbudgeted R2 `get`: a wedged R2 would turn "serve stale instead of
	 * waiting" into a silent indefinite hang.
	 */
	it("bounds a NEVER-settling R2 stale-fallback read with the diagnosis line", async () => {
		vi.useFakeTimers();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const wedgedR2Env = {
			AGGREGATE_CACHE: { get: () => new Promise<never>(() => {}) },
		} as never;
		const load = new Promise<AggregatedMcpSurface>((resolve) =>
			setTimeout(() => resolve(surface(3)), 10_000),
		);
		const joined = joinAggregateLoad(
			load,
			"key-wedged-r2",
			wedgedR2Env,
			"acme-unified",
			"cold",
			150,
		);
		// Deadline (150ms) + the budgeted fallback read + the load's own settle.
		await vi.advanceTimersByTimeAsync(150 + CACHE_TIER_BUDGET_MS + 10_000);
		const result = await joined;
		expect(result.tools).toHaveLength(3);
		const line = errorSpy.mock.calls
			.map(([entry]) => entry as Record<string, unknown>)
			.find((entry) => entry?.step === "aggregate_r2_read");
		expect(line).toMatchObject({
			component: "mcp.step_budget",
			event: "step_budget.exceeded",
			step: "aggregate_r2_read",
			budgetMs: CACHE_TIER_BUDGET_MS,
		});
	});

	it("never loads a serialized fallback for a transient consent-composed root", async () => {
		vi.useFakeTimers();
		const get = vi
			.fn()
			.mockRejectedValue(new Error("oversized snapshot must not be read"));
		const env = { AGGREGATE_CACHE: { get } } as never;
		const load = new Promise<AggregatedMcpSurface>((resolve) =>
			setTimeout(() => resolve(surface(12)), 500),
		);
		const joined = joinAggregateLoad(
			load,
			"transient",
			env,
			"connect",
			"joined",
			100,
			false,
		);
		await vi.advanceTimersByTimeAsync(500);
		expect((await joined).tools).toHaveLength(12);
		expect(get).not.toHaveBeenCalled();
	});

	it("does not parse an R2 fallback beside a nested cold build", async () => {
		vi.useFakeTimers();
		const get = vi.fn();
		const env = { AGGREGATE_CACHE: { get } } as never;
		const load = new Promise<AggregatedMcpSurface>((resolve) =>
			setTimeout(() => resolve(surface(12)), 500),
		);
		const joined = joinAggregateLoad(
			load,
			"nested",
			env,
			undefined,
			"cold",
			100,
			true,
			true,
		);
		await vi.advanceTimersByTimeAsync(500);
		expect((await joined).tools).toHaveLength(12);
		expect(get).not.toHaveBeenCalled();
	});

	it("still serves a full stale snapshot at a root deadline", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const stale = surface(12);
		const json = vi.fn(async () => ({ cachedAt: 0, surface: stale }));
		const env = {
			AGGREGATE_CACHE: { get: vi.fn(async () => ({ json })) },
		} as never;
		const load = new Promise<AggregatedMcpSurface>((resolve) =>
			setTimeout(() => resolve(surface(14)), 500),
		);
		const joined = joinAggregateLoad(load, "root", env, "connect", "cold", 100);
		await vi.advanceTimersByTimeAsync(100);
		expect(await joined).toBe(stale);
		expect(json).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(400);
		expect((await load).tools).toHaveLength(14);
	});

	it("returns promptly when the load beats the deadline", async () => {
		vi.useFakeTimers();
		let settled = false;
		const joined = joinAggregateLoad(
			Promise.resolve(surface(7)),
			"key-fast",
			emptyEnv,
			"tedix-unified",
			"joined",
			250,
		).then((result) => {
			settled = true;
			return result;
		});
		// Fake time stands still, so the 250ms deadline timer can never fire —
		// the join settling at all proves the load won the race without
		// waiting out the deadline.
		await vi.advanceTimersByTimeAsync(0);
		expect(settled).toBe(true);
		expect((await joined).tools).toHaveLength(7);
	});

	it("does NOT hang a joined caller for the length of a cold rebuild", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const get = vi.fn().mockResolvedValue(null);
		const env = { AGGREGATE_CACHE: { get } } as never;
		const slow = new Promise<AggregatedMcpSurface>(() => {});
		let settled = false;
		void joinAggregateLoad(
			slow,
			"key-slow",
			env,
			"tedix-unified",
			"joined",
			150,
		).finally(() => {
			settled = true;
		});

		await vi.advanceTimersByTimeAsync(149);
		expect(get).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		// With no cached snapshot anywhere there is nothing better to serve, so the
		// caller still ends up on the load — but it must have hit the deadline and
		// gone looking, not silently blocked on the raw in-flight promise.
		expect(get).toHaveBeenCalledOnce();
		expect(settled).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("never serves an empty surface when nothing is cached", async () => {
		// Serving [] would read as "every tool disappeared", which is worse than
		// being slow — the failure that made Code Mode namespaces vanish before.
		const resolved = await joinAggregateLoad(
			Promise.resolve(surface(0)),
			"key-empty",
			emptyEnv,
			"tedix-unified",
			"cold",
			100,
		);
		expect(resolved.tools).toHaveLength(0);
	});

	it("does not reject when the underlying load fails after the deadline", async () => {
		vi.useFakeTimers();
		// The load owns its own lifecycle; abandoning the wait must not surface as
		// an unhandled rejection in the Worker.
		const failing = new Promise<AggregatedMcpSurface>((_, reject) =>
			setTimeout(() => reject(new Error("upstream gone")), 50),
		);
		const assertion = expect(
			joinAggregateLoad(
				failing,
				"key-fail",
				emptyEnv,
				"tedix-unified",
				"cold",
				500,
			),
		).rejects.toThrow("upstream gone");
		await vi.advanceTimersByTimeAsync(50);
		await assertion;
	});
});
