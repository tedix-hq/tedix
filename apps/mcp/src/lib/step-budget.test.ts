/**
 * Unbudgeted awaits on the surface build path — some inside shared in-flight
 * dedupe promises that are only evicted on settle — hang tools/list silently.
 * Every such await gets a budget with one structured diagnosis line, and a
 * wedged shared promise is evicted so the next request retries fresh.
 */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	StepBudgetExceededError,
	joinInFlightLoad,
	trackInFlightLoad,
	withStepBudget,
} from "./step-budget";

function lastErrorLine(spy: ReturnType<typeof vi.spyOn>): unknown {
	const call = spy.mock.calls.at(-1);
	return call?.[0];
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("withStepBudget", () => {
	it("passes a fast result through untouched", async () => {
		await expect(
			withStepBudget("fast_step", 1_000, Promise.resolve(42)),
		).resolves.toBe(42);
	});

	it("fails a never-settling await within the budget and emits the diagnosis line", async () => {
		vi.useFakeTimers();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const wedged = withStepBudget(
			"wedged_step",
			2_500,
			new Promise<never>(() => {}),
			"acme-unified",
		).catch((error: unknown) => error);

		await vi.advanceTimersByTimeAsync(2_501);
		const outcome = await wedged;
		expect(outcome).toBeInstanceOf(StepBudgetExceededError);
		expect((outcome as StepBudgetExceededError).step).toBe("wedged_step");
		// The one structured error event naming the wedged step.
		expect(lastErrorLine(errorSpy)).toMatchObject({
			component: "mcp.step_budget",
			event: "step_budget.exceeded",
			step: "wedged_step",
			resourceKey: "acme-unified",
			budgetMs: 2_500,
			exception: { type: "StepBudgetExceededError" },
		});
	});

	it("does not surface the abandoned promise's late rejection as unhandled", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		let rejectLate: ((error: Error) => void) | undefined;
		const late = new Promise<never>((_, reject) => {
			rejectLate = reject;
		});
		const outcome = withStepBudget("late_step", 100, late).catch(
			(error: unknown) => error,
		);
		await vi.advanceTimersByTimeAsync(101);
		expect(await outcome).toBeInstanceOf(StepBudgetExceededError);
		rejectLate?.(new Error("late failure"));
		await vi.advanceTimersByTimeAsync(1);
	});
});

describe("trackInFlightLoad", () => {
	it("evicts on settle so dedupe keeps working", async () => {
		const map = new Map<string, Promise<string>>();
		const load = Promise.resolve("done");
		trackInFlightLoad(map, "key", load, {
			step: "settle_step",
			wedgeEvictMs: 60_000,
		});
		expect(map.get("key")).toBe(load);
		await load;
		// Settlement handlers run on the microtask queue.
		await Promise.resolve();
		await Promise.resolve();
		expect(map.has("key")).toBe(false);
	});

	it("evicts a NEVER-settling load at the wedge bound with the diagnosis line, so the next request retries fresh", async () => {
		vi.useFakeTimers();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const map = new Map<string, Promise<string>>();
		const wedged = new Promise<string>(() => {});
		trackInFlightLoad(map, "key", wedged, {
			step: "wedged_load",
			wedgeEvictMs: 30_000,
			resource: "acme-unified",
		});
		expect(map.get("key")).toBe(wedged);

		await vi.advanceTimersByTimeAsync(30_001);
		// The poisoned entry is gone — a new request builds fresh instead of
		// joining the wedged promise until isolate recycle.
		expect(map.has("key")).toBe(false);
		expect(lastErrorLine(errorSpy)).toMatchObject({
			component: "mcp.step_budget",
			event: "step_budget.exceeded",
			step: "wedged_load",
			resourceKey: "acme-unified",
			budgetMs: 30_000,
		});
	});

	it("does not evict a REPLACEMENT load when the wedged one's timer fires", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const map = new Map<string, Promise<string>>();
		const wedged = new Promise<string>(() => {});
		trackInFlightLoad(map, "key", wedged, {
			step: "wedged_load",
			wedgeEvictMs: 1_000,
		});
		await vi.advanceTimersByTimeAsync(1_001);
		expect(map.has("key")).toBe(false);

		// A fresh load registered after eviction must not be clobbered by any
		// leftover state from the wedged one.
		const fresh = new Promise<string>(() => {});
		trackInFlightLoad(map, "key", fresh, {
			step: "fresh_load",
			wedgeEvictMs: 60_000,
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(map.get("key")).toBe(fresh);
	});

	it("swallows a rejected load's rejection while still evicting", async () => {
		const map = new Map<string, Promise<string>>();
		const failing = Promise.reject(new Error("load failed"));
		// The caller separately awaits the load; here nobody does — registration
		// alone must not produce an unhandled rejection.
		failing.catch(() => {});
		trackInFlightLoad(map, "key", failing, {
			step: "failing_load",
			wedgeEvictMs: 60_000,
		});
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		expect(map.has("key")).toBe(false);
	});
});

describe("joinInFlightLoad", () => {
	it("releases existing waiters even if the originating request watchdog never runs", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const load = new Promise<string>(() => {});
		const map = new Map([["key", load]]);
		const first = joinInFlightLoad(map, "key", load, {
			step: "join",
			budgetMs: 100,
		});
		const second = joinInFlightLoad(map, "key", load, {
			step: "join",
			budgetMs: 100,
		});
		const results = Promise.allSettled([first, second]);
		await vi.advanceTimersByTimeAsync(100);
		for (const result of await results) {
			expect(result.status).toBe("rejected");
			if (result.status === "rejected")
				expect(result.reason).toBeInstanceOf(StepBudgetExceededError);
		}
		expect(map.has("key")).toBe(false);
		const fresh = Promise.resolve("recovered");
		map.set("key", fresh);
		await expect(
			joinInFlightLoad(map, "key", fresh, { step: "join", budgetMs: 100 }),
		).resolves.toBe("recovered");
	});

	it("does not evict a replacement when an older waiter times out", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const load = new Promise<string>(() => {});
		const map = new Map([["key", load]]);
		const joined = joinInFlightLoad(map, "key", load, {
			step: "join",
			budgetMs: 100,
		});
		const result = Promise.allSettled([joined]);
		const replacement = Promise.resolve("fresh");
		map.set("key", replacement);
		await vi.advanceTimersByTimeAsync(100);
		expect((await result)[0]?.status).toBe("rejected");
		expect(map.get("key")).toBe(replacement);
	});

	it("preserves the underlying rejection and clears the caller timer", async () => {
		vi.useFakeTimers();
		const error = new Error("not authorized");
		const load = Promise.reject(error);
		const map = new Map([["key", load]]);
		await expect(
			joinInFlightLoad(map, "key", load, { step: "join", budgetMs: 100 }),
		).rejects.toBe(error);
		expect(vi.getTimerCount()).toBe(0);
	});
});
