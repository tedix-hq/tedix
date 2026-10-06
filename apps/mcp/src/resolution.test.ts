import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
	getByDomain: vi.fn(),
	getBySlugWithTools: vi.fn(),
}));

vi.mock("./lib/api-client", () => ({
	getApiClient: () => ({ apps: api }),
}));

import { CACHE_TIER_BUDGET_MS } from "./lib/step-budget";
import {
	purgeAppResolutionCacheKeys,
	resolveAppFromHostname,
} from "./resolution";
import { UPSTREAM_ATTEMPT_TIMEOUT_MS } from "./upstream";
import worker from "./index";

afterEach(() => {
	api.getByDomain.mockReset();
	api.getBySlugWithTools.mockReset();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("resolveAppFromHostname single-flight recovery", () => {
	it("evicts a timed-out resolver so the app can recover without an isolate restart", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		api.getBySlugWithTools.mockImplementation(
			() => new Promise<never>(() => {}),
		);

		const hostname = {
			type: "subdomain" as const,
			appSlug: "wedge-recovery-test",
		};
		const env = {
			API_URL: "https://api.tedix.dev",
			API_SERVICE: {} as Fetcher,
		} as CloudflareEnv;

		const first = resolveAppFromHostname(hostname, env).catch(
			(error: unknown) => error,
		);
		const joined = resolveAppFromHostname(hostname, env).catch(
			(error: unknown) => error,
		);

		await vi.advanceTimersByTimeAsync(UPSTREAM_ATTEMPT_TIMEOUT_MS * 2 + 1_000);
		expect(await first).toBeInstanceOf(Error);
		expect(await joined).toBeInstanceOf(Error);
		// The two callers shared one retry budget rather than creating a herd.
		expect(api.getBySlugWithTools).toHaveBeenCalledTimes(2);

		api.getBySlugWithTools.mockResolvedValue({
			app: {
				id: "app-recovered",
				name: "Recovered",
				slug: hostname.appSlug,
				domain: null,
				organizationId: "org-recovered",
				metadata: null,
			},
			tools: [],
		});

		await expect(resolveAppFromHostname(hostname, env)).resolves.toMatchObject({
			app: { id: "app-recovered", slug: hostname.appSlug },
		});
		expect(api.getBySlugWithTools).toHaveBeenCalledTimes(3);
	});

	/**
	 * The durable L2 read sits at the top of the shared in-flight resolver.
	 * Without a budget, a wedged R2 `get` hangs every request for the app with
	 * no log line at all until the isolate recycles.
	 */
	it("bounds a NEVER-settling durable read: fails open to the live resolve with the diagnosis line", async () => {
		vi.useFakeTimers();
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const slug = "wedged-r2-read-test";
		api.getBySlugWithTools.mockResolvedValue({
			app: { id: "app-live", name: "Live", slug, domain: null },
			tools: [],
		});
		const env = {
			API_URL: "https://api.tedix.dev",
			API_SERVICE: {} as Fetcher,
			AGGREGATE_CACHE: {
				get: () => new Promise<never>(() => {}), // wedged R2
				put: async () => {},
			},
		} as unknown as CloudflareEnv;

		const pending = resolveAppFromHostname(
			{ type: "subdomain" as const, appSlug: slug },
			env,
		);
		// The epoch fence and payload are independent R2 reads; both fail open.
		await vi.advanceTimersByTimeAsync(CACHE_TIER_BUDGET_MS * 2 + 100);
		await expect(pending).resolves.toMatchObject({ app: { id: "app-live" } });
		// The one structured diagnosis line naming the wedged step.
		const line = errorSpy.mock.calls
			.map(([entry]) => entry as Record<string, unknown>)
			.find((entry) => entry?.step === "app_resolution_epoch_read");
		expect(line).toMatchObject({
			component: "mcp.step_budget",
			event: "step_budget.exceeded",
			step: "app_resolution_epoch_read",
			budgetMs: CACHE_TIER_BUDGET_MS,
		});
	});

	it("evicts a resolver poisoned by a wedged R2 AND a wedged upstream, so the next call retries fresh", async () => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const slug = "wedged-r2-and-upstream-test";
		api.getBySlugWithTools.mockImplementation(
			() => new Promise<never>(() => {}),
		);
		const env = {
			API_URL: "https://api.tedix.dev",
			API_SERVICE: {} as Fetcher,
			AGGREGATE_CACHE: {
				get: () => new Promise<never>(() => {}), // wedged R2, reads AND fallback
				put: async () => {},
			},
		} as unknown as CloudflareEnv;
		const hostname = { type: "subdomain" as const, appSlug: slug };

		const first = resolveAppFromHostname(hostname, env).catch(
			(error: unknown) => error,
		);
		// Epoch + L2 + fallback read budgets, plus two upstream attempts: every
		// stage is bounded, so the whole resolver settles.
		await vi.advanceTimersByTimeAsync(
			CACHE_TIER_BUDGET_MS * 3 + UPSTREAM_ATTEMPT_TIMEOUT_MS * 2 + 1_000,
		);
		expect(await first).toBeInstanceOf(Error);

		// The poisoned in-flight entry is gone: a healed upstream serves the app.
		api.getBySlugWithTools.mockResolvedValue({
			app: { id: "app-healed", name: "Healed", slug, domain: null },
			tools: [],
		});
		const second = resolveAppFromHostname(hostname, env);
		await vi.advanceTimersByTimeAsync(CACHE_TIER_BUDGET_MS * 2 + 100);
		await expect(second).resolves.toMatchObject({
			app: { id: "app-healed", slug },
		});
	});
});

/**
 * The durable L2 exists because L1 is an isolate-local Map: every cold isolate
 * in every colo otherwise re-resolves, and resolving the aggregate gateway app
 * means hydrating hundreds of tools out of apps/api. That is on the handshake's
 * critical path: MCP version negotiation resolves the app before it can answer.
 *
 * Each case here is a bug that existed during development, not a hypothetical.
 */
describe("resolveAppFromHostname durable L2", () => {
	// L1 is a module-level Map with a 60s TTL that no hook resets, so each case
	// uses its own slug — otherwise later cases silently read the earlier one's
	// L1 entry and never exercise the durable layer at all.
	let n = 0;
	const nextSlug = () => `durable-l2-${++n}`;
	const resolvedFor = (slug: string) => ({
		app: { id: "a1", name: "Tedix", slug, domain: null },
		tools: [{ id: "t1", toolId: "list_skills" }],
	});
	const keyFor = (slug: string) =>
		`app-resolution/v1/${encodeURIComponent(`mcp-subdomain:${slug}`)}`;
	const epochKeyFor = (slug: string) =>
		`app-resolution-epoch/v1/${encodeURIComponent(`mcp-subdomain:${slug}`)}`;

	function envWithR2(store: Map<string, string>) {
		return {
			API_URL: "https://api.tedix.dev",
			API_SERVICE: {} as Fetcher,
			AGGREGATE_CACHE: {
				get: async (key: string) => {
					const raw = store.get(key);
					return raw ? { json: async () => JSON.parse(raw) } : null;
				},
				put: async (key: string, body: string) => {
					store.set(key, body);
				},
			},
		} as unknown as CloudflareEnv;
	}

	it("keeps the live resolve when the epoch read fails and omits exception content", async () => {
		const slug = nextSlug();
		const failure = new Error("Bearer private-epoch-token", {
			cause: new Error("private epoch object"),
		});
		const env = envWithR2(new Map());
		env.AGGREGATE_CACHE!.get = async () => {
			throw failure;
		};
		api.getBySlugWithTools.mockResolvedValue({
			app: { id: "app-live", name: "Live", slug, domain: null },
			tools: [],
		});
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(
			resolveAppFromHostname({ type: "subdomain", appSlug: slug }, env),
		).resolves.toMatchObject({ app: { id: "app-live" } });
		const event = warnings.mock.calls
			.map(([entry]) => entry)
			.find(
				(entry) =>
					typeof entry === "object" &&
					entry !== null &&
					(entry as { event?: string }).event ===
						"resolution.epoch_read_failed",
			);
		expect(event).toMatchObject({
			component: "mcp.resolution",
			outcome: "unavailable",
			error: "Content omitted",
			exception: {
				type: "Error",
				message: "Content omitted",
				cause: { type: "Error", message: "Content omitted" },
			},
		});
		expect(JSON.stringify(warnings.mock.calls)).not.toContain(
			"private-epoch-token",
		);
		expect(JSON.stringify(warnings.mock.calls)).not.toContain(
			"private epoch object",
		);
	});

	it("keeps the live resolve when durable read and write fail without logging content", async () => {
		const slug = nextSlug();
		const failure = new Error("Bearer private-cache-token", {
			cause: new Error("private cache object"),
		});
		const env = envWithR2(new Map());
		env.AGGREGATE_CACHE!.get = async (key: string) => {
			if (key === epochKeyFor(slug)) return null;
			throw failure;
		};
		env.AGGREGATE_CACHE!.put = async () => {
			throw failure;
		};
		api.getBySlugWithTools.mockResolvedValue({
			app: { id: "app-live", name: "Live", slug, domain: null },
			tools: [],
		});
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});

		await expect(
			resolveAppFromHostname({ type: "subdomain", appSlug: slug }, env),
		).resolves.toMatchObject({ app: { id: "app-live" } });
		for (const eventName of [
			"resolution.cache_read_failed",
			"resolution.cache_write_failed",
		]) {
			const event = warnings.mock.calls
				.map(([entry]) => entry)
				.find(
					(entry) =>
						typeof entry === "object" &&
						entry !== null &&
						(entry as { event?: string }).event === eventName,
				);
			expect(event).toMatchObject({
				component: "mcp.resolution",
				outcome: "unavailable",
				error: "Content omitted",
				exception: {
					type: "Error",
					message: "Content omitted",
					cause: { type: "Error", message: "Content omitted" },
				},
			});
		}
		expect(JSON.stringify(warnings.mock.calls)).not.toContain(
			"private-cache-token",
		);
		expect(JSON.stringify(warnings.mock.calls)).not.toContain(
			"private cache object",
		);
	});

	it("serves a fresh durable entry WITHOUT calling apps/api", async () => {
		const slug = nextSlug();
		const store = new Map<string, string>();
		store.set(
			keyFor(slug),
			JSON.stringify({ cachedAt: Date.now(), app: resolvedFor(slug) }),
		);
		const resolved = await resolveAppFromHostname(
			{ type: "subdomain" as const, appSlug: slug },
			envWithR2(store),
		);
		expect(resolved?.app.slug).toBe(slug);
		// The entire point: a cold isolate pays nothing.
		expect(api.getBySlugWithTools).not.toHaveBeenCalled();
	});

	it("does not rewrite R2 on a durable hit", async () => {
		// Rewriting would reset cachedAt on every read, so the entry would refresh
		// itself forever, apps/api would never be consulted again, and a tool edit
		// could never propagate.
		const slug = nextSlug();
		const store = new Map<string, string>();
		const key = keyFor(slug);
		const original = JSON.stringify({
			cachedAt: Date.now(),
			app: resolvedFor(slug),
		});
		store.set(key, original);
		await resolveAppFromHostname(
			{ type: "subdomain" as const, appSlug: slug },
			envWithR2(store),
		);
		expect(store.get(key)).toBe(original);
	});

	it("bypasses a warm L1 entry when the epoch fence is unavailable", async () => {
		const slug = nextSlug();
		const store = new Map<string, string>();
		let epochReadFails = false;
		const env = envWithR2(store);
		const get = env.AGGREGATE_CACHE!.get.bind(env.AGGREGATE_CACHE);
		env.AGGREGATE_CACHE!.get = async (key: string) => {
			if (epochReadFails && key === epochKeyFor(slug)) {
				throw new Error("epoch unavailable");
			}
			return get(key);
		};
		api.getBySlugWithTools.mockResolvedValueOnce({
			app: { id: "old", name: "Old", slug, domain: null },
			tools: [],
		});
		await resolveAppFromHostname({ type: "subdomain", appSlug: slug }, env);
		epochReadFails = true;
		vi.spyOn(console, "warn").mockImplementation(() => {});
		api.getBySlugWithTools.mockResolvedValueOnce({
			app: { id: "fresh", name: "Fresh", slug, domain: null },
			tools: [],
		});

		await expect(
			resolveAppFromHostname({ type: "subdomain", appSlug: slug }, env),
		).resolves.toMatchObject({ app: { id: "fresh" } });
	});

	it("does not join a resolver from an older epoch", async () => {
		const slug = nextSlug();
		const store = new Map<string, string>([
			[epochKeyFor(slug), JSON.stringify({ epoch: "old" })],
		]);
		let releaseOld!: (value: unknown) => void;
		const oldResult = new Promise((resolve) => {
			releaseOld = resolve;
		});
		api.getBySlugWithTools
			.mockReturnValueOnce(oldResult)
			.mockResolvedValueOnce({
				app: { id: "fresh", name: "Fresh", slug, domain: null },
				tools: [],
			});
		const env = envWithR2(store);
		const old = resolveAppFromHostname(
			{ type: "subdomain", appSlug: slug },
			env,
		);
		await vi.waitFor(() =>
			expect(api.getBySlugWithTools).toHaveBeenCalledTimes(1),
		);
		store.set(epochKeyFor(slug), JSON.stringify({ epoch: "new" }));

		await expect(
			resolveAppFromHostname({ type: "subdomain", appSlug: slug }, env),
		).resolves.toMatchObject({ app: { id: "fresh" } });
		releaseOld({
			app: { id: "old", name: "Old", slug, domain: null },
			tools: [],
		});
		await expect(old).resolves.toMatchObject({ app: { id: "old" } });
	});

	it("falls through to apps/api when the durable entry is past its soft TTL", async () => {
		const slug = nextSlug();
		const store = new Map<string, string>();
		store.set(
			keyFor(slug),
			JSON.stringify({
				cachedAt: Date.now() - 120_000,
				app: resolvedFor(slug),
			}),
		);
		api.getBySlugWithTools.mockResolvedValue({
			app: { id: "a1", name: "Tedix", slug, domain: null },
			tools: [],
		});
		await resolveAppFromHostname(
			{ type: "subdomain" as const, appSlug: slug },
			envWithR2(store),
		);
		expect(api.getBySlugWithTools).toHaveBeenCalledTimes(1);
	});

	it("serves an EXPIRED durable entry when apps/api fails, rather than throwing", async () => {
		// Without this the handshake fails outright and every agent loses the board.
		const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
		const slug = nextSlug();
		const store = new Map<string, string>();
		store.set(
			keyFor(slug),
			JSON.stringify({
				cachedAt: Date.now() - 3_600_000,
				app: resolvedFor(slug),
			}),
		);
		api.getBySlugWithTools.mockRejectedValue(
			new Error("Bearer private-fallback-token", {
				cause: new Error("private fallback object"),
			}),
		);
		const resolved = await resolveAppFromHostname(
			{ type: "subdomain" as const, appSlug: slug },
			envWithR2(store),
		);
		expect(resolved?.app.slug).toBe(slug);
		const event = warnings.mock.calls
			.map(([entry]) => entry)
			.find(
				(entry) =>
					typeof entry === "object" &&
					entry !== null &&
					(entry as { event?: string }).event === "resolution.stale_fallback",
			);
		expect(event).toMatchObject({
			component: "mcp.resolution",
			error: "Content omitted",
			exception: {
				type: "Error",
				message: "Content omitted",
				cause: { type: "Error", message: "Content omitted" },
			},
		});
		expect(JSON.stringify(warnings.mock.calls)).not.toContain(
			"private-fallback-token",
		);
		expect(JSON.stringify(warnings.mock.calls)).not.toContain(
			"private fallback object",
		);
	});

	it("still throws when apps/api fails and nothing is cached", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		api.getBySlugWithTools.mockRejectedValue(new Error("apps/api is down"));
		await expect(
			resolveAppFromHostname(
				{ type: "subdomain" as const, appSlug: "never-cached" },
				envWithR2(new Map()),
			),
		).rejects.toThrow("apps/api is down");
	});

	it("never writes a negative result to the durable cache", async () => {
		// A global "no such app" would hide a newly-created app from every colo.
		const store = new Map<string, string>();
		api.getBySlugWithTools.mockResolvedValue({ app: null, tools: [] });
		await resolveAppFromHostname(
			{ type: "subdomain" as const, appSlug: "missing-app" },
			envWithR2(store),
		);
		expect(store.size).toBe(0);
	});
});

describe("purgeAppResolutionCacheKeys", () => {
	it("deletes exact subdomain and custom-domain entries from L1 and durable R2", async () => {
		const slug = "purge-resolution-test";
		const domain = "mcp.purge-resolution.test";
		const store = new Map<string, string>();
		const deleted: string[][] = [];
		const env = {
			API_URL: "https://api.tedix.dev",
			API_SERVICE: {} as Fetcher,
			AGGREGATE_CACHE: {
				get: async (key: string) => {
					const raw = store.get(key);
					return raw ? { json: async () => JSON.parse(raw) } : null;
				},
				put: async (key: string, body: string) => {
					store.set(key, body);
				},
				delete: async (keys: string[]) => {
					deleted.push(keys);
					for (const key of keys) store.delete(key);
				},
			},
		} as unknown as CloudflareEnv;

		api.getBySlugWithTools.mockResolvedValue({
			app: { id: "app-purge", name: "Purge", slug, domain: null },
			tools: [],
		});
		await resolveAppFromHostname({ type: "subdomain", appSlug: slug }, env);
		expect(api.getBySlugWithTools).toHaveBeenCalledTimes(1);

		const result = await purgeAppResolutionCacheKeys(env, [
			`mcp-subdomain:${slug}`,
			`custom:${domain}`,
			"untrusted:ignored",
		]);
		expect(result).toEqual({ localEntries: 1, r2Deleted: 2 });
		expect(deleted).toEqual([
			[
				`app-resolution/v1/${encodeURIComponent(`mcp-subdomain:${slug}`)}`,
				`app-resolution/v1/${encodeURIComponent(`custom:${domain}`)}`,
			],
		]);
		// A resolver in another isolate can finish after deletion and rewrite its
		// old payload. The epoch fence must keep that late write unreadable.
		store.set(
			`app-resolution/v1/${encodeURIComponent(`mcp-subdomain:${slug}`)}`,
			JSON.stringify({
				cachedAt: Date.now(),
				app: { app: { id: "app-stale", name: "Stale", slug, domain: null } },
			}),
		);

		api.getBySlugWithTools.mockResolvedValue({
			app: { id: "app-fresh", name: "Fresh", slug, domain: null },
			tools: [],
		});
		await expect(
			resolveAppFromHostname({ type: "subdomain", appSlug: slug }, env),
		).resolves.toMatchObject({ app: { id: "app-fresh" } });
		expect(api.getBySlugWithTools).toHaveBeenCalledTimes(2);
	});
});

describe("hostname route resolution failures", () => {
	const env = {
		ENVIRONMENT: "development",
		MCP_URL: "https://mcp.tedix.tech",
		API_URL: "https://api.tedix.tech",
		MCP_UI_URL: "https://mcp-ui.tedix.tech",
		GIT_SHA: "test",
		DEFAULT_APP_SLUG: "",
		DO_NOT_TRACK: "1",
		API_SERVICE: { fetch: vi.fn() },
	} as unknown as CloudflareEnv;
	const ctx = {
		waitUntil: vi.fn(),
		passThroughOnException: vi.fn(),
	} as unknown as ExecutionContext;

	it.each([
		{ label: "nonretryable", status: 502, retryable: false },
		{ label: "retryable", status: 503, retryable: true },
	])(
		"keeps $label exception content out of the response and logs",
		async ({ status, retryable }) => {
			const failure = Object.assign(
				new Error("Bearer private-upstream-token", {
					cause: new Error("private upstream object"),
				}),
				...(retryable ? [{ status: 503 }] : []),
			);
			api.getBySlugWithTools.mockRejectedValue(failure);
			const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			const response = await worker.fetch(
				new Request(`https://route-failure-${status}.mcp.tedix.tech/mcp`),
				env,
				ctx,
			);
			const body = await response.text();
			expect(response.status).toBe(status);
			expect(response.headers.get("Retry-After")).toBe(retryable ? "2" : null);
			expect(body).not.toContain("private-upstream-token");
			expect(body).not.toContain("private upstream object");
			const lines = [...warnings.mock.calls, ...errors.mock.calls];
			const event = lines
				.map(([entry]) => entry)
				.find(
					(entry) =>
						typeof entry === "object" &&
						entry !== null &&
						(entry as { event?: string }).event ===
							(retryable
								? "resolution.route_upstream_unavailable"
								: "resolution.route_lookup_failed"),
				);
			expect(event).toMatchObject({
				component: "mcp.router",
				outcome: "unavailable",
				error: "Content omitted",
				exception: {
					type: "Error",
					message: "Content omitted",
					cause: { type: "Error", message: "Content omitted" },
				},
			});
			expect(JSON.stringify(lines)).not.toContain("private-upstream-token");
			expect(JSON.stringify(lines)).not.toContain("private upstream object");
		},
	);
});
