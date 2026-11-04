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
	internalToolCache,
	internalToolInFlight,
	resolveUpstreamToolsInternally,
} from "./aggregate-internal-tools";
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
});
