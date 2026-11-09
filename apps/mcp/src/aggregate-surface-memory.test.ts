/**
 * Root aggregate snapshots serialize to ~25 MB on connect. On 2026-10-27 the
 * connect gateway hit `exceededMemory` (Cloudflare 1102) because every busy
 * isolate re-parsed its root snapshot each time the 120s L1 entry expired,
 * found the snapshot it had written itself stale, rebuilt the root again next
 * to the copy it was serving, and serialized it once per durable tier. These
 * tests pin the memory-bounding behavior of that cycle.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type { AggregateAppEntry } from "./aggregate-types";

const { resolveUpstreamToolsInternally } = vi.hoisted(() => ({
	resolveUpstreamToolsInternally: vi.fn(),
}));

vi.mock("./aggregate-internal-tools", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("./aggregate-internal-tools")>();
	return { ...actual, resolveUpstreamToolsInternally };
});
vi.mock("./aggregate-prefetch", () => ({
	prefetchAggregateEntries: vi.fn(async () => undefined),
}));

import { toInternalResolveResult } from "./aggregate-internal-tools";
import { aggregateAndPrefixTools } from "./aggregate-surface";
import {
	AGGREGATE_SURFACE_CACHE_TTL_MS,
	aggregateRevalidateInFlight,
	aggregateSurfaceCache,
	aggregateSurfaceInFlight,
	aggregateSurfaceCacheKey,
	aggregateSurfaceRetainedRows,
	MAX_AGGREGATE_SURFACE_RETAINED_ROWS,
	readAggregateL2,
} from "./aggregate-surface-cache";
import { CACHE_TIER_BUDGET_MS } from "./lib/step-budget";
import {
	DISCOVERY_SHARD_STALE_AFTER_MS,
	discoveryShardCache,
	discoveryShardRefreshInFlight,
	loadDiscoveryShards,
	loadDiscoveryToolDefinition,
	refreshDiscoveryShard,
} from "./aggregate-discovery-shards";

type StoredResponse = { body: string; headers: [string, string][] };

/** Workers Cache API stand-in that counts snapshot body reads. */
function createColoCache() {
	const store = new Map<string, StoredResponse>();
	const bodyReads = { count: 0 };
	const cache = {
		match: vi.fn(async (request: Request) => {
			const stored = store.get(request.url);
			if (!stored) return undefined;
			const response = new Response(stored.body, { headers: stored.headers });
			const json = response.json.bind(response);
			response.json = async () => {
				bodyReads.count++;
				return json();
			};
			return response;
		}),
		put: vi.fn(async (request: Request, response: Response) => {
			store.set(request.url, {
				body: await response.text(),
				headers: [...response.headers.entries()],
			});
		}),
		delete: vi.fn(async (request: Request) => store.delete(request.url)),
	};
	return { cache, store, bodyReads };
}

function createR2() {
	const objects = new Map<
		string,
		{ body: string; customMetadata?: Record<string, string> }
	>();
	return {
		objects,
		bucket: {
			get: vi.fn(async (key: string) => {
				const object = objects.get(key);
				if (!object) return null;
				const response = new Response(object.body);
				return {
					customMetadata: object.customMetadata,
					body: response.body,
					json: () => response.json(),
				};
			}),
			head: vi.fn(async (key: string) => {
				const object = objects.get(key);
				return object ? { customMetadata: object.customMetadata } : null;
			}),
			put: vi.fn(
				async (
					key: string,
					body: string,
					options?: { customMetadata?: Record<string, string> },
				) => {
					objects.set(key, { body, customMetadata: options?.customMetadata });
				},
			),
		},
	};
}

function sourceApp(toolIds: string[]) {
	return toInternalResolveResult("source", {
		app: {
			id: "source-app",
			slug: "source",
			organizationId: "org-test",
			metadata: null,
		},
		tools: toolIds.map((toolId) => ({
			id: `row-${toolId}`,
			toolId,
			title: toolId,
			toolTypeId: "rpc",
			enabled: true,
			inputSchema: {
				type: "object",
				properties: { id: { type: "string" } },
			},
			config: { endpoint: "apps/get" },
		})),
		catalogResources: [],
		catalogResourceTemplates: [],
	} as never);
}

const entries: AggregateAppEntry[] = [{ slug: "source" }];
const activation = { value: "epoch-memory", cacheable: true };

describe("aggregate snapshot memory", () => {
	let colo: ReturnType<typeof createColoCache>;
	let r2: ReturnType<typeof createR2>;
	let env: CloudflareEnv;
	let pending: Promise<unknown>[];
	let ctx: ExecutionContext;

	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-27T08:00:00Z"));
		aggregateSurfaceCache.clear();
		aggregateSurfaceInFlight.clear();
		aggregateRevalidateInFlight.clear();
		discoveryShardCache.clear();
		resolveUpstreamToolsInternally.mockReset();
		resolveUpstreamToolsInternally.mockImplementation(async () =>
			sourceApp(["read_item", "list_items"]),
		);
		colo = createColoCache();
		r2 = createR2();
		vi.stubGlobal("caches", { default: colo.cache });
		env = {
			GIT_SHA: `memory-${crypto.randomUUID()}`,
			AGGREGATE_CACHE: r2.bucket,
		} as unknown as CloudflareEnv;
		pending = [];
		ctx = {
			waitUntil: (promise: Promise<unknown>) => {
				pending.push(promise);
			},
		} as unknown as ExecutionContext;
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	const load = () =>
		aggregateAndPrefixTools(
			entries,
			env,
			new Set(),
			ctx,
			"connect",
			activation,
		);
	const settleBackground = async () => {
		while (pending.length) await Promise.all(pending.splice(0));
	};

	it("writes one serialization to both durable tiers", async () => {
		const stringify = vi.spyOn(JSON, "stringify");
		const surface = await load();
		const surfaceSerializations = stringify.mock.calls.filter(
			([value]) => value === surface,
		);
		expect(surfaceSerializations).toHaveLength(1);

		const [l2] = [...colo.store.entries()].filter(
			([url]) => !url.includes("revalidation-lease"),
		);
		const [r2Object] = [...r2.objects.values()];
		expect(l2?.[1].body).toBe(r2Object?.body);
		const generation = new Headers(l2?.[1].headers).get(
			"X-Tedix-Aggregate-Generation",
		);
		expect(generation).toBeTruthy();
		expect(r2Object?.customMetadata?.generation).toBe(generation);
	});

	it("shares nine cold loads and promotes original R2 bytes without reserialization", async () => {
		await load();
		aggregateSurfaceCache.clear();
		colo.store.clear();
		r2.bucket.get.mockClear();
		const stored = [...r2.objects.values()][0]!;
		stored.body = `  ${stored.body}\n`;
		const stringify = vi.spyOn(JSON, "stringify");
		const results = await Promise.all(Array.from({ length: 9 }, load));
		expect(results.every((surface) => surface === results[0])).toBe(true);
		expect(r2.bucket.get).toHaveBeenCalledTimes(1);
		expect(
			stringify.mock.calls.filter(([value]) => value === results[0]),
		).toHaveLength(0);
		const promoted = [...colo.store.values()][0]!;
		expect(promoted.body).toBe(stored.body);
		const headers = new Headers(promoted.headers);
		expect(headers.get("X-Tedix-Aggregate-Generation")).toBe(
			stored.customMetadata?.generation,
		);
		expect(headers.get("Cache-Control")).toBe("max-age=600");
		expect(headers.get("X-Tedix-Aggregate-Cached-At")).toBe(String(Date.now()));
	});

	it.each(["l2", "r2"])(
		"reuses %s after a Worker deploy without live fan-out",
		async (tier) => {
			env.WORKER_VERSION = {
				id: "deploy-before",
			} as CloudflareEnv["WORKER_VERSION"];
			const first = await load();
			// The cold build keeps its snapshot writes alive; only the reuse
			// after the deploy must schedule no background work.
			await Promise.all(pending);
			pending.length = 0;
			aggregateSurfaceCache.clear();
			aggregateSurfaceInFlight.clear();
			if (tier === "r2") colo.store.clear();
			env.WORKER_VERSION = {
				id: "deploy-after",
			} as CloudflareEnv["WORKER_VERSION"];
			env.GIT_SHA = "another-source-commit";
			const second = await load();
			expect(second).toEqual(first);
			expect(resolveUpstreamToolsInternally).toHaveBeenCalledTimes(1);
			expect(pending).toHaveLength(0);
		},
	);

	it.each(["cold", "joined"])(
		"does not retry R2 at a nested %s join deadline",
		async (kind) => {
			vi.useFakeTimers();
			const visited = new Set(["parent-gateway"]);
			const key = aggregateSurfaceCacheKey(
				entries,
				undefined,
				activation.value,
				visited,
			);
			if (kind === "joined") {
				aggregateSurfaceInFlight.set(
					key,
					new Promise((resolve) =>
						setTimeout(
							() =>
								resolve({
									tools: [],
									resources: [],
									resourceTemplates: [],
									prompts: [],
								}),
							9_000,
						),
					),
				);
			} else {
				resolveUpstreamToolsInternally.mockImplementation(
					() =>
						new Promise((resolve) =>
							setTimeout(() => resolve(sourceApp(["read_item"])), 9_000),
						),
				);
			}
			const result = aggregateAndPrefixTools(
				entries,
				env,
				visited,
				ctx,
				undefined,
				activation,
			);
			await vi.advanceTimersByTimeAsync(8_001);
			expect(r2.bucket.get).toHaveBeenCalledTimes(kind === "cold" ? 1 : 0);
			await vi.advanceTimersByTimeAsync(1_000);
			expect((await result).degraded).not.toBe(true);
		},
	);

	it("rebuilds changed tool contracts after activation even across deploys", async () => {
		await load();
		aggregateSurfaceCache.clear();
		aggregateSurfaceInFlight.clear();
		env.WORKER_VERSION = {
			id: "deploy-after",
		} as CloudflareEnv["WORKER_VERSION"];
		resolveUpstreamToolsInternally.mockImplementation(async () =>
			sourceApp(["new_contract"]),
		);
		const changed = await aggregateAndPrefixTools(
			entries,
			env,
			new Set(),
			ctx,
			"connect",
			{
				value: "epoch-new-contract",
				cacheable: true,
			},
		);
		expect(changed.tools.map((tool) => tool.toolId)).toEqual([
			"source__new_contract",
		]);
		expect(resolveUpstreamToolsInternally).toHaveBeenCalledTimes(2);
	});

	it("reuses the served object instead of re-parsing an unchanged snapshot", async () => {
		const first = await load();
		expect(resolveUpstreamToolsInternally).toHaveBeenCalledTimes(1);

		// L1 expired, so the next request reads the colo snapshot, which is now
		// stale and triggers one background revalidation.
		vi.setSystemTime(Date.now() + AGGREGATE_SURFACE_CACHE_TTL_MS + 1_000);
		aggregateSurfaceInFlight.clear();
		const second = await load();
		expect(second).toBe(first);
		expect(colo.bodyReads.count).toBe(0);

		await settleBackground();
		expect(resolveUpstreamToolsInternally).toHaveBeenCalledTimes(2);
		// The rebuild produced the same snapshot, so the isolate keeps serving the
		// object its catalog projections are keyed by.
		const third = await load();
		expect(third).toBe(first);
	});

	it("parses a snapshot whose generation changed", async () => {
		const first = await load();
		vi.setSystemTime(Date.now() + AGGREGATE_SURFACE_CACHE_TTL_MS + 1_000);
		aggregateSurfaceInFlight.clear();
		resolveUpstreamToolsInternally.mockImplementation(async () =>
			sourceApp(["read_item", "list_items", "create_item"]),
		);
		await load();
		await settleBackground();

		// Another isolate's rebuild would land the same way: a new generation.
		aggregateSurfaceCache.clear();
		const changed = await load();
		expect(changed).not.toBe(first);
		expect(changed.tools.map((tool) => tool.toolId)).toContain(
			"source__create_item",
		);
		expect(colo.bodyReads.count).toBe(1);
	});

	it("lets one isolate per colo revalidate a stale snapshot", async () => {
		await load();
		vi.setSystemTime(Date.now() + AGGREGATE_SURFACE_CACHE_TTL_MS + 1_000);

		let finishRebuild: () => void = () => {};
		resolveUpstreamToolsInternally.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishRebuild = () => resolve(sourceApp(["read_item", "list_items"]));
				}),
		);

		// Two isolates whose L1 entries expired while the first rebuild runs.
		for (let isolate = 0; isolate < 2; isolate++) {
			aggregateSurfaceCache.clear();
			aggregateSurfaceInFlight.clear();
			aggregateRevalidateInFlight.clear();
			await load();
			for (let tick = 0; tick < 20; tick++) await Promise.resolve();
		}
		finishRebuild();
		await settleBackground();
		expect(resolveUpstreamToolsInternally).toHaveBeenCalledTimes(2);
	});

	it("runs at most one background rebuild per isolate", async () => {
		const other: AggregateAppEntry[] = [{ slug: "source", prefix: "other" }];
		const loadOther = () =>
			aggregateAndPrefixTools(other, env, new Set(), ctx, "other", activation);
		await load();
		await loadOther();
		vi.setSystemTime(Date.now() + AGGREGATE_SURFACE_CACHE_TTL_MS + 1_000);

		let finishRebuild: () => void = () => {};
		resolveUpstreamToolsInternally.mockImplementation(
			() =>
				new Promise((resolve) => {
					finishRebuild = () => resolve(sourceApp(["read_item", "list_items"]));
				}),
		);
		const before = resolveUpstreamToolsInternally.mock.calls.length;
		// Both keys are stale; the second must not start a rebuild while the
		// first one still holds its fresh graph.
		await load();
		for (let tick = 0; tick < 20; tick++) await Promise.resolve();
		await loadOther();
		for (let tick = 0; tick < 20; tick++) await Promise.resolve();
		finishRebuild();
		await settleBackground();
		expect(resolveUpstreamToolsInternally.mock.calls.length - before).toBe(1);
	});

	it("keeps a consent-composed root's organization graphs in memory", async () => {
		resolveUpstreamToolsInternally.mockImplementation(
			async (source: AggregateAppEntry) =>
				source.slug === "org-gateway"
					? toInternalResolveResult("org-gateway", {
							app: {
								id: "org-gateway-app",
								slug: "org-gateway",
								organizationId: "org-test",
								metadata: {
									mcpConfig: { aggregateApps: [{ slug: "source" }] },
								},
							},
							tools: [],
							catalogResources: [],
							catalogResourceTemplates: [],
						} as never)
					: sourceApp(["read_item", "list_items"]),
		);
		const organizationEntries: AggregateAppEntry[] = [
			{
				slug: "org-gateway",
				prefix: "org-gateway",
				organizationId: "org-test",
				organizationMount: true,
			},
		];
		// Connect's multi-organization root is never snapshotted (`cacheSnapshot`
		// false), so it is recomposed from its organization graphs per request.
		const loadTransient = () =>
			aggregateAndPrefixTools(
				organizationEntries,
				env,
				new Set(),
				ctx,
				"connect",
				activation,
				false,
			);
		const first = await loadTransient();
		expect(first.tools).toHaveLength(2);
		// The root resolves its own entries every request (the internal tool
		// cache absorbs that in production); the organization graph is reused.
		const sourceResolves = () =>
			resolveUpstreamToolsInternally.mock.calls.filter(
				([source]) => (source as AggregateAppEntry).slug === "source",
			).length;
		const resolves = sourceResolves();
		colo.cache.match.mockClear();

		const second = await loadTransient();
		expect(second.tools).toHaveLength(first.tools.length);
		expect(sourceResolves()).toBe(resolves);
		expect(colo.cache.match).not.toHaveBeenCalled();

		// After L1 expiry the unchanged organization snapshot is recognized by
		// its generation instead of being parsed again.
		vi.setSystemTime(Date.now() + AGGREGATE_SURFACE_CACHE_TTL_MS + 1_000);
		await loadTransient();
		expect(colo.bodyReads.count).toBe(0);
	});

	it("releases the least recently used organization graph once retained rows exceed the budget", async () => {
		// Two graphs fit the budget; a third does not.
		const rowsPerGraph =
			Math.floor(MAX_AGGREGATE_SURFACE_RETAINED_ROWS / 3) + 1;
		const toolIds = Array.from({ length: rowsPerGraph }, (_, i) => `tool_${i}`);
		resolveUpstreamToolsInternally.mockImplementation(
			async (source: AggregateAppEntry) =>
				source.slug.startsWith("org-")
					? toInternalResolveResult(source.slug, {
							app: {
								id: `${source.slug}-app`,
								slug: source.slug,
								organizationId: source.slug,
								metadata: {
									mcpConfig: { aggregateApps: [{ slug: "source" }] },
								},
							},
							tools: [],
							catalogResources: [],
							catalogResourceTemplates: [],
						} as never)
					: sourceApp(toolIds),
		);
		const mount = (slug: string): AggregateAppEntry => ({
			slug,
			prefix: slug,
			organizationId: slug,
			organizationMount: true,
		});
		const loadOrg = (slug: string) =>
			aggregateAndPrefixTools(
				[mount(slug)],
				env,
				new Set(),
				ctx,
				"connect",
				activation,
				false,
			);
		await loadOrg("org-a");
		await loadOrg("org-b");
		expect(aggregateSurfaceRetainedRows()).toBe(rowsPerGraph * 2);
		// Reading org-a again marks it recently used, so org-b goes first.
		await loadOrg("org-a");
		await loadOrg("org-c");
		expect(aggregateSurfaceRetainedRows()).toBe(rowsPerGraph * 2);
		// Retained graphs are the organization gateways' nested source graphs,
		// keyed by the mount they were visited through.
		const retainedMounts = [...aggregateSurfaceCache.keys()].map(
			(key) => JSON.parse(key).visited[0],
		);
		expect(retainedMounts).toEqual(["org-a", "org-c"]);
	});

	describe("discovery shards", () => {
		// Above CATALOG_SCHEMA_SEARCH_MAX_ROWS, so ranking never reads schemas.
		const manyTools = Array.from({ length: 4_001 }, (_, i) => `read_item_${i}`);
		const organizations = ["acme-unified", "globex-unified"];
		const mounts: AggregateAppEntry[] = organizations.map((slug) => ({
			slug,
			prefix: slug,
			organizationId: `org-${slug}`,
			organizationMount: true,
		}));
		beforeEach(() => {
			resolveUpstreamToolsInternally.mockImplementation(
				async (source: AggregateAppEntry) =>
					organizations.includes(source.slug)
						? toInternalResolveResult(source.slug, {
								app: {
									id: `${source.slug}-app`,
									slug: source.slug,
									organizationId: `org-${source.slug}`,
									metadata: {
										mcpConfig: { aggregateApps: [{ slug: "source" }] },
									},
								},
								tools: [],
								catalogResources: [],
								catalogResourceTemplates: [],
							} as never)
						: sourceApp(manyTools),
			);
		});
		const loadConnect = () =>
			aggregateAndPrefixTools(
				mounts,
				env,
				new Set(),
				ctx,
				"connect",
				activation,
				false,
			);
		const shardKeys = () =>
			[...r2.objects.keys()].filter((key) =>
				key.startsWith("aggregate-discovery/v1/"),
			);

		it("hydrates only a selected shard row's organization and checks its identity", async () => {
			await loadConnect();
			await settleBackground();
			aggregateSurfaceCache.clear();
			aggregateSurfaceInFlight.clear();
			const shards = await loadDiscoveryShards(
				env,
				mounts,
				new Set(),
				activation.value,
			);
			const row = shards!.tools.find(
				(tool) => tool.toolId === "acme_unified_source__read_item_0",
			)!;
			const hydrate = vi.fn((entry: AggregateAppEntry) =>
				aggregateAndPrefixTools(
					[entry],
					env,
					new Set(),
					ctx,
					"connect",
					activation,
					false,
				),
			);
			const full = await loadDiscoveryToolDefinition(row, mounts, hydrate);
			expect(hydrate.mock.calls.map(([entry]) => entry.slug)).toEqual([
				"acme-unified",
			]);
			expect(full.id).toBe(row.id);
			expect(full.toolId).toBe(row.toolId);
			expect(full.inputSchema).toHaveProperty("properties");
			expect(full.config?._discoveryShard).not.toBe(true);
			expect(row.inputSchema).toEqual({ type: "object" });
			await expect(
				loadDiscoveryToolDefinition(
					{ ...row, id: "replaced-row" },
					mounts,
					hydrate,
				),
			).rejects.toThrow("Discovery schema is unavailable");
			hydrate.mockClear();
			await expect(
				loadDiscoveryToolDefinition(row, [mounts[1]!], hydrate),
			).rejects.toThrow("no unique organization mount");
			await expect(
				loadDiscoveryToolDefinition(row, [mounts[0]!, mounts[0]!], hydrate),
			).rejects.toThrow("no unique organization mount");
			expect(hydrate).not.toHaveBeenCalled();
		});

		it("compiles one compact shard per organization graph", async () => {
			const surface = await loadConnect();
			await settleBackground();
			expect(shardKeys()).toHaveLength(2);
			// Shards drop schemas; the served surface keeps them.
			for (const key of shardKeys())
				expect(r2.objects.get(key)!.body).not.toContain('"properties"');
			expect(surface.tools[0]?.inputSchema).toHaveProperty("properties");

			// An unchanged organization graph is not compiled again.
			const puts = r2.bucket.put.mock.calls.length;
			await loadConnect();
			await settleBackground();
			expect(r2.bucket.put.mock.calls.length).toBe(puts);
		});

		it("serves namespace-free discovery without parsing any organization snapshot", async () => {
			await loadConnect();
			await settleBackground();
			// A cold isolate: no organization graph in memory.
			aggregateSurfaceCache.clear();
			aggregateSurfaceInFlight.clear();
			resolveUpstreamToolsInternally.mockClear();
			r2.bucket.get.mockClear();
			colo.cache.match.mockClear();

			const shards = await loadDiscoveryShards(
				env,
				mounts,
				new Set(),
				activation.value,
			);
			expect(shards?.hydrate).toEqual([]);
			// Each organization gateway mounts `source` plus the platform app.
			expect(shards?.tools).toHaveLength(manyTools.length * 4);
			const row = shards!.tools.find(
				(tool) => tool.toolId === "acme_unified_source__read_item_0",
			)!;
			expect(row.inputSchema).toEqual({ type: "object" });
			expect(row.config?._discoveryShard).toBe(true);
			expect(row.config?._multiOrgOrganizationId).toBe("org-acme-unified");
			// Only shard objects were read: no snapshot tier, no live fan-out.
			expect(resolveUpstreamToolsInternally).not.toHaveBeenCalled();
			expect(colo.cache.match).not.toHaveBeenCalled();
			expect(colo.bodyReads.count).toBe(0);
			expect(
				r2.bucket.get.mock.calls.every(([key]) =>
					String(key).startsWith("aggregate-discovery/v1/"),
				),
			).toBe(true);

			// Parsed shards are shared by the next request in this isolate.
			r2.bucket.get.mockClear();
			const again = await loadDiscoveryShards(
				env,
				mounts,
				new Set(),
				activation.value,
			);
			expect(again?.tools).toContain(row);
			expect(r2.bucket.get).not.toHaveBeenCalled();
		});

		it("hydrates only the organization a program calls by name", async () => {
			await loadConnect();
			await settleBackground();
			const shards = await loadDiscoveryShards(
				env,
				mounts,
				new Set(["globex_unified_source"]),
				activation.value,
			);
			expect(shards?.hydrate.map((entry) => entry.slug)).toEqual([
				"globex-unified",
			]);
			expect(
				shards?.tools.every((tool) => tool.toolId.startsWith("acme_unified_")),
			).toBe(true);
		});

		it("never executes a shard row", async () => {
			const { ToolHandler } = await import("./mcp/handler");
			const result = await new ToolHandler().execute({}, {
				config: { endpoint: "apps/get", _discoveryShard: true },
			} as never);
			expect(result.status).toBe(409);
		});

		it("hydrates organizations whose shard is missing and falls back when none exist", async () => {
			await loadConnect();
			await settleBackground();
			// A schema sync rolls the epoch: no shard exists yet.
			await expect(
				loadDiscoveryShards(env, mounts, new Set(), "epoch-after-sync"),
			).resolves.toBeNull();
			const acmeKey = shardKeys().find((key) =>
				r2.objects
					.get(key)!
					.body.includes('"toolId":"acme_unified_source__read_item_0"'),
			)!;
			r2.objects.delete(acmeKey);
			discoveryShardCache.clear();
			const partial = await loadDiscoveryShards(
				env,
				mounts,
				new Set(),
				activation.value,
			);
			expect(partial?.hydrate.map((entry) => entry.slug)).toEqual([
				"acme-unified",
			]);
			expect(
				partial?.tools.every((tool) =>
					tool.toolId.startsWith("globex_unified_"),
				),
			).toBe(true);
		});

		it.each([0, 1])(
			"compacts missing organization graphs sequentially with %i existing shards",
			async (existing) => {
				if (existing) {
					await aggregateAndPrefixTools(
						[mounts[0]!],
						env,
						new Set(),
						ctx,
						"connect",
						activation,
						false,
					);
					await settleBackground();
				}
				const loaded: string[] = [];
				const shards = await loadDiscoveryShards(
					env,
					mounts,
					new Set(),
					activation.value,
					async (entry) => {
						// The preceding graph's queued serialization must finish before
						// the next full graph is allocated.
						expect(shardKeys()).toHaveLength(existing + loaded.length);
						loaded.push(entry.slug);
						return aggregateAndPrefixTools(
							[entry],
							env,
							new Set(),
							ctx,
							"connect",
							activation,
							false,
						);
					},
				);
				expect(loaded).toEqual(organizations.slice(existing));
				expect(shards?.hydrate).toEqual([]);
				expect(shards?.degraded).toBe(false);
				expect(shards?.tools).toHaveLength(manyTools.length * 4);
				expect(
					shards!.tools.every(
						(tool) =>
							tool.config?._discoveryShard === true &&
							!("properties" in tool.inputSchema),
					),
				).toBe(true);
				expect(
					new Set(
						shards!.tools.map((tool) => tool.config?._multiOrgOrganizationId),
					),
				).toEqual(new Set(mounts.map((entry) => entry.organizationId)));
				expect(shardKeys()).toHaveLength(mounts.length);
				const hydrate = vi.fn();
				const next = await loadDiscoveryShards(
					env,
					mounts,
					new Set(),
					activation.value,
					hydrate,
				);
				expect(next?.tools.map((tool) => tool.toolId)).toEqual(
					shards?.tools.map((tool) => tool.toolId),
				);
				expect(hydrate).not.toHaveBeenCalled();
			},
		);

		it("uses sequential compact hydration when shard storage is unavailable", async () => {
			r2.bucket.get.mockRejectedValue(new Error("R2 unavailable"));
			const hydrate = vi.fn(async (entry: AggregateAppEntry) => {
				const surface = await aggregateAndPrefixTools(
					[entry],
					env,
					new Set(),
					ctx,
					"connect",
					activation,
					false,
				);
				return { ...surface, degraded: true };
			});
			const shards = await loadDiscoveryShards(
				env,
				mounts,
				new Set(),
				activation.value,
				hydrate,
			);
			expect(hydrate.mock.calls.map(([entry]) => entry.slug)).toEqual(
				organizations,
			);
			expect(shards?.hydrate).toEqual([]);
			expect(shards?.tools).toHaveLength(manyTools.length * 4);
			expect(shards?.degraded).toBe(true);
		});

		it.each([
			DISCOVERY_SHARD_STALE_AFTER_MS + 1_000,
			7 * 24 * DISCOVERY_SHARD_STALE_AFTER_MS,
		])(
			"serves a shard aged %i ms and names one organization to rebuild",
			async (age) => {
				await loadConnect();
				await settleBackground();
				// Every shard of the selection ages together.
				vi.setSystemTime(Date.now() + age);
				discoveryShardCache.clear();
				resolveUpstreamToolsInternally.mockClear();

				const shards = await loadDiscoveryShards(
					env,
					mounts,
					new Set(),
					activation.value,
				);
				// Nothing is hydrated in the request: stale rows still rank.
				expect(shards?.hydrate).toEqual([]);
				expect(shards?.tools).toHaveLength(manyTools.length * 4);
				expect(shards?.refresh?.slug).toBe("acme-unified");
				expect(resolveUpstreamToolsInternally).not.toHaveBeenCalled();

				// The refresh hydrates that one organization after the response and
				// rewrites only its shard; a second request does not start another.
				const hydrate = vi.fn(() =>
					aggregateAndPrefixTools(
						[shards!.refresh!],
						env,
						new Set(),
						ctx,
						"connect",
						activation,
						false,
					),
				);
				refreshDiscoveryShard(shards!.refresh!, activation.value, hydrate, ctx);
				refreshDiscoveryShard(shards!.refresh!, activation.value, hydrate, ctx);
				expect(hydrate).toHaveBeenCalledTimes(1);
				const next = await loadDiscoveryShards(
					env,
					mounts,
					new Set(),
					activation.value,
				);
				expect(next?.refresh?.slug).toBe("globex-unified");
				await settleBackground();
				expect(discoveryShardRefreshInFlight.size).toBe(0);
				const rewritten = shardKeys().filter(
					(key) =>
						Number(r2.objects.get(key)!.customMetadata?.builtAt) >=
						Date.now() - 1_000,
				);
				expect(rewritten).toHaveLength(1);
				expect(r2.objects.get(rewritten[0]!)!.body).toContain(
					'"toolId":"acme_unified_source__read_item_0"',
				);
			},
		);

		it("rewrites a stale shard even when the organization graph object is unchanged", async () => {
			await loadConnect();
			await settleBackground();
			const before = Object.fromEntries(
				shardKeys().map((key) => [key, r2.objects.get(key)!.customMetadata]),
			);
			// The graph stays hot in this isolate (same object, already compiled)
			// while the stored shards age past the refresh window.
			for (const key of shardKeys())
				r2.objects.get(key)!.customMetadata = {
					builtAt: String(Date.now() - DISCOVERY_SHARD_STALE_AFTER_MS - 1_000),
				};
			discoveryShardCache.clear();
			const shards = await loadDiscoveryShards(
				env,
				mounts,
				new Set(),
				activation.value,
			);
			const refresh = shards!.refresh!;
			refreshDiscoveryShard(
				refresh,
				activation.value,
				async () => {
					// Hydration reuses the graph object the first load compiled from.
					await aggregateAndPrefixTools(
						[refresh],
						env,
						new Set(),
						ctx,
						"connect",
						activation,
						false,
					);
				},
				ctx,
			);
			await settleBackground();
			const rewritten = shardKeys().filter(
				(key) =>
					r2.objects.get(key)!.customMetadata?.builtAt !== before[key]?.builtAt,
			);
			expect(rewritten).toHaveLength(1);
		});

		it("writes shards after the response, one at a time, and skips fresh ones", async () => {
			let active = 0;
			let peak = 0;
			const put = r2.bucket.put.getMockImplementation()!;
			r2.bucket.put.mockImplementation(async (...args) => {
				if (!args[0].startsWith("aggregate-discovery/")) return put(...args);
				active++;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 0));
				await put(...args);
				active--;
			});
			await loadConnect();
			expect(shardKeys()).toHaveLength(0);
			await settleBackground();
			expect(shardKeys()).toHaveLength(2);
			expect(peak).toBe(1);

			// Another isolate with its own graph objects finds fresh shards.
			aggregateSurfaceCache.clear();
			aggregateSurfaceInFlight.clear();
			const puts = r2.bucket.put.mock.calls.length;
			await loadConnect();
			await settleBackground();
			expect(r2.bucket.put.mock.calls.length).toBe(puts);
		});
	});

	it("does not parse a snapshot after its read budget tripped", async () => {
		vi.useRealTimers();
		vi.useFakeTimers();
		vi.spyOn(console, "error").mockImplementation(() => {});
		const json = vi.fn(async () => ({}));
		let deliver: (response: Response) => void = () => {};
		colo.cache.match.mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					deliver = resolve;
				}),
		);
		const read = readAggregateL2("slow-key");
		await vi.advanceTimersByTimeAsync(CACHE_TIER_BUDGET_MS + 1);
		await expect(read).resolves.toBeNull();

		const late = new Response("{}", {
			headers: {
				"X-Tedix-Aggregate-Cached-At": String(Date.now()),
				"X-Tedix-Aggregate-Generation": "late",
			},
		});
		late.json = json as Response["json"];
		deliver(late);
		await vi.advanceTimersByTimeAsync(0);
		expect(json).not.toHaveBeenCalled();
	});
});
