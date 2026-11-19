import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { IDENTITY_CACHE_TTL_MS, readCachedIdentity } from "./identity-cache";

function fixture() {
	const entries = new Map<string, Response>();
	let version = "member-version-1";
	let role = "owner";
	const cache = {
		match: vi.fn(async (request: RequestInfo | URL) =>
			entries.get((request as Request).url)?.clone(),
		),
		put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
			entries.set((request as Request).url, response.clone());
		}),
	};
	const load = vi.fn(async () => ({ organizationId: "org-one", role }));
	const input = {
		cache,
		origin: "https://api.example.test",
		scope: "org-one:user-one",
		credential: "private-session-token",
		expiresAt: Date.now() + 60_000,
		readVersion: vi.fn(async () => version),
		load,
	};
	return {
		input,
		entries,
		load,
		advance: (nextRole = role) => {
			version += "-next";
			role = nextRole;
		},
	};
}

afterEach(() => vi.useRealTimers());

describe("session identity cache", () => {
	it("loads on miss, hits within the TTL, then reloads after expiry", async () => {
		vi.useFakeTimers();
		const { input, load, entries } = fixture();
		expect((await readCachedIdentity(input)).hit).toBe(false);
		expect((await readCachedIdentity(input)).hit).toBe(true);
		expect(load).toHaveBeenCalledTimes(1);
		expect([...entries.keys()][0]).not.toContain(input.credential);
		vi.advanceTimersByTime(IDENTITY_CACHE_TTL_MS + 1);
		expect((await readCachedIdentity(input)).hit).toBe(false);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("changes roles immediately even when another colo retains the old response", async () => {
		const { input, load, advance, entries } = fixture();
		await readCachedIdentity(input);
		advance("viewer");
		expect(await readCachedIdentity(input)).toEqual({
			hit: false,
			value: { organizationId: "org-one", role: "viewer" },
		});
		expect(entries.size).toBe(2);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("logically evicts all old session entries on sign-out", async () => {
		const { input, load, advance } = fixture();
		await readCachedIdentity(input);
		await readCachedIdentity(input);
		advance();
		await readCachedIdentity(input);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("isolates organizations, sessions, subjects and origins", async () => {
		const { input, load } = fixture();
		await readCachedIdentity(input);
		await readCachedIdentity({ ...input, scope: "org-two:user-one" });
		await readCachedIdentity({ ...input, scope: "org-one:user-two" });
		await readCachedIdentity({ ...input, credential: "other-session" });
		await readCachedIdentity({
			...input,
			origin: "https://other.example.test",
		});
		expect(load).toHaveBeenCalledTimes(5);
	});

	it("does not fill a cache across a concurrent membership mutation", async () => {
		const { input, advance } = fixture();
		input.load.mockImplementationOnce(async () => {
			advance("viewer");
			return { organizationId: "org-one", role: "owner" };
		});
		await readCachedIdentity(input);
		expect(input.cache.put).not.toHaveBeenCalled();
		expect((await readCachedIdentity(input)).value.role).toBe("viewer");
	});

	it("caps entries at credential and OIDC session expiry", async () => {
		vi.useFakeTimers();
		const { input, load } = fixture();
		const expiry = Date.now() + 1000;
		const expiring = { ...input, expiresAt: expiry };
		await readCachedIdentity(expiring);
		vi.advanceTimersByTime(1001);
		expect((await readCachedIdentity(expiring)).hit).toBe(false);
		expect(load).toHaveBeenCalledTimes(2);
		const oidc = { ...input, valueExpiresAt: () => Date.now() - 1 };
		await readCachedIdentity(oidc);
		await readCachedIdentity(oidc);
		expect(load).toHaveBeenCalledTimes(4);
	});

	it("requires a live fence and tolerates unavailable cache storage", async () => {
		const { input, load } = fixture();
		input.readVersion.mockRejectedValueOnce(new Error("primary unavailable"));
		await expect(readCachedIdentity(input)).rejects.toThrow(
			"primary unavailable",
		);
		expect(load).not.toHaveBeenCalled();
		input.cache.match.mockRejectedValueOnce(new Error("cache unavailable"));
		input.cache.put.mockRejectedValueOnce(new Error("cache unavailable"));
		expect((await readCachedIdentity(input)).hit).toBe(false);
	});
});
