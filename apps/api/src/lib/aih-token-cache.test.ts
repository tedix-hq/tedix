import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

let cache: typeof import("./aih-token-cache");

const now = 1_000;
const scope = { tediId: "tedi-example", mcpServerId: "server-example" };
const entry = { token: "synthetic-token", expiresAt: now + 10_000 };
const parts = (index = 0) => ({
	...scope,
	clientId: `client-${index}`,
	credentialVersion: "version-1",
	now,
});

beforeEach(async () => {
	vi.resetModules();
	cache = await import("./aih-token-cache");
});

describe("AIH token cache", () => {
	it("evicts the oldest write when more than 100 tuples remain live", () => {
		for (let index = 0; index < 150; index++) {
			cache.setCachedAihToken(parts(index), entry);
		}
		for (let index = 0; index < 150; index++) {
			expect(cache.getCachedAihToken(parts(index)) !== null).toBe(index >= 50);
		}
		expect(cache.clearAihTokenCacheForTediServer(scope)).toBe(100);
	});

	it("overwrites at capacity without evicting another tuple", () => {
		for (let index = 0; index < 100; index++) {
			cache.setCachedAihToken(parts(index), entry);
		}
		const replacement = { ...entry, expiresAt: entry.expiresAt + 1_000 };
		cache.setCachedAihToken(parts(), replacement);
		expect(cache.getCachedAihToken(parts())).toEqual(replacement);
		for (let index = 1; index < 100; index++) {
			expect(cache.getCachedAihToken(parts(index)) !== null).toBe(true);
		}
		cache.setCachedAihToken(parts(100), entry);
		expect(cache.getCachedAihToken(parts(1))).toBeNull();
		expect(cache.getCachedAihToken(parts())).toEqual(replacement);
		expect(cache.clearAihTokenCacheForTediServer(scope)).toBe(100);
	});

	it("does not change eviction order on reads", () => {
		for (let index = 0; index < 100; index++) {
			cache.setCachedAihToken(parts(index), entry);
		}
		expect(cache.getCachedAihToken(parts()) !== null).toBe(true);
		cache.setCachedAihToken(parts(100), entry);
		expect(cache.getCachedAihToken(parts())).toBeNull();
	});

	it("removes entries on reads at the exact expiry boundary", () => {
		cache.setCachedAihToken(parts(), entry);
		expect(
			cache.getCachedAihToken({ ...parts(), now: entry.expiresAt - 1 }) !==
				null,
		).toBe(true);
		expect(
			cache.getCachedAihToken({ ...parts(), now: entry.expiresAt }),
		).toBeNull();
		expect(cache.clearAihTokenCacheForTediServer(scope)).toBe(0);
	});

	it("sweeps mixed expiries before evicting a live entry", () => {
		for (let index = 0; index < 100; index++) {
			cache.setCachedAihToken(parts(index), {
				...entry,
				expiresAt: index % 2 ? now + 1 : entry.expiresAt,
			});
		}
		cache.setCachedAihToken({ ...parts(100), now: now + 1 }, entry);
		expect(cache.getCachedAihToken(parts()) !== null).toBe(true);
		expect(cache.clearAihTokenCacheForTediServer(scope)).toBe(51);
	});

	it("sweeps expired entries even below capacity", () => {
		cache.setCachedAihToken(parts(), { ...entry, expiresAt: now + 1 });
		cache.setCachedAihToken({ ...parts(1), now: now + 1 }, entry);
		expect(cache.clearAihTokenCacheForTediServer(scope)).toBe(1);
	});

	it("does not retain already expired writes or evict live entries for them", () => {
		for (let index = 0; index < 100; index++) {
			cache.setCachedAihToken(parts(index), entry);
		}
		cache.setCachedAihToken(parts(100), { ...entry, expiresAt: now });
		expect(cache.getCachedAihToken(parts()) !== null).toBe(true);
		expect(
			cache.clearAihTokenCacheForTediServer({
				...scope,
				clientId: "client-100",
			}),
		).toBe(0);
		expect(cache.clearAihTokenCacheForTediServer(scope)).toBe(100);
	});

	it("isolates credential versions and clears all versions of one client", () => {
		cache.setCachedAihToken(parts(), entry);
		const next = { ...parts(), credentialVersion: "version-2" };
		expect(cache.getCachedAihToken(next)).toBeNull();
		cache.setCachedAihToken(next, { ...entry, expiresAt: entry.expiresAt + 1 });
		cache.setCachedAihToken(parts(1), entry);
		expect(cache.getCachedAihToken(parts())).toEqual(entry);
		expect(
			cache.clearAihTokenCacheForTediServer({ ...scope, clientId: "client-0" }),
		).toBe(2);
		expect(cache.getCachedAihToken(next)).toBeNull();
		expect(cache.getCachedAihToken(parts(1)) !== null).toBe(true);
	});

	it("preserves the default credential version for omitted and null values", () => {
		cache.setCachedAihToken(
			{ ...parts(), credentialVersion: undefined },
			entry,
		);
		expect(
			cache.getCachedAihToken({ ...parts(), credentialVersion: null }),
		).toEqual(entry);
		expect(cache.getCachedAihToken(parts())).toBeNull();
	});

	it("clears only the exact tedi and server", () => {
		const identities = [
			parts(),
			parts(1),
			{ ...parts(), tediId: "other-tedi" },
			{ ...parts(), mcpServerId: "other-server" },
		];
		for (const identity of identities) cache.setCachedAihToken(identity, entry);
		expect(cache.clearAihTokenCacheForTediServer(scope)).toBe(2);
		for (const identity of identities.slice(2)) {
			expect(cache.getCachedAihToken(identity) !== null).toBe(true);
		}
	});

	it("keeps delimiter-containing identities distinct during lookup and clearing", () => {
		const identities = [
			{ ...parts(), tediId: "a:b", mcpServerId: "c", clientId: "d" },
			{ ...parts(), tediId: "a", mcpServerId: "b:c", clientId: "d" },
			{ ...parts(), tediId: "a", mcpServerId: "b", clientId: "c:d" },
		];
		for (const [index, identity] of identities.entries()) {
			cache.setCachedAihToken(identity, {
				...entry,
				expiresAt: entry.expiresAt + index,
			});
		}
		for (const [index, identity] of identities.entries()) {
			expect(cache.getCachedAihToken(identity)?.expiresAt).toBe(
				entry.expiresAt + index,
			);
		}
		expect(cache.clearAihTokenCacheForTediServer(identities[0])).toBe(1);
		for (const identity of identities.slice(1)) {
			expect(cache.getCachedAihToken(identity) !== null).toBe(true);
		}
	});

	it("treats an empty client id as an exact client scope", () => {
		cache.setCachedAihToken({ ...parts(), clientId: "" }, entry);
		cache.setCachedAihToken(parts(), entry);
		expect(
			cache.clearAihTokenCacheForTediServer({ ...scope, clientId: "" }),
		).toBe(1);
		expect(cache.getCachedAihToken(parts()) !== null).toBe(true);
	});
});
