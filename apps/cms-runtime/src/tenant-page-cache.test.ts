import { describe, expect, it } from "vite-plus/test";
import {
	cachedTenantPage,
	MARKETING_PAGE_CACHE_CONTROL,
	pageCacheEligible,
	pageCacheKey,
	pageCachePolicy,
	PAGE_CACHE_STATUS_HEADER,
	type PageCacheIdentity,
} from "./tenant-page-cache";

const identity: PageCacheIdentity = {
	siteId: "site-a",
	slug: "acme",
	restoreEpoch: 1,
	bundleEtag: "etag-1",
	bundleVersion: 7,
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
