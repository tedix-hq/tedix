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
	readAggregateL2,
} from "./aggregate-surface-cache";
import { CACHE_TIER_BUDGET_MS } from "./lib/step-budget";

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
