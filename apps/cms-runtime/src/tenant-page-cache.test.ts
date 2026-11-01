import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	anonymousPageRequest,
	cachedTenantPage,
	MARKETING_PAGE_CACHE_CONTROL,
	pageCacheEligible,
	pageCacheKey,
	pageCachePolicy,
	PAGE_CACHE_STATUS_HEADER,
	type PageCacheIdentity,
} from "./tenant-page-cache";

afterEach(() => vi.restoreAllMocks());

const identity: PageCacheIdentity = {
	siteId: "site-a",
	slug: "acme",
	restoreEpoch: 1,
	bundleEtag: "etag-1",
	bundleVersion: 7,
	contentRevision: "revision-1",
};

function html(body: string, headers: Record<string, string> = {}): Response {
	return new Response(body, {
		headers: { "Content-Type": "text/html; charset=utf-8", ...headers },
	});
}

class MemoryCache {
	entries = new Map<string, Response>();
	async match(request: Request): Promise<Response | undefined> {
		return this.entries.get(request.url)?.clone();
	}
	async put(request: Request, response: Response): Promise<void> {
		this.entries.set(
			request.url,
			new Response(await response.arrayBuffer(), response),
		);
	}
}

async function serve(
	cache: MemoryCache,
	key: Request,
	render: () => Promise<Response>,
	now: number,
	templateSlug = "marketing",
): Promise<{ response: Response; background: Promise<unknown>[] }> {
	const background: Promise<unknown>[] = [];
	const response = await cachedTenantPage({
		cache: cache as unknown as Cache,
		key,
		templateSlug,
		waitUntil: (promise) => background.push(promise),
		render,
		now: () => now,
	});
	await Promise.all(background);
	return { response, background };
}

describe("tenant page cache key", () => {
	it("separates hosts, sites, slugs, restores, bundles and public-host headers", async () => {
		const tenantUrl = new URL("https://acme.cms.example/blog");
		const base = await pageCacheKey(
			new Request("https://acme.example/blog"),
			tenantUrl,
			identity,
		);
		const variants = await Promise.all([
			pageCacheKey(new Request("https://acme.example/blog"), tenantUrl, {
				...identity,
				contentRevision: "revision-2",
			}),
			pageCacheKey(
				new Request("https://other.example/blog"),
				tenantUrl,
				identity,
			),
			pageCacheKey(new Request("https://acme.example/blog"), tenantUrl, {
				...identity,
				siteId: "site-b",
			}),
			pageCacheKey(new Request("https://acme.example/blog"), tenantUrl, {
				...identity,
				slug: "other",
			}),
			pageCacheKey(new Request("https://acme.example/blog"), tenantUrl, {
				...identity,
				restoreEpoch: 2,
			}),
			pageCacheKey(new Request("https://acme.example/blog"), tenantUrl, {
				...identity,
				bundleEtag: "etag-2",
			}),
			pageCacheKey(
				new Request("https://acme.example/blog", {
					headers: { "X-Forwarded-Host": "evil.example" },
				}),
				tenantUrl,
				identity,
			),
			pageCacheKey(
				new Request("https://acme.example/blog?page=2"),
				tenantUrl,
				identity,
			),
		]);
		const urls = new Set([base.url, ...variants.map((key) => key.url)]);
		expect(urls.size).toBe(variants.length + 1);
		expect(new URL(base.url).host).toBe("acme.example");
	});
});

describe("tenant page cache eligibility and policy", () => {
	it("renders shared pages without the visitor's cookies", () => {
		const request = new Request("https://a/blog", {
			headers: { cookie: "theme=dark", "x-forwarded-host": "a" },
		});
		const anonymous = anonymousPageRequest(request);
		expect(anonymous.headers.has("cookie")).toBe(false);
		expect(anonymous.headers.get("x-forwarded-host")).toBe("a");
		expect(request.headers.get("cookie")).toBe("theme=dark");
	});

	it("admits only anonymous GETs outside internal paths", () => {
		expect(pageCacheEligible(new Request("https://a/blog"), "/blog")).toBe(
			true,
		);
		expect(
			pageCacheEligible(
				new Request("https://a/blog", { method: "HEAD" }),
				"/blog",
			),
		).toBe(false);
		expect(
			pageCacheEligible(
				new Request("https://a/blog", { headers: { cookie: "s=1" } }),
				"/blog",
			),
		).toBe(false);
		for (const cookie of [
			"theme=dark",
			"_ga=GA1.1.1; _ga_ABC123=GS1.1; theme=light",
			"__cf_bm=x; cf_clearance=y",
		])
			expect(
				pageCacheEligible(
					new Request("https://a/blog", { headers: { cookie } }),
					"/blog",
				),
			).toBe(true);
		for (const cookie of ["theme=dark; DS=jwt", "_ga=1; DSR=jwt", "emdash=1"])
			expect(
				pageCacheEligible(
					new Request("https://a/blog", { headers: { cookie } }),
					"/blog",
				),
			).toBe(false);
		expect(
			pageCacheEligible(new Request("https://a/blog?_preview=x"), "/blog"),
		).toBe(false);
		expect(
			pageCacheEligible(
				new Request("https://a/_emdash/admin"),
				"/_emdash/admin",
			),
		).toBe(false);
	});

	it("stores only declared or marketing-default public HTML", () => {
		expect(
			pageCachePolicy(
				html("catalog", {
					"Cache-Control":
						"public, max-age=0, s-maxage=300, stale-while-revalidate=86400",
				}),
				"marketing",
			),
		).toEqual({ freshSeconds: 300, staleSeconds: 86400 });
		expect(pageCachePolicy(html("x"), "marketing")).toEqual({
			freshSeconds: 60,
			staleSeconds: 86400,
		});
		expect(pageCachePolicy(html("x"), "tedix")).toBeNull();
		expect(
			pageCachePolicy(
				html("x", { "Cache-Control": "public, max-age=30" }),
				"tedix",
			),
		).toEqual({ freshSeconds: 30, staleSeconds: 0 });
		for (const cacheControl of ["private, max-age=60", "no-store", "public"])
			expect(
				pageCachePolicy(
					html("x", { "Cache-Control": cacheControl }),
					"marketing",
				),
			).toBeNull();
		expect(
			pageCachePolicy(html("x", { "Set-Cookie": "a=1" }), "marketing"),
		).toBeNull();
		expect(pageCachePolicy(html("x", { Vary: "*" }), "marketing")).toBeNull();
		expect(
			pageCachePolicy(
				new Response("x", {
					status: 404,
					headers: { "Content-Type": "text/html" },
				}),
				"marketing",
			),
		).toBeNull();
		expect(
			pageCachePolicy(
				new Response("<rss/>", {
					headers: {
						"Content-Type": "application/xml",
						"Cache-Control": "public, max-age=3600",
					},
				}),
				"marketing",
			),
		).toBeNull();
		expect(MARKETING_PAGE_CACHE_CONTROL).toContain("public");
	});
});

describe("cachedTenantPage", () => {
	const key = new Request("https://acme.example/_tedix/page-cache/acme/k");

	it("renders a miss, then serves a fresh hit without rendering", async () => {
		const cache = new MemoryCache();
		let renders = 0;
		const render = async () => html(`v${++renders}`);

		const miss = await serve(cache, key, render, 1_000);
		expect(miss.response.headers.get(PAGE_CACHE_STATUS_HEADER)).toBe("MISS");
		expect(await miss.response.text()).toBe("v1");

		const hit = await serve(cache, key, render, 30_000);
		expect(hit.response.headers.get(PAGE_CACHE_STATUS_HEADER)).toBe("HIT");
		expect(hit.response.headers.get("Cache-Control")).toBeNull();
		expect(hit.response.headers.get("X-Tedix-Page-Cached-At")).toBeNull();
		expect(await hit.response.text()).toBe("v1");
		expect(renders).toBe(1);
	});

	it("serves a stale copy and refreshes it in the background", async () => {
		const cache = new MemoryCache();
		let renders = 0;
		const render = async () => html(`v${++renders}`);
		await (await serve(cache, key, render, 0)).response.text();

		const stale = await serve(cache, key, render, 61_000);
		expect(stale.response.headers.get(PAGE_CACHE_STATUS_HEADER)).toBe("STALE");
		expect(await stale.response.text()).toBe("v1");
		expect(renders).toBe(2);

		const refreshed = await serve(cache, key, render, 62_000);
		expect(refreshed.response.headers.get(PAGE_CACHE_STATUS_HEADER)).toBe(
			"HIT",
		);
		expect(await refreshed.response.text()).toBe("v2");
	});

	it("passes through and never stores a response without a shareable policy", async () => {
		const cache = new MemoryCache();
		const bypass = await serve(
			cache,
			key,
			async () => html("secret", { "Set-Cookie": "s=1" }),
			0,
		);
		expect(bypass.response.headers.get(PAGE_CACHE_STATUS_HEADER)).toBe(
			"BYPASS",
		);
		expect(bypass.response.headers.get("Set-Cookie")).toBe("s=1");
		expect(await bypass.response.text()).toBe("secret");
		expect(cache.entries.size).toBe(0);
	});
});

describe("cachedTenantPage on the workerd Cache API", () => {
	it("stores and matches the entry in caches.default", async () => {
		const cache = (caches as unknown as { default: Cache }).default;
		const key = await pageCacheKey(
			new Request("https://acme.example/blog"),
			new URL("https://acme.cms.example/blog"),
			identity,
		);
		let renders = 0;
		const render = async () => html(`page ${++renders}`);
		const background: Promise<unknown>[] = [];
		const options = {
			cache,
			key,
			templateSlug: "marketing",
			waitUntil: (promise: Promise<unknown>) => background.push(promise),
			render,
		};
		expect(await (await cachedTenantPage(options)).text()).toBe("page 1");
		await Promise.all(background);
		const hit = await cachedTenantPage(options);
		expect(hit.headers.get(PAGE_CACHE_STATUS_HEADER)).toBe("HIT");
		expect(await hit.text()).toBe("page 1");
		expect(renders).toBe(1);
	});
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function startRefresh(
	cache: MemoryCache,
	key: Request,
	render: () => Promise<Response>,
	now = 61_000,
) {
	const background: Promise<unknown>[] = [];
	const response = cachedTenantPage({
		cache: cache as unknown as Cache,
		key,
		templateSlug: "marketing",
		render,
		now: () => now,
		waitUntil: (promise) => background.push(promise),
	});
	return { response, background, finish: () => Promise.all(background) };
}

async function staleFixture(name: string) {
	const cache = new MemoryCache();
	const key = new Request(
		`https://fictional.example/_tedix/page-cache/${name}`,
	);
	await (await serve(cache, key, async () => html("stale"), 0)).response.text();
	return { cache, key };
}

describe("request-owned stale refresh reservations", () => {
	it("returns independent stale responses without sharing render I/O or waitUntil", async () => {
		const { cache, key } = await staleFixture("concurrent");
		const rendered = deferred<Response>();
		let renders = 0;
		const render = () => {
			renders++;
			return rendered.promise;
		};
		const first = startRefresh(cache, key, render);
		expect(await (await first.response).text()).toBe("stale");
		const others = Array.from({ length: 12 }, () =>
			startRefresh(cache, key, render),
		);
		for (const next of others) {
			expect(await (await next.response).text()).toBe("stale");
			expect(next.background).toHaveLength(0);
		}
		expect(renders).toBe(1);
		rendered.resolve(html("fresh"));
		await first.finish();
		expect(
			await (await serve(cache, key, render, 62_000)).response.text(),
		).toBe("fresh");
	});

	it("holds ownership through the actual cache write", async () => {
		const { cache, key } = await staleFixture("pending-write");
		const writeStarted = deferred<void>();
		const write = deferred<void>();
		const put = cache.put.bind(cache);
		cache.put = async (request, response) => {
			writeStarted.resolve();
			await write.promise;
			await put(request, response);
		};
		let renders = 0;
		const render = async () => {
			renders++;
			return html("fresh");
		};
		const first = startRefresh(cache, key, render);
		await (await first.response).text();
		await writeStarted.promise;
		const next = startRefresh(cache, key, render);
		expect(await (await next.response).text()).toBe("stale");
		expect(next.background).toHaveLength(0);
		expect(renders).toBe(1);
		write.resolve();
		await first.finish();
	});

	it("releases failed writes and synchronous render failures for a later retry", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const { cache, key } = await staleFixture("write-failure");
		const write = deferred<void>();
		const put = cache.put.bind(cache);
		cache.put = async () => write.promise;
		const first = startRefresh(cache, key, async () => html("fresh"));
		await (await first.response).text();
		const skipped = startRefresh(cache, key, async () => html("unexpected"));
		await (await skipped.response).text();
		expect(skipped.background).toHaveLength(0);
		write.reject(new Error("fictional-cache-write-failure"));
		await first.finish();
		expect(info).toHaveBeenCalledWith({
			event: "cms.page_cache.refresh_coalesced",
			outcome: "failed",
			coalescedRequests: 1,
		});
		expect(error).toHaveBeenCalledWith(
			"[cms-runtime] page cache store failed",
			expect.any(Error),
		);
		cache.put = put;
		const failed = startRefresh(cache, key, () => {
			throw new Error("fictional-render-failure");
		});
		expect(await (await failed.response).text()).toBe("stale");
		await failed.finish();
		expect(error).toHaveBeenCalledWith(
			"[cms-runtime] page cache refresh failed",
			expect.any(Error),
		);
		await (
			await serve(cache, key, async () => html("recovered"), 62_000)
		).response.text();
		expect(
			await (
				await serve(cache, key, async () => html("unexpected"), 63_000)
			).response.text(),
		).toBe("recovered");
	});

	it("expires hung owners without letting old cleanup remove a newer owner", async () => {
		const { cache, key } = await staleFixture("expiry");
		const firstRender = deferred<Response>();
		const secondRender = deferred<Response>();
		const first = startRefresh(cache, key, () => firstRender.promise);
		await (await first.response).text();
		const second = startRefresh(
			cache,
			key,
			() => secondRender.promise,
			121_001,
		);
		await (await second.response).text();
		expect(second.background).toHaveLength(1);
		firstRender.resolve(html("uncacheable", { "Set-Cookie": "s=1" }));
		await first.finish();
		const third = startRefresh(
			cache,
			key,
			async () => html("unexpected"),
			121_002,
		);
		await (await third.response).text();
		expect(third.background).toHaveLength(0);
		secondRender.resolve(html("fresh"));
		await second.finish();
	});

	it("keeps distinct tenant fences independent", async () => {
		const firstFixture = await staleFixture("tenant-a-restore-1");
		const secondFixture = await staleFixture("tenant-b-restore-2");
		const render = deferred<Response>();
		const first = startRefresh(
			firstFixture.cache,
			firstFixture.key,
			() => render.promise,
		);
		const second = startRefresh(
			secondFixture.cache,
			secondFixture.key,
			async () => html("other tenant"),
		);
		await (await first.response).text();
		await (await second.response).text();
		expect(first.background).toHaveLength(1);
		expect(second.background.length).toBeGreaterThan(0);
		await second.finish();
		render.resolve(html("first tenant"));
		await first.finish();
	});
});

it("bounds reservation state without evicting active owners at capacity", async () => {
	const gate = deferred<void>();
	const owners: ReturnType<typeof startRefresh>[] = [];
	const fixtures = await Promise.all(
		Array.from({ length: 257 }, (_, i) => staleFixture(`capacity-${i}`)),
	);
	const render = () => gate.promise.then(() => html("fresh"));
	try {
		for (const { cache, key } of fixtures) {
			const owner = startRefresh(cache, key, render, 1_000_000);
			owners.push(owner);
			await (await owner.response).text();
		}
		const first = fixtures[0]!;
		const stillOwned = startRefresh(first.cache, first.key, render, 1_000_001);
		await (await stillOwned.response).text();
		expect(stillOwned.background).toHaveLength(0);
		const overflow = fixtures[256]!;
		const fallback = startRefresh(
			overflow.cache,
			overflow.key,
			render,
			1_000_001,
		);
		owners.push(fallback);
		await (await fallback.response).text();
		expect(fallback.background).toHaveLength(1);
	} finally {
		gate.resolve();
		await Promise.all(owners.map((owner) => owner.finish()));
	}
});
