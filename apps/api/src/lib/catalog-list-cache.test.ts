import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import type {
	ListCatalogAppsInput,
	ListCatalogAppsOutput,
} from "@tedix/api-contract/schemas/catalog";
import type { BaseContext } from "../rpc/context";
import { catalogListCache } from "./catalog-list-cache";

const input: ListCatalogAppsInput = { limit: 50, offset: 0 };
const page: ListCatalogAppsOutput = {
	apps: [],
	total: 9800,
	pagination: { limit: 50, offset: 0, hasMore: true },
};

describe("catalog browse edge cache", () => {
	let now: number;
	let entries: Map<string, { response: Response; expires: number }>;
	let pending: Promise<unknown>[];
	let edge: { match: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
	let context: Pick<BaseContext, "env" | "waitUntil">;

	beforeEach(() => {
		now = 0;
		entries = new Map();
		pending = [];
		edge = {
			match: vi.fn(async (request: Request) => {
				const entry = entries.get(request.url);
				return entry && entry.expires > now
					? entry.response.clone()
					: undefined;
			}),
			put: vi.fn(async (request: Request, response: Response) => {
				const seconds = Number(
					response.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1],
				);
				entries.set(request.url, { response, expires: now + seconds * 1000 });
			}),
		};
		vi.stubGlobal("caches", { default: edge });
		context = {
			env: { CF_VERSION_METADATA: { id: "release-one" } } as CloudflareEnv,
			waitUntil: (work) => void pending.push(work),
		};
	});

	afterEach(() => vi.unstubAllGlobals());

	it("reuses a page and its exact total across request contexts until expiry", async () => {
		const load = vi.fn(async () => page);
		async function read() {
			const cache = catalogListCache({ ...context }, { ...input });
			const hit = await cache?.match();
			if (hit) return hit;
			const result = await load();
			cache?.put(result);
			await Promise.all(pending);
			return result;
		}
		await expect(read()).resolves.toEqual(page);
		now = 59_999;
		await expect(read()).resolves.toEqual(page);
		expect(load).toHaveBeenCalledTimes(1);
		now = 60_000;
		const updated = { ...page, total: 9801 };
		load.mockResolvedValue(updated);
		await expect(read()).resolves.toEqual(updated);
		expect(load).toHaveBeenCalledTimes(2);
	});

	it("separates filters, pages, sort order, and variant visibility", async () => {
		catalogListCache(context, input)!.put(page);
		await Promise.all(pending);
		for (const change of [
			{ category: "productivity" },
			{ source: "claude" as const },
			{ hasWrites: false },
			{ offset: 50 },
			{ limit: 100 },
			{ sortDir: "desc" as const },
			{ includeVariants: true },
		]) {
			await expect(
				catalogListCache(context, { ...input, ...change })!.match(),
			).resolves.toBeUndefined();
		}
		await expect(
			catalogListCache(context, { offset: 0, limit: 50 })!.match(),
		).resolves.toEqual(page);
	});

	it("never carries cached data into another Worker deployment", async () => {
		catalogListCache(context, input)!.put(page);
		await Promise.all(pending);
		const other = {
			...context,
			env: { CF_VERSION_METADATA: { id: "release-two" } } as CloudflareEnv,
		};
		await expect(
			catalogListCache(other, input)!.match(),
		).resolves.toBeUndefined();
	});

	it("bypasses search and environments without a deployed version or lifetime", () => {
		expect(
			catalogListCache(context, { ...input, search: " Slack " }),
		).toBeUndefined();
		expect(
			catalogListCache({ ...context, env: {} as CloudflareEnv }, input),
		).toBeUndefined();
		expect(catalogListCache({ env: context.env }, input)).toBeUndefined();
		expect(edge.match).not.toHaveBeenCalled();
		expect(edge.put).not.toHaveBeenCalled();
	});

	it("falls back to the database when cache reads fail and absorbs write failures", async () => {
		edge.match.mockRejectedValue(new Error("cache unavailable"));
		edge.put.mockRejectedValue(new Error("cache unavailable"));
		const cache = catalogListCache(context, input)!;
		await expect(cache.match()).resolves.toBeUndefined();
		cache.put(page);
		await expect(Promise.all(pending)).resolves.toEqual([undefined]);
	});
});
