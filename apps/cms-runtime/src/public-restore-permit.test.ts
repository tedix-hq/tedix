vi.mock("@tedix/db/queries/site-routing", () => ({
	getSiteRoutingPolicy: vi.fn(async () => null),
}));
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { env as workerEnv } from "cloudflare:workers";

const mocks = vi.hoisted(() => ({
	getSiteBySlug: vi.fn(),
	getSiteByAlias: vi.fn(),
	getBundle: vi.fn(),
	permit: vi.fn(),
	lookupOrg: vi.fn(),
	sweep: vi.fn(async () => 0),
}));

vi.mock("./cms-restore-permit-leases", () => ({
	sweepCmsRestorePermitLeases: mocks.sweep,
}));

vi.mock("@tedix/db/queries/cms-sites", () => ({
	getCmsSiteBySlug: mocks.getSiteBySlug,
	getCmsSiteByActiveWwwAlias: mocks.getSiteByAlias,
	getCmsSiteByHostname: vi.fn(),
}));
vi.mock("@tedix/db/queries/tenant-bundles", () => ({
	getActiveTenantBundle: mocks.getBundle,
	listActiveTenantBundles: vi.fn(),
}));
vi.mock("./tenant-restore-fence", async (importOriginal) => ({
	...(await importOriginal<typeof import("./tenant-restore-fence")>()),
	withCmsRestoreResponsePermit: mocks.permit,
}));

vi.mock("./public-proxy", async (importOriginal) => ({
	...(await importOriginal<typeof import("./public-proxy")>()),
	lookupOrg: mocks.lookupOrg,
}));

import cmsRuntime from "./index";
import { PUBLISHED_FALLBACK_ADMIN_PATH } from "./published-fallback";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { pageCacheEntry, pageCacheKey } from "./tenant-page-cache";
import {
	PAGE_REVISION_HEADER,
	pageRevisionFingerprint,
} from "./native-page-cache";
import { publicRestorePermitEligible } from "./public-restore-permits";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSiteBySlug.mockResolvedValue({
		id: "site-1",
		slug: "tedix-landing",
		restoreEpoch: 7,
	});
	mocks.getSiteByAlias.mockResolvedValue(null);
	mocks.getBundle.mockResolvedValue(null);
	mocks.permit.mockResolvedValue({ admitted: false });
});

describe("legacy marketing blog hostname", () => {
	it.each([
		["/", "/blog/"],
		["/posts", "/blog/"],
		["/posts/", "/blog/"],
		["/posts/example-post", "/blog/example-post"],
		["/posts/example-post/?ref=source", "/blog/example-post?ref=source"],
		["/posts/example-post.md", "/blog/example-post.md"],
		["/blog/example-post/", "/blog/example-post"],
		["/tag/ai/", "/blog/tag/ai/"],
		["/rss.xml", "/rss.xml"],
		["/sitemap.xml", "/sitemap-posts.xml"],
		["/sitemap-posts.xml", "/sitemap-posts.xml"],
	])(
		"redirects GET and HEAD %s to %s before tenant lookup",
		async (source, target) => {
			for (const method of ["GET", "HEAD"]) {
				const response = await cmsRuntime.fetch(
					new Request(`https://blog.tedix.dev${source}`, { method }),
					{} as never,
					{} as never,
				);
				expect(response.status).toBe(301);
				expect(response.headers.get("Location")).toBe(
					`https://tedix.dev${target}`,
				);
				expect(response.body).toBeNull();
			}
			expect(mocks.getSiteByAlias).not.toHaveBeenCalled();
			expect(mocks.getSiteBySlug).not.toHaveBeenCalled();
			expect(mocks.permit).not.toHaveBeenCalled();
		},
	);

	it("uses the configured legacy hostname", async () => {
		const response = await cmsRuntime.fetch(
			new Request("https://blog.example.com/"),
			{ MARKETING_BLOG_HOST: "blog.example.com" } as never,
			{} as never,
		);
		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe("https://tedix.dev/blog/");
	});

	it("rejects writes even if the old host is listed as a marketing domain", async () => {
		const response = await cmsRuntime.fetch(
			new Request("https://blog.tedix.dev/api/contact", { method: "POST" }),
			{
				MARKETING_DOMAINS: "blog.tedix.dev",
				MARKETING_SITE_SLUG: "tedix-landing",
			} as never,
			{} as never,
		);
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET, HEAD");
		expect(mocks.getSiteBySlug).not.toHaveBeenCalled();
	});
});

describe("early public restore gate", () => {
	it("overlaps fresh metadata reads and still refuses content behind a closed fence", async () => {
		let resolveSite!: (site: {
			id: string;
			slug: string;
			restoreEpoch: number;
		}) => void;
		let resolveBundle!: (bundle: null) => void;
		mocks.getSiteBySlug.mockReturnValue(
			new Promise((resolve) => {
				resolveSite = resolve;
			}),
		);
		mocks.getBundle.mockReturnValue(
			new Promise((resolve) => {
				resolveBundle = resolve;
			}),
		);
		const loader = vi.fn();
		const response = cmsRuntime.fetch(
			new Request("https://tenant.cms.tedix.dev/"),
			{
				PLATFORM_DB: {},
				ENVIRONMENT: "production",
				LOADER: { get: loader },
			} as never,
			{} as never,
		);
		await vi.waitFor(() => {
			expect(mocks.getSiteBySlug).toHaveBeenCalledTimes(1);
			expect(mocks.getBundle).toHaveBeenCalledTimes(1);
		});
		expect(mocks.permit).not.toHaveBeenCalled();
		resolveSite({ id: "site-1", slug: "tenant", restoreEpoch: 7 });
		resolveBundle(null);
		expect((await response).status).toBe(503);
		expect(mocks.permit).toHaveBeenCalledTimes(1);
		expect(loader).not.toHaveBeenCalled();
	});

	it.each([
		"/",
		"/.well-known/security.txt",
		"/_astro/site.js",
		"/_image?href=%2Fhero.png",
		"/_tedix/webmcp/mcp",
		"/_tedix/internal/unrecognized",
	])("checks the exact site before public path %s", async (path) => {
		const response = await cmsRuntime.fetch(
			new Request(`https://tedix.dev${path}`),
			{
				PLATFORM_DB: {},
				MARKETING_DOMAINS: "tedix.dev",
				MARKETING_SITE_SLUG: "tedix-landing",
			} as never,
			{} as never,
		);
		expect(response.status).toBe(503);
		expect(mocks.permit).toHaveBeenCalledWith(
			expect.anything(),
			{ siteId: "site-1", slug: "tedix-landing", restoreEpoch: 7 },
			expect.any(Function),
			expect.objectContaining({
				enter: expect.any(Function),
				leave: expect.any(Function),
			}),
			publicRestorePermitEligible(new Request(`https://tedix.dev${path}`))
				? expect.objectContaining({
						enter: expect.any(Function),
						leave: expect.any(Function),
					})
				: undefined,
			publicRestorePermitEligible(new Request(`https://tedix.dev${path}`))
				? expect.any(Function)
				: undefined,
		);
	});

	it("caches the unversioned public theme while editor requests stay fresh", async () => {
		const cssText = "body { color: red; }";
		const env = {
			PLATFORM_DB: {},
			MARKETING_DOMAINS: "theme.example",
			MARKETING_SITE_SLUG: "theme-site",
			CF_ACCOUNT_ID: "test-account",
			CLOUDFLARE_R2_API_TOKEN: "test-token",
			TENANT_BUNDLES: {
				get: vi.fn(async (key: string) =>
					key.endsWith("current.css")
						? { text: async () => cssText, httpEtag: '"theme-1"' }
						: null,
				),
			},
		} as never;
		mocks.lookupOrg.mockResolvedValue({ slug: "theme-site" });
		mocks.permit.mockImplementation(async (_db, _identity, run) => ({
			admitted: true,
			value: await run(),
		}));
		for (const method of ["GET", "HEAD"]) {
			for (const [query, headers, policy] of [
				["", {}, "public, max-age=60, stale-while-revalidate=300"],
				["?_edit=1", {}, "no-store"],
				["?cb=123", {}, "no-store"],
				["", { Cookie: "session=editor" }, "no-store"],
				["", { Authorization: "Bearer editor" }, "no-store"],
			] as const) {
				const response = await cmsRuntime.fetch(
					new Request(`https://theme.example/_tedix/theme.css${query}`, {
						method,
						headers,
					}),
					env,
					{} as never,
				);
				expect(response.status).toBe(200);
				expect(response.headers.get("Cache-Control")).toBe(policy);
				expect(response.headers.get("ETag")).toBe('"theme-1"');
				expect(await response.text()).toBe(method === "GET" ? cssText : "");
			}
		}
	});

	it.each([null, "body { color: red; }"])(
		"serves warm campaign requests with theme %s and falls through if admission closes",
		async (theme) => {
			const version = theme === null ? "none" : await sha256Hex(theme);
			const url = new URL(
				`https://marketing-${version}.example/warm-cache-proof/`,
			);
			const request = new Request(url);
			const slug = `marketing-${version}`;
			const identity = { siteId: "site-cache-proof", slug, restoreEpoch: 7 };
			let currentTheme = theme;
			const revisions = new Map<string, string>();
			const env = {
				PLATFORM_DB: {},
				MARKETING_DOMAINS: url.hostname,
				MARKETING_SITE_SLUG: slug,
				CF_ACCOUNT_ID: "test-account",
				CLOUDFLARE_R2_API_TOKEN: "test-token",
				TENANT_BUNDLES: {
					head: vi.fn(async () => (theme === null ? null : {})),
					get: vi.fn(async (key: string) =>
						key.endsWith("current.css") && currentTheme !== null
							? { text: async () => currentTheme, httpEtag: '"legacy-theme"' }
							: revisions.has(key)
								? {
										text: async () => revisions.get(key)!,
										httpEtag: '"revision"',
									}
								: null,
					),
					put: vi.fn(async (key: string, text: string) => {
						revisions.set(key, text);
					}),
				},
			} as never;
			const ctx = { waitUntil: vi.fn() } as never;
			mocks.getSiteBySlug.mockResolvedValue({
				id: identity.siteId,
				...identity,
			});
			mocks.getBundle.mockResolvedValue({ version: 1, etag: "bundle-1" });
			mocks.lookupOrg.mockResolvedValue({
				siteId: identity.siteId,
				slug,
				templateSlug: "marketing",
				publicSiteUrl: url.origin,
				publicPathPrefix: null,
				webMcpToolPacks: [],
			});
			mocks.permit.mockImplementation(async (_db, _identity, run) => ({
				admitted: true,
				value: await run(),
			}));
			const key = await pageCacheKey(
				request,
				url,
				{
					...identity,
					bundleVersion: 1,
					bundleEtag: "bundle-1",
					contentRevision: "0",
				},
				"marketing",
			);
			const cache = (caches as unknown as { default: Cache }).default;
			await cache.put(
				key,
				pageCacheEntry(
					new Response(
						'<html><head></head><body><section data-native-lead-attribution="{}">cached page</section></body></html>',
						{
							headers: {
								"Content-Type": "text/html",
								[PAGE_REVISION_HEADER]: pageRevisionFingerprint(
									new Headers(),
									{},
								),
							},
						},
					),
					{ freshSeconds: 1800, staleSeconds: 0 },
					Date.now(),
				),
			);

			try {
				const first = await cmsRuntime.fetch(request, env, ctx);
				expect(first.headers.get("X-Tedix-Page-Cache")).toBe("HIT");
				expect(await first.text()).toContain(`/_tedix/theme.css?v=${version}`);
				expect(mocks.getSiteBySlug).toHaveBeenCalledOnce();

				const tracked = new Request(`${url}?utm_source=test%22%26`);
				const warm = await cmsRuntime.fetch(tracked, env, ctx);
				expect(warm.headers.get("X-Tedix-Page-Cache")).toBe("HIT");
				expect(await warm.text()).toContain(String.raw`test\&quot;&amp;`);
				expect(mocks.getSiteBySlug).toHaveBeenCalledOnce();
				expect(mocks.getBundle).toHaveBeenCalledOnce();
				expect(mocks.sweep).toHaveBeenCalledOnce();

				currentTheme = "body { color: blue; }";
				for (const method of ["GET", "HEAD"]) {
					const css = await cmsRuntime.fetch(
						new Request(new URL(`/_tedix/theme.css?v=${version}`, url), {
							method,
						}),
						env,
						ctx,
					);
					expect(css.status).toBe(200);
					expect(css.headers.get("Cache-Control")).toBe(
						"public, max-age=31536000, immutable",
					);
					expect(await css.text()).toBe(
						method === "HEAD"
							? ""
							: (theme ?? "/* no Tedix hot theme published */\n"),
					);
				}
				const wrongRevision = await cmsRuntime.fetch(
					new Request(new URL(`/_tedix/theme.css?v=${"0".repeat(64)}`, url)),
					env,
					ctx,
				);
				expect(wrongRevision.status).toBe(404);
				expect(wrongRevision.headers.get("Cache-Control")).toBe("no-store");

				mocks.getSiteBySlug.mockClear();
				mocks.permit.mockResolvedValue({ admitted: false });
				const closed = await cmsRuntime.fetch(tracked, env, ctx);
				expect(closed.status).toBe(503);
				expect(await closed.text()).not.toContain("cached page");
				expect(mocks.getSiteBySlug).toHaveBeenCalledOnce();
			} finally {
				await cache.delete(key);
			}
		},
	);

	it("fails closed if the marketing site identity is unavailable", async () => {
		mocks.getSiteBySlug.mockResolvedValue(null);
		const response = await cmsRuntime.fetch(
			new Request("https://tedix.dev/"),
			{
				PLATFORM_DB: {},
				MARKETING_DOMAINS: "tedix.dev",
				MARKETING_SITE_SLUG: "tedix-landing",
			} as never,
			{} as never,
		);
		expect(response.status).toBe(503);
		expect(mocks.permit).not.toHaveBeenCalled();
	});

	it("answers 404, not a restore message, for an unclaimed platform subdomain", async () => {
		mocks.getSiteBySlug.mockResolvedValue(null);
		const response = await cmsRuntime.fetch(
			new Request("https://no-such-site.cms.tedix.dev/"),
			{ PLATFORM_DB: {}, ENVIRONMENT: "production" } as never,
			{} as never,
		);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("CMS site not found");
		expect(mocks.permit).not.toHaveBeenCalled();
	});

	it("passes the marketing slug through the admitted public route", async () => {
		mocks.permit.mockImplementation(async (_db, _identity, run) => ({
			admitted: true,
			value: await run(),
		}));
		const response = await cmsRuntime.fetch(
			new Request("https://tedix.dev/"),
			{
				PLATFORM_DB: {},
				MARKETING_DOMAINS: "tedix.dev",
				MARKETING_SITE_SLUG: "tedix-landing",
			} as never,
			{} as never,
		);
		expect(response.status).toBe(503);
		expect(await response.text()).toContain("missing CF_ACCOUNT_ID");
	});
});

describe("published outage fallback", () => {
	it("serves the last good anonymous page when D1 routing fails, but never an invalidated page", async () => {
		const slug = `fallback-${crypto.randomUUID()}`;
		const request = new Request(`https://${slug}.cms.tedix.dev/`);
		const env = {
			DB_DO: (workerEnv as unknown as { DB_DO: DurableObjectNamespace }).DB_DO,
			PLATFORM_DB: {},
			ENVIRONMENT: "production",
			CMS_INTERNAL_AUTH_TOKEN: "test-fallback-control",
		} as never;
		const tasks: Promise<unknown>[] = [];
		const ctx = {
			waitUntil: (task: Promise<unknown>) => tasks.push(task),
		} as never;
		mocks.getSiteBySlug.mockResolvedValue({
			id: "fallback-site",
			slug,
			restoreEpoch: 0,
		});
		mocks.permit.mockResolvedValue({
			admitted: true,
			value: new Response("last published build", {
				headers: {
					"Content-Type": "text/html",
					"Cache-Control": "public, max-age=0, must-revalidate",
				},
			}),
		});
		expect((await cmsRuntime.fetch(request, env, ctx)).status).toBe(200);
		await Promise.all(tasks);
		mocks.getSiteByAlias.mockRejectedValue(
			new Error(`Failed query: ${"selected-column ".repeat(40)}`, {
				cause: new Error("D1 DB is overloaded. Too many resources consumed"),
			}),
		);
		const response = await cmsRuntime.fetch(request, env, ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get("X-Tedix-Page-Cache")).toBe("OUTAGE");
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.text()).toBe("last published build");
		expect(mocks.permit).toHaveBeenCalledTimes(1);
		const head = await cmsRuntime.fetch(
			new Request(request, { method: "HEAD" }),
			env,
			ctx,
		);
		expect(head.status).toBe(200);
		expect(head.body).toBeNull();
		const control = (authorized: boolean) =>
			cmsRuntime.fetch(
				new Request(`https://cms.internal${PUBLISHED_FALLBACK_ADMIN_PATH}`, {
					method: "POST",
					headers: authorized
						? { Authorization: "Bearer test-fallback-control" }
						: {},
					body: JSON.stringify({ slug, action: "block", token: "lifecycle" }),
				}),
				env,
				ctx,
			);
		expect((await control(false)).status).toBe(401);
		expect((await cmsRuntime.fetch(request, env, ctx)).status).toBe(200);
		expect((await control(true)).status).toBe(200);
		const unavailable = await cmsRuntime.fetch(request, env, ctx);
		expect(unavailable.status).toBe(503);
	});
});
