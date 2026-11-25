import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";

const { getBySlugWithTools, getBySlugsWithTools } = vi.hoisted(() => ({
	getBySlugWithTools: vi.fn(),
	getBySlugsWithTools: vi.fn(),
}));

vi.mock("./lib/api-client", () => ({
	getApiClient: () => ({ apps: { getBySlugWithTools, getBySlugsWithTools } }),
}));

import {
	invalidateToolDefinitionsByScope,
	internalToolCache,
	internalToolInFlight,
	loadInternalTools,
	resolveUpstreamToolsInternally,
} from "./aggregate-internal-tools";
import { aggregateAndPrefixTools } from "./aggregate-surface";
import { prefetchAggregateEntries } from "./aggregate-prefetch";
import { TOOL_DEFINITIONS_SOFT_TTL_MS } from "./aggregate-tool-definitions-cache";

const env = { API_SERVICE: {} } as unknown as CloudflareEnv;

function payload(slug: string, toolId: string) {
	return {
		slug,
		app: { id: `${slug}-id`, slug, organizationId: "org", metadata: {} },
		tools: [{ id: `${slug}-${toolId}`, toolId, enabled: true, config: {} }],
	};
}

function toolIds(result: { tools: Array<{ toolId: string }> }) {
	return result.tools.map((tool) => tool.toolId);
}

describe("durable tool definitions cache", () => {
	const store = new Map<string, Response>();
	const cache = {
		match: vi.fn(async (request: Request) => store.get(request.url)?.clone()),
		put: vi.fn(async (request: Request, response: Response) => {
			store.set(request.url, response.clone());
		}),
	};
	const background: Promise<unknown>[] = [];
	const ctx = {
		waitUntil: (promise: Promise<unknown>) => {
			background.push(promise.catch(() => {}));
		},
	};

	beforeEach(() => {
		vi.stubGlobal("caches", { default: cache });
		store.clear();
		background.length = 0;
		internalToolCache.clear();
		internalToolInFlight.clear();
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("serves a second isolate without reading tool rows again", async () => {
		getBySlugWithTools.mockResolvedValue(payload("source", "list"));
		const resolve = (epoch: string) =>
			resolveUpstreamToolsInternally(
				{ slug: "source" },
				env,
				undefined,
				epoch,
				true,
				ctx,
			);

		expect(toolIds(await resolve("epoch-1"))).toEqual(["list"]);
		expect(getBySlugWithTools).toHaveBeenCalledTimes(1);
		expect(cache.put).toHaveBeenCalledTimes(1);

		// A fresh isolate has no L1 entry.
		internalToolCache.clear();
		expect(toolIds(await resolve("epoch-1"))).toEqual(["list"]);
		expect(getBySlugWithTools).toHaveBeenCalledTimes(1);

		// A rolled activation epoch is a different key.
		internalToolCache.clear();
		expect(toolIds(await resolve("epoch-2"))).toEqual(["list"]);
		expect(getBySlugWithTools).toHaveBeenCalledTimes(2);
	});

	it("serves a stale entry while one background refresh replaces it", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const start = Date.now();
		getBySlugWithTools.mockResolvedValue(payload("source", "list"));
		const resolve = () =>
			resolveUpstreamToolsInternally(
				{ slug: "source" },
				env,
				undefined,
				"epoch-1",
				true,
				ctx,
			);
		await resolve();

		vi.setSystemTime(start + TOOL_DEFINITIONS_SOFT_TTL_MS + 1_000);
		getBySlugWithTools.mockResolvedValue(payload("source", "list_v2"));
		internalToolCache.clear();
		expect(toolIds(await resolve())).toEqual(["list"]);
		// The refresh ran once in the background, not on the request path.
		expect(getBySlugWithTools).toHaveBeenCalledTimes(2);
		await Promise.all(background);

		internalToolCache.clear();
		expect(toolIds(await resolve())).toEqual(["list_v2"]);
		expect(getBySlugWithTools).toHaveBeenCalledTimes(2);
	});

	it("keeps a missing app and uncacheable loads out of the durable tier", async () => {
		getBySlugWithTools.mockResolvedValue({ app: null, tools: [] });
		await resolveUpstreamToolsInternally(
			{ slug: "missing" },
			env,
			undefined,
			"epoch-1",
			true,
			ctx,
		);
		getBySlugWithTools.mockResolvedValue(payload("fresh", "list"));
		await resolveUpstreamToolsInternally(
			{ slug: "fresh" },
			env,
			undefined,
			"tenant-policy-fresh",
			false,
			ctx,
		);
		expect(cache.match).not.toHaveBeenCalledWith(
			expect.objectContaining({ url: expect.stringContaining("fresh") }),
		);
		expect(cache.put).not.toHaveBeenCalled();
	});

	it("prefetches only the entries the durable tier cannot answer", async () => {
		getBySlugWithTools.mockResolvedValue(payload("cached", "list"));
		await resolveUpstreamToolsInternally(
			{ slug: "cached" },
			env,
			undefined,
			"epoch-1",
			true,
			ctx,
		);
		internalToolCache.clear();
		getBySlugsWithTools.mockImplementation(
			async ({ apps }: { apps: Array<{ slug: string }> }) => ({
				results: apps.map(({ slug }) => payload(slug, "list")),
			}),
		);

		await prefetchAggregateEntries(
			[{ slug: "cached" }, { slug: "other" }],
			env,
			new Set(),
			"epoch-1",
			true,
			ctx,
		);

		expect(getBySlugsWithTools).toHaveBeenCalledTimes(1);
		expect(getBySlugsWithTools).toHaveBeenCalledWith({
			apps: [{ slug: "other" }],
		});
		// Both entries are now in L1, and the batched one is durable too.
		expect([...internalToolCache.keys()]).toHaveLength(2);
		expect(cache.put).toHaveBeenCalledTimes(2);
	});
	it("bounds a joiner without cutting short the owning upstream read", async () => {
		vi.useFakeTimers();
		getBySlugWithTools.mockImplementation(
			() =>
				new Promise<ReturnType<typeof payload>>((resolve) =>
					setTimeout(() => resolve(payload("slow", "list")), 9_000),
				),
		);
		const fetchUpstream = () => getBySlugWithTools();
		const owner = loadInternalTools("slow-key", "slow", fetchUpstream, ctx);
		await vi.advanceTimersByTimeAsync(0);
		const joined = expect(
			loadInternalTools("slow-key", "slow", fetchUpstream, ctx),
		).rejects.toMatchObject({ code: "STEP_BUDGET_EXCEEDED" });
		await vi.advanceTimersByTimeAsync(8_000);
		await joined;
		expect(internalToolInFlight.has("slow-key")).toBe(false);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(toolIds(await owner)).toEqual(["list"]);
		expect(getBySlugWithTools).toHaveBeenCalledTimes(1);
	});

	it.each([false, true])(
		"coalesces 100 invalidated builds and retains stale on refusal=%s",
		async (refused) => {
			const logs = vi.spyOn(console, "info").mockImplementation(() => {});
			const entries = [{ slug: "one" }, { slug: "two" }];
			getBySlugsWithTools.mockImplementation(
				async ({ apps }: { apps: Array<{ slug: string }> }) => ({
					results: apps.map(({ slug }) => payload(slug, "old")),
				}),
			);
			let buildId = 0;
			const build = () =>
				aggregateAndPrefixTools(
					entries,
					env,
					new Set([`build-${buildId++}`]),
					ctx as ExecutionContext,
					undefined,
					{ value: "burst", cacheable: true },
					false,
				);
			await build();
			getBySlugsWithTools.mockClear();
			let finish!: () => void;
			const held = new Promise<void>((resolve) => {
				finish = resolve;
			});
			getBySlugsWithTools.mockImplementation(
				async ({ apps }: { apps: Array<{ slug: string }> }) => {
					await held;
					if (refused) throw new Error("503 Database temporarily unavailable");
					return { results: apps.map(({ slug }) => payload(slug, "new")) };
				},
			);
			for (let i = 0; i < 10; i++) invalidateToolDefinitionsByScope();
			const first = await Promise.all(Array.from({ length: 50 }, build));
			await vi.waitFor(() =>
				expect(getBySlugsWithTools).toHaveBeenCalledTimes(1),
			);
			// Arrive after the batch window closes, while its D1 read is still pending.
			const later = await Promise.all(Array.from({ length: 50 }, build));
			expect(
				[...first, ...later].every(
					(results) => toolIds(results).join(",") === "one__old,two__old",
				),
			).toBe(true);
			expect(getBySlugsWithTools).toHaveBeenCalledTimes(1);
			expect(getBySlugsWithTools.mock.calls[0]?.[0].apps).toEqual(entries);
			expect(getBySlugWithTools).not.toHaveBeenCalled();
			finish();
			await Promise.all(background);
			expect(toolIds(await build())).toEqual(
				refused ? ["one__old", "two__old"] : ["one__new", "two__new"],
			);
			expect(getBySlugsWithTools).toHaveBeenCalledTimes(1);
			expect(logs.mock.calls.map(([entry]) => entry)).toContainEqual(
				expect.objectContaining({
					event: "aggregate.tool_definitions_miss",
					reason: "invalidated_by_scope",
				}),
			);
			if (refused)
				expect(logs.mock.calls.map(([entry]) => entry)).toContainEqual(
					expect.objectContaining({
						event: "aggregate.tool_definitions_miss",
						reason: "fetch_failed",
					}),
				);
			logs.mockRestore();
		},
	);
});
