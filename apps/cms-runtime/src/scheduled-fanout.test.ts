import { afterEach, expect, test, vi } from "vite-plus/test";
import { runScheduledFanout } from "./scheduled-fanout";

afterEach(() => vi.useRealTimers());

test("bounds 70-second handlers and advances in waves with exact counters", async () => {
	vi.useFakeTimers();
	const started: number[] = [];
	let active = 0;
	let peak = 0;
	const errors = vi.fn();
	const fanout = runScheduledFanout(
		Array.from({ length: 12 }, (_, i) => i),
		async (tenant, attempted) => {
			started.push(tenant);
			active++;
			peak = Math.max(peak, active);
			attempted();
			await new Promise((resolve) => setTimeout(resolve, 70_000));
			active--;
			return "succeeded";
		},
		errors,
	);
	expect(started).toEqual([0, 1, 2, 3]);
	await vi.advanceTimersByTimeAsync(69_999);
	expect(started).toHaveLength(4);
	await vi.advanceTimersByTimeAsync(1);
	expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
	await vi.advanceTimersByTimeAsync(140_000);
	expect(await fanout).toEqual({
		attempted: 12,
		succeeded: 12,
		skipped: 0,
		failed: 0,
	});
	expect(peak).toBe(4);
	expect(active).toBe(0);
	expect(new Set(started).size).toBe(12);
	expect(errors).not.toHaveBeenCalled();
});

test("a slow tenant does not block skips, failures or later tenants", async () => {
	vi.useFakeTimers();
	const completed: number[] = [];
	const errors = vi.fn();
	const fanout = runScheduledFanout(
		Array.from({ length: 10 }, (_, i) => i),
		async (tenant, attempted) => {
			if (tenant === 1) return "skipped";
			if (tenant === 2) throw new Error("readiness failed");
			attempted();
			await new Promise((resolve) =>
				setTimeout(resolve, tenant === 0 ? 70_000 : 1_000),
			);
			completed.push(tenant);
			if (tenant === 3) throw new Error("handler failed");
			return "succeeded";
		},
		errors,
	);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(completed).toEqual([3, 4, 5, 6, 7, 8, 9]);
	await vi.advanceTimersByTimeAsync(60_000);
	expect(await fanout).toEqual({
		attempted: 8,
		succeeded: 7,
		skipped: 1,
		failed: 2,
	});
	expect(errors.mock.calls.map(([tenant]) => tenant)).toEqual([2, 3]);
});
