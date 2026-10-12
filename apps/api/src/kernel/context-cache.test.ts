import { describe, expect, it, vi } from "vite-plus/test";
import {
	CONTEXT_CACHE_TTL_MS,
	createCacheTrace,
	invalidateKernelContextCache,
	KernelContextCache,
	STALE_MAX_MS,
} from "./context-cache";

const ORG = "org-1";

function clockedCache(start = 1_000_000) {
	let now = start;
	const cache = new KernelContextCache({ now: () => now });
	return { cache, advance: (ms: number) => (now += ms) };
}

describe("KernelContextCache", () => {
	it("serves a fresh entry without re-running the read and records the hit", async () => {
		const { cache } = clockedCache();
		const read = vi.fn(async () => ["tedi-a"]);
		const first = createCacheTrace();
		const second = createCacheTrace();

		expect(await cache.read(ORG, "tedis", read, first)).toEqual(["tedi-a"]);
		expect(await cache.read(ORG, "tedis", read, second)).toEqual(["tedi-a"]);

		expect(read).toHaveBeenCalledTimes(1);
		expect(first).toEqual({ hits: [], misses: ["tedis"], stale: [] });
		expect(second).toEqual({ hits: ["tedis"], misses: [], stale: [] });
	});

	it("misses once the TTL elapses", async () => {
		const { cache, advance } = clockedCache();
		const read = vi.fn(async () => 1);
		await cache.read(ORG, "apps", read);
		advance(CONTEXT_CACHE_TTL_MS - 1);
		await cache.read(ORG, "apps", read);
		expect(read).toHaveBeenCalledTimes(1);
		advance(2);
		const trace = createCacheTrace();
		await cache.read(ORG, "apps", read, trace);
		expect(read).toHaveBeenCalledTimes(2);
		expect(trace.misses).toEqual(["apps"]);
	});

	it("misses every key of the org after invalidation, and only that org", async () => {
		const { cache } = clockedCache();
		const read = vi.fn(async () => "v");
		await cache.read(ORG, "tedis", read);
		await cache.read(ORG, "apps", read);
		await cache.read("org-2", "tedis", read);
		expect(read).toHaveBeenCalledTimes(3);

		cache.invalidate(ORG);
		const trace = createCacheTrace();
		await cache.read(ORG, "tedis", read, trace);
		await cache.read(ORG, "apps", read, trace);
		await cache.read("org-2", "tedis", read, trace);

		expect(read).toHaveBeenCalledTimes(5);
		expect(trace.misses).toEqual(["tedis", "apps"]);
		expect(trace.hits).toEqual(["tedis"]);
	});

	it("serves the stale value when the fresh read fails inside the stale window", async () => {
		const { cache, advance } = clockedCache();
		const read = vi
			.fn<() => Promise<string[]>>()
			.mockResolvedValueOnce(["roster"])
			.mockRejectedValueOnce(new Error("D1 unavailable"))
			.mockRejectedValueOnce(new Error("D1 unavailable"));
		await cache.read(ORG, "tedis", read);

		advance(CONTEXT_CACHE_TTL_MS + 1);
		const trace = createCacheTrace();
		expect(await cache.read(ORG, "tedis", read, trace)).toEqual(["roster"]);
		expect(trace).toEqual({ hits: [], misses: ["tedis"], stale: ["tedis"] });

		// Past the stale ceiling the error propagates so the caller's own
		// fail-soft fallback applies instead of hour-old configuration.
		advance(STALE_MAX_MS);
		await expect(cache.read(ORG, "tedis", read)).rejects.toThrow(
			"D1 unavailable",
		);
	});

	it("rejects an invalidated value when the re-read fails", async () => {
		const { cache } = clockedCache();
		const read = vi
			.fn<() => Promise<number>>()
			.mockResolvedValueOnce(1)
			.mockRejectedValueOnce(new Error("boom"));
		await cache.read(ORG, "k", read);
		cache.invalidate(ORG);
		const trace = createCacheTrace();
		await expect(cache.read(ORG, "k", read, trace)).rejects.toThrow("boom");
		expect(trace.stale).toEqual([]);
	});

	it("does not cache a failed first read", async () => {
		const { cache } = clockedCache();
		const read = vi
			.fn<() => Promise<number>>()
			.mockRejectedValueOnce(new Error("boom"))
			.mockResolvedValueOnce(2);
		await expect(cache.read(ORG, "k", read)).rejects.toThrow("boom");
		expect(await cache.read(ORG, "k", read)).toBe(2);
		expect(read).toHaveBeenCalledTimes(2);
	});

	it("deduplicates concurrent misses into one read", async () => {
		const { cache } = clockedCache();
		let release!: (value: string) => void;
		const read = vi.fn(
			() =>
				new Promise<string>((resolve) => {
					release = resolve;
				}),
		);
		const a = cache.read(ORG, "k", read);
		const b = cache.read(ORG, "k", read);
		release("once");
		expect(await Promise.all([a, b])).toEqual(["once", "once"]);
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("does not mark a value current when a write landed during the read", async () => {
		const { cache } = clockedCache();
		let release!: (value: string) => void;
		const read = vi
			.fn<() => Promise<string>>()
			.mockImplementationOnce(
				() =>
					new Promise<string>((resolve) => {
						release = resolve;
					}),
			)
			.mockResolvedValueOnce("after-write");
		const pending = cache.read(ORG, "k", read);
		cache.invalidate(ORG);
		release("before-write");
		expect(await pending).toBe("before-write");
		expect(await cache.read(ORG, "k", read)).toBe("after-write");
	});

	it("keeps a completed post-write value when the older read finishes last", async () => {
		const { cache } = clockedCache();
		let releaseOld!: (value: string) => void;
		const old = cache.read(
			ORG,
			"k",
			() => new Promise<string>((resolve) => (releaseOld = resolve)),
		);
		cache.invalidate(ORG);
		const readNew = vi.fn(async () => "after-write");
		expect(await cache.read(ORG, "k", readNew)).toBe("after-write");
		releaseOld("before-write");
		await old;
		const trace = createCacheTrace();
		expect(await cache.read(ORG, "k", readNew, trace)).toBe("after-write");
		expect(readNew).toHaveBeenCalledTimes(1);
		expect(trace.hits).toEqual(["k"]);
	});

	it("deduplicates post-write readers after an older in-flight read finishes", async () => {
		const { cache } = clockedCache();
		let releaseOld!: (value: string) => void;
		let releaseNew!: (value: string) => void;
		const old = cache.read(
			ORG,
			"k",
			() => new Promise<string>((resolve) => (releaseOld = resolve)),
		);
		cache.invalidate(ORG);
		const readNew = vi.fn(
			() => new Promise<string>((resolve) => (releaseNew = resolve)),
		);
		const fresh = cache.read(ORG, "k", readNew);
		releaseOld("before-write");
		await old;
		const concurrent = cache.read(ORG, "k", readNew);
		expect(readNew).toHaveBeenCalledTimes(1);
		releaseNew("after-write");
		expect(await Promise.all([fresh, concurrent])).toEqual([
			"after-write",
			"after-write",
		]);
	});

	it("rejects stale fallback when invalidation lands during a failing refresh", async () => {
		const { cache, advance } = clockedCache();
		await cache.read(ORG, "k", async () => "before-write");
		advance(CONTEXT_CACHE_TTL_MS + 1);
		let rejectRefresh!: (reason: Error) => void;
		const trace = createCacheTrace();
		const pending = cache.read(
			ORG,
			"k",
			() => new Promise<string>((_, reject) => (rejectRefresh = reject)),
			trace,
		);
		cache.invalidate(ORG);
		rejectRefresh(new Error("D1 unavailable"));
		await expect(pending).rejects.toThrow("D1 unavailable");
		expect(trace.stale).toEqual([]);
	});
});

describe("invalidateKernelContextCache", () => {
	it("calls the org KernelDO and keeps the call alive through waitUntil", async () => {
		const invalidateContextCache = vi.fn(async () => undefined);
		const get = vi.fn(() => ({ invalidateContextCache }));
		const idFromName = vi.fn((name: string) => `id:${name}`);
		const waitUntil = vi.fn();

		invalidateKernelContextCache(
			{ env: { KERNEL: { get, idFromName } }, waitUntil },
			ORG,
			"tedi.updated",
		);

		expect(idFromName).toHaveBeenCalledWith(ORG);
		expect(get).toHaveBeenCalledWith(`id:${ORG}`);
		expect(invalidateContextCache).toHaveBeenCalledWith("tedi.updated");
		expect(waitUntil).toHaveBeenCalledTimes(1);
		await waitUntil.mock.calls[0]![0];
	});

	it("is a no-op without the binding and never throws on an RPC failure", async () => {
		expect(() =>
			invalidateKernelContextCache({ env: {} }, ORG, "app.updated"),
		).not.toThrow();

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const waitUntil = vi.fn();
		invalidateKernelContextCache(
			{
				env: {
					KERNEL: {
						idFromName: () => "id",
						get: () => ({
							invalidateContextCache: async () => {
								throw new Error("DO unreachable");
							},
						}),
					},
				},
				waitUntil,
			},
			ORG,
			"app.updated",
		);
		await waitUntil.mock.calls[0]![0];
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ event: "cache_invalidation_failed" }),
		);
		warn.mockRestore();
	});
});
