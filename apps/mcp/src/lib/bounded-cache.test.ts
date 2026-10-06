import { describe, expect, it } from "vite-plus/test";
import {
	pruneExpiredCacheEntries,
	setBoundedExpiringCacheEntry,
	setBoundedCacheEntry,
} from "./bounded-cache";

describe("setBoundedCacheEntry", () => {
	it("evicts the oldest entry at the configured bound", () => {
		const cache = new Map<string, number>();
		setBoundedCacheEntry(cache, "first", 1, 2);
		setBoundedCacheEntry(cache, "second", 2, 2);
		setBoundedCacheEntry(cache, "third", 3, 2);
		expect([...cache.entries()]).toEqual([
			["second", 2],
			["third", 3],
		]);
	});

	it("refreshes a replacement instead of evicting it next", () => {
		const cache = new Map<string, number>([
			["first", 1],
			["second", 2],
		]);
		setBoundedCacheEntry(cache, "first", 10, 2);
		setBoundedCacheEntry(cache, "third", 3, 2);
		expect([...cache.entries()]).toEqual([
			["first", 10],
			["third", 3],
		]);
	});

	it("rejects invalid bounds", () => {
		expect(() => setBoundedCacheEntry(new Map(), "key", 1, 0)).toThrow(
			RangeError,
		);
	});
});

describe("expiring bounded schema caches", () => {
	it("drops expired values even when their keys are never read again", () => {
		const cache = new Map([
			[
				"old-epoch",
				{ expiresAt: 100, result: { tools: [{ schema: "retained" }] } },
			],
			["live-epoch", { expiresAt: 101, result: { tools: [] } }],
		]);
		pruneExpiredCacheEntries(cache, 100);
		expect([...cache.keys()]).toEqual(["live-epoch"]);
	});
	it("prunes expired subsets on insertion without evicting a live surface", () => {
		const now = Date.now();
		const cache = new Map([
			["live", { expiresAt: now + 120000, result: { tools: [] } }],
			["expired", { expiresAt: now - 1, result: { tools: [] } }],
		]);
		setBoundedExpiringCacheEntry(
			cache,
			"new",
			{ expiresAt: now + 120000, result: { tools: [] } },
			2,
		);
		expect([...cache.keys()]).toEqual(["live", "new"]);
	});
	it.each([8, 64])(
		"bounds distinct subset/epoch churn to %s retained entries",
		(bound) => {
			const cache = new Map<
				string,
				{ expiresAt: number; result: { tools: unknown[] } }
			>();
			for (let epoch = 0; epoch < 1000; epoch++) {
				setBoundedExpiringCacheEntry(
					cache,
					`epoch-${epoch}/subset-${epoch % 7}`,
					{ expiresAt: Date.now() + 120000, result: { tools: [{ epoch }] } },
					bound,
				);
				expect(cache.size).toBeLessThanOrEqual(bound);
			}
			expect(cache.size).toBe(bound);
			expect([...cache.keys()][0]).toBe(
				`epoch-${1000 - bound}/subset-${(1000 - bound) % 7}`,
			);
		},
	);
});
