/**
 * A request must never have to survive a cold aggregate rebuild.
 *
 * A full rebuild on the request path can outlast the client's patience. Because
 * every caller joins the single in-flight rebuild, one cold key would stall
 * every concurrent request on the surface, including the CLI's negotiation
 * probe.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { AggregatedMcpSurface } from "./index";
import { joinAggregateLoad } from "./index";
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

function never(): Promise<AggregatedMcpSurface> {
	// Models the 64s rebuild: it resolves eventually, far past any client patience.
	return new Promise((resolve) =>
		setTimeout(() => resolve(surface(2636)), 60_000),
	);
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

	it("returns promptly when the load beats the deadline", async () => {
		const started = Date.now();
		const result = await joinAggregateLoad(
			Promise.resolve(surface(7)),
			"key-fast",
			emptyEnv,
			"tedix-unified",
			"joined",
			250,
		);
		expect(result.tools).toHaveLength(7);
		expect(Date.now() - started).toBeLessThan(200);
	});

	it("does NOT hang a joined caller for the length of a cold rebuild", async () => {
		const slow = never();
		const outcome = await Promise.race([
			joinAggregateLoad(
				slow,
				"key-slow",
				emptyEnv,
				"tedix-unified",
				"joined",
				150,
			)
				.then(() => "returned" as const)
				.catch(() => "returned" as const),
			new Promise<"STILL-WAITING">((r) =>
				setTimeout(() => r("STILL-WAITING"), 2_000),
			),
		]);
		// With no cached snapshot anywhere there is nothing better to serve, so the
		// caller still ends up on the load — but it must have hit the deadline and
		// gone looking, not silently blocked on the raw in-flight promise.
		expect(outcome).toBe("STILL-WAITING");
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
		// The load owns its own lifecycle; abandoning the wait must not surface as
		// an unhandled rejection in the Worker.
		const failing = new Promise<AggregatedMcpSurface>((_, reject) =>
			setTimeout(() => reject(new Error("upstream gone")), 50),
		);
		await expect(
			joinAggregateLoad(
				failing,
				"key-fail",
				emptyEnv,
				"tedix-unified",
				"cold",
				500,
			),
		).rejects.toThrow("upstream gone");
	});
});
