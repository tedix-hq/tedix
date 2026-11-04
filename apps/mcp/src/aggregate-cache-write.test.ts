/**
 * A snapshot write slower than its cache-tier budget must stop blocking the
 * request but still finish: before this, the budget released the await and the
 * Worker dropped the unfinished put, so the catalog was never cached and every
 * isolate rebuilt it from D1 at the same time.
 */
import { afterEach, expect, it, vi } from "vite-plus/test";
import { writeAggregateR2 } from "./aggregate-surface-cache";
import { CACHE_TIER_BUDGET_MS } from "./lib/step-budget";

afterEach(() => vi.useRealTimers());

it("keeps a slow R2 snapshot write alive past the request budget", async () => {
	vi.useFakeTimers();
	let finish!: () => void;
	const put = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finish = resolve;
			}),
	);
	const kept: Promise<unknown>[] = [];
	const ctx = { waitUntil: (promise: Promise<unknown>) => kept.push(promise) };
	const env = { AGGREGATE_CACHE: { put } } as unknown as CloudflareEnv;

	const write = writeAggregateR2(
		env,
		"example-key",
		{ body: "{}", cachedAt: 1, generation: "g1" },
		"example-app",
		0,
		ctx,
	);
	await vi.advanceTimersByTimeAsync(CACHE_TIER_BUDGET_MS + 1);
	await write;

	expect(put).toHaveBeenCalledOnce();
	expect(kept).toHaveLength(1);
	let settled = false;
	void kept[0]!.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	finish();
	await kept[0];
	expect(settled).toBe(true);
});
