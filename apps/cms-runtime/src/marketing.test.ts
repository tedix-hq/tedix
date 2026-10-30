import { SiteRoutingDefinitionSchema } from "@tedix/api-contract/schemas/site-routing";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	getBySlug: vi.fn(),
	create: vi.fn(),
	routing: vi.fn(),
}));
vi.mock("./marketing-api", () => ({
	getCatalogClient: () => ({ catalog: mocks }),
	getOrganizationServiceClient: () => ({ workItems: { create: mocks.create } }),
}));
vi.mock("@tedix/db/queries/site-routing", () => ({
	getSiteRoutingPolicy: mocks.routing,
}));
vi.mock("@tedix/db/client", () => ({ createDbClient: vi.fn(() => ({})) }));
import {
	isMarketingContactPath,
	marketingResponse,
	type MarketingEnv,
} from "./marketing";
import { patchReverseProxyHtml } from "./public-proxy";
import { tenantMediaKeyFromHref } from "./tenant-media";
const env = {
	MARKETING_DOMAINS: "landing.tedix.dev",
	CLI_DOWNLOAD_HOST: "downloads.tedix.dev",
} as MarketingEnv;
const routing = {
	version: 1,
	legacyBlogs: [
		{
			sourceHost: "old.example",
			targetOrigin: "https://new.example",
			indexPath: "/journal",
			feedPath: "/rss.xml",
			postTargets: { article: "article", retired: "article" },
			mediaTargets: {
				"/_emdash/api/media/file/old.png": "/_emdash/api/media/file/new.png",
				"/_emdash/api/media/file/icon.ico": "/retained/icon.ico",
			},
		},
	],
	retainedMedia: [
		{
			host: "new.example",
			path: "/retained/icon.ico",
			key: "retired-media/sample/icon.ico",
			sha256:
				"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
			contentType: "image/x-icon",
		},
	],
};
beforeEach(() => {
	vi.clearAllMocks();
	mocks.routing.mockResolvedValue(routing);
});
describe("path-mounted CMS image variants", () => {
	it("prefixes generated image URLs without rewriting other hosts or double-prefixing", () => {
		const html =
			'<img src="/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fa.jpg&w=640" srcset="/_image?href=a&w=640 640w, /_image?href=a&w=1280 1280w"><a href="https://www.example.com/_image?href=a">image</a><img src="https://other.example/_image?href=a"><img src="/journal/_image?href=a">';
		const patched = patchReverseProxyHtml(html, {
			publicPathPrefix: "/journal",
			publicSiteUrl: "https://www.example.com",
		} as never);
		expect(patched).toContain('src="/journal/_image?href=');
		expect(patched).toContain(", /journal/_image?href=a&w=1280");
		expect(patched).toContain('href="https://www.example.com/journal/_image?');
		expect(patched).toContain('src="https://other.example/_image?');
		expect(patched).not.toContain("/journal/journal/_image");
	});
	it("accepts only the resolved tenant prefix and safe media keys", () => {
		expect(
			tenantMediaKeyFromHref(
				"https://www.example.com/journal/_emdash/api/media/file/a.jpg",
				"/journal",
			),
		).toBe("a.jpg");
		expect(
			tenantMediaKeyFromHref(
				"https://www.example.com/other/_emdash/api/media/file/a.jpg",
				"/journal",
			),
		).toBeNull();
		expect(
			tenantMediaKeyFromHref(
				"/journal/_emdash/api/media/file/../a.jpg",
				"/journal",
			),
		).toBeNull();
	});
});
describe("public marketing adapters", () => {
	it("uses one contact path match for the route and nested restore permit", () => {
		expect(isMarketingContactPath("/api/contact")).toBe(true);
		expect(isMarketingContactPath("/api/contact///")).toBe(true);
		expect(isMarketingContactPath("/api/contact/other")).toBe(false);
	});
	it("serves an RFC 9116 security.txt on marketing hosts", async () => {
		const r = await marketingResponse(
			new Request("https://landing.tedix.dev/.well-known/security.txt"),
			env,
		);
		expect(r?.status).toBe(200);
		expect(r?.headers.get("Content-Type")).toMatch(/^text\/plain/);
		expect(await r?.text()).toContain("Contact: mailto:security@tedix.dev");
	});
	it("redirects /health and answers /health/ with the deployed sha", async () => {
		const r = await marketingResponse(
			new Request("https://landing.tedix.dev/health"),
			{ ...env, GIT_SHA: "abc123" },
		);
		expect(r?.status).toBe(308);
		expect(r?.headers.get("Location")).toBe(
			"https://landing.tedix.dev/health/",
		);
		const tenantEnv = {
			...env,
			MARKETING_SITE_SLUG: "example-marketing",
			GIT_SHA: "abc123",
		};
		const tenantHealth = await marketingResponse(
			new Request("https://example-marketing.cms.tedix.dev/health/"),
			tenantEnv,
		);
		expect(tenantHealth?.status).toBe(200);
		expect(await tenantHealth?.json()).toEqual({
			status: "ok",
			deployedSha: "abc123",
		});
		const staged = await marketingResponse(
			new Request("https://example-marketing.cms.tedix.dev/health?probe=1", {
				method: "HEAD",
				headers: { "X-Tedix-Public-Host": "landing.tedix.dev" },
			}),
			tenantEnv,
		);
		expect(staged?.status).toBe(308);
		expect(staged?.headers.get("Location")).toBe(
			"https://landing.tedix.dev/health/?probe=1",
		);
		expect(
			await marketingResponse(
				new Request("https://customer.cms.tedix.dev/health"),
				tenantEnv,
			),
		).toBeNull();
	});
	it("leaves root icons and share images to the tenant theme", async () => {
		for (const path of ["/favicon.ico", "/og-image.png", "/og-image.jpg"]) {
			expect(
				await marketingResponse(
					new Request(`https://landing.tedix.dev${path}`),
					env,
				),
			).toBeNull();
		}
	});

	it("does not expose services on other CMS tenant hosts", async () => {
		expect(
			await marketingResponse(
				new Request("https://customer.cms.tedix.dev/api/catalog/apps"),
				env,
			),
		).toBeNull();
		expect(mocks.list).not.toHaveBeenCalled();
	});
	it("serves only marketing API adapters on the marketing tenant origin", async () => {
		const tenantEnv = {
			...env,
			MARKETING_SITE_SLUG: "tedix-landing",
		};
		mocks.list.mockResolvedValue({ apps: [], total: 0 });
		const catalog = await marketingResponse(
			new Request(
				"https://tedix-landing.cms.tedix.dev/api/catalog/apps/?search=slack",
			),
			tenantEnv,
		);
		expect(catalog?.status).toBe(200);
		expect(mocks.list).toHaveBeenCalledWith(
			expect.objectContaining({ search: "slack" }),
		);
		const contact = await marketingResponse(
			new Request("https://tedix-landing.cms.tedix.dev/api/contact", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			}),
			tenantEnv,
		);
		expect(contact?.status).toBe(400);
		expect(
			await marketingResponse(
				new Request("https://tedix-landing.cms.tedix.dev/waitlist"),
				tenantEnv,
			),
		).toBeNull();
		expect(
			await marketingResponse(
				new Request("https://customer.cms.tedix.dev/api/contact", {
					method: "POST",
				}),
				tenantEnv,
			),
		).toBeNull();
	});
	it("bounds reads and does not forward arbitrary RPC methods", async () => {
		mocks.list.mockResolvedValue({ apps: [], total: 0 });
		const r = await marketingResponse(
			new Request(
				"https://landing.tedix.dev/api/catalog/apps?limit=10000&offset=-2&healthStatus=healthy&sortBy=evil",
			),
			env,
		);
		expect(r?.status).toBe(200);
		expect(mocks.list).toHaveBeenCalledWith(
			expect.objectContaining({
				limit: 200,
				offset: 0,
				healthStatus: "healthy",
				sortBy: undefined,
			}),
		);
		expect(
			(
				await marketingResponse(
					new Request("https://landing.tedix.dev/api/catalog/delete"),
					env,
				)
			)?.status,
		).toBe(404);
	});
	it("keeps missing app URLs as honest 404s", async () => {
		mocks.getBySlug.mockRejectedValue({ code: "NOT_FOUND" });
		expect(
			(
				await marketingResponse(
					new Request("https://landing.tedix.dev/api/catalog/app?slug=missing"),
					env,
				)
			)?.status,
		).toBe(404);
	});
	it("returns retryable failure when catalog is unavailable", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			mocks.list.mockRejectedValue(
				new Error("buyer@example.com", {
					cause: new TypeError("private request body"),
				}),
			);
			expect(
				(
					await marketingResponse(
						new Request("https://landing.tedix.dev/api/catalog/apps"),
						env,
					)
				)?.status,
			).toBe(503);
			expect(log).toHaveBeenCalledWith({
				component: "cms-runtime",
				event: "cms.marketing_catalog_unavailable",
				exception: { type: "Error", cause: { type: "TypeError" } },
			});
			expect(JSON.stringify(log.mock.calls)).not.toContain("buyer@example.com");
			expect(JSON.stringify(log.mock.calls)).not.toContain(
				"private request body",
			);
		} finally {
			log.mockRestore();
		}
	});
	it("serves deferred public tool details without the rest of the app payload", async () => {
		const tools = [{ id: "tool-example", inputSchema: { type: "object" } }];
		mocks.getBySlug.mockResolvedValue({ tools, name: "Example" });
		const response = await marketingResponse(
			new Request(
				"https://landing.tedix.dev/api/catalog/tools.json?slug=example",
			),
			env,
		);
		expect(response?.status).toBe(200);
		expect(await response?.json()).toEqual(tools);
		expect(mocks.getBySlug).toHaveBeenCalledWith({ slug: "example" });
	});
	it("keeps contact fallbacks while logging failures without intake data", async () => {
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			mocks.create.mockRejectedValue(new Error("buyer@example.com"));
			const requestEnv = {
				...env,
				SESSION: {
					get: vi.fn().mockRejectedValue(new Error("rate-limit token")),
				},
				TEDIX_MARKETING_ORG_ID: "org-1",
				TEDIX_CMO_TEDI_ID: "cmo-1",
				TEDIX_DEMAND_OBJECTIVE_ID: "objective-1",
				TEDIX_DEMAND_PROJECT_ID: "project-1",
				TEDIX_DEMAND_INTAKE_PARENT_ID: "parent-1",
			} as unknown as MarketingEnv;
			const response = await marketingResponse(
				new Request("https://landing.tedix.dev/api/contact", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						email: "buyer@example.com",
						process: "Reconcile weekly supplier exceptions",
						currentOwner: "Operations lead",
						systems: "Email, ERP",
						consent: true,
						website: "",
					}),
				}),
				requestEnv,
			);
			expect(response?.status).toBe(502);
			expect(mocks.create).toHaveBeenCalledOnce();
			expect(log.mock.calls.map(([entry]) => entry.event)).toEqual([
				"cms.marketing_rate_limit_storage_failed",
				"cms.marketing_work_item_capture_failed",
			]);
			expect(JSON.stringify(log.mock.calls)).not.toContain("buyer@example.com");
			expect(JSON.stringify(log.mock.calls)).not.toContain("rate-limit token");
		} finally {
			log.mockRestore();
		}
	});
	it.each([
		["/waitlist/?ref=a", "https://os.tedix.dev/?ref=a", 308],
		["/eurolabs/?ref=a", "https://landing.tedix.dev/EuroLabs/?ref=a", 301],
		["/tedixpay-demo/", "https://landing.tedix.dev/tedixpay/", 301],
		["/docs", "https://docs.tedix.dev/", 301],
		["/docs/getting-started/", "https://docs.tedix.dev/getting-started", 301],
		["/install", "https://downloads.tedix.dev/install.sh", 302],
		["/posts/", "https://landing.tedix.dev/blog", 301],
		["/posts/hello/?x=1", "https://landing.tedix.dev/blog/hello?x=1", 301],
	])("preserves %s redirects", async (path, target, status) => {
		const r = await marketingResponse(
			new Request("https://landing.tedix.dev" + path),
			env,
		);
		expect(r?.status).toBe(status);
		expect(r?.headers.get("Location")).toBe(target);
	});
	it("leaves the canonical EuroLabs page to native Emdash routing", async () => {
		for (const path of ["/EuroLabs", "/EuroLabs/"]) {
			expect(
				await marketingResponse(
					new Request("https://landing.tedix.dev" + path),
					env,
				),
			).toBeNull();
		}
	});
	it("rejects invalid contact requests before platform write", async () => {
		const r = await marketingResponse(
			new Request("https://landing.tedix.dev/api/contact", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			}),
			env,
		);
		expect(r?.status).toBe(400);
		expect(mocks.create).not.toHaveBeenCalled();
	});
	it.each([
		["/posts/article/", "/journal/article"],
		["/posts/retired?source=old", "/journal/article"],
		["/posts/unknown/", "/journal"],
		["/posts/toString", "/journal"],
		["/posts/__proto__", "/journal"],
		["/category/sample/", "/journal"],
		["/", "/journal"],
		["/rss.xml?source=old", "/rss.xml"],
	])(
		"redirects configured blog path %s without forwarding the old query",
		async (path, target) => {
			const response = await marketingResponse(
				new Request(`https://old.example${path}`),
				env,
			);
			expect(response?.status).toBe(301);
			expect(response?.headers.get("Location")).toBe(
				`https://new.example${target}`,
			);
		},
	);
	it.each(["GET", "HEAD"])(
		"redirects only inventoried media for %s",
		async (method) => {
			const response = await marketingResponse(
				new Request(
					"https://old.example/_emdash/api/media/file/old.png?download=1",
					{ method },
				),
				env,
			);
			expect(response?.status).toBe(301);
			expect(response?.headers.get("Location")).toBe(
				"https://new.example/_emdash/api/media/file/new.png",
			);
		},
	);
	it("preserves legacy blog redirect methods and leaves excluded media methods untouched", async () => {
		expect(
			(
				await marketingResponse(
					new Request("https://old.example/posts/article", { method: "POST" }),
					env,
				)
			)?.status,
		).toBe(301);
		expect(
			await marketingResponse(
				new Request("https://old.example/_emdash/api/media/file/old.png", {
					method: "POST",
				}),
				env,
			),
		).toBeNull();
	});
	it.each(["/_emdash/admin/", "/_emdash/api/media/file/unlisted.png"])(
		"leaves excluded path %s to tenant routing",
		async (path) => {
			expect(
				await marketingResponse(new Request(`https://old.example${path}`), env),
			).toBeNull();
		},
	);
	it("does not invent routing when the installation policy is absent", async () => {
		mocks.routing.mockResolvedValue(null);
		expect(
			await marketingResponse(
				new Request("https://old.example/posts/article"),
				env,
			),
		).toBeNull();
		expect(
			await marketingResponse(
				new Request("https://new.example/retained/icon.ico"),
				env,
			),
		).toBeNull();
	});
	it("fails closed when retained bytes are missing or altered", async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({
				arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
			});
		const request = new Request("https://new.example/retained/icon.ico");
		const retainedEnv = {
			...env,
			TENANT_BUNDLES: { get } as unknown as R2Bucket,
		};
		expect((await marketingResponse(request, retainedEnv))?.status).toBe(503);
		expect((await marketingResponse(request, retainedEnv))?.status).toBe(503);
		expect(get).toHaveBeenCalledWith("retired-media/sample/icon.ico");
	});
	it.each(["GET", "HEAD"])(
		"serves verified retained bytes for %s",
		async (method) => {
			const get = vi.fn().mockResolvedValue({
				arrayBuffer: async () => new TextEncoder().encode("abc").buffer,
			});
			const response = await marketingResponse(
				new Request("https://new.example/retained/icon.ico", { method }),
				{ ...env, TENANT_BUNDLES: { get } as unknown as R2Bucket },
			);
			expect(response?.status).toBe(200);
			expect(response?.headers.get("Content-Length")).toBe("3");
			expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
			expect(await response?.text()).toBe(method === "HEAD" ? "" : "abc");
		},
	);
	it("rejects unsupported retained-media methods before reading storage", async () => {
		const get = vi.fn();
		const response = await marketingResponse(
			new Request("https://new.example/retained/icon.ico", { method: "POST" }),
			{ ...env, TENANT_BUNDLES: { get } as unknown as R2Bucket },
		);
		expect(response?.status).toBe(405);
		expect(response?.headers.get("Allow")).toBe("GET, HEAD");
		expect(get).not.toHaveBeenCalled();
	});
	it("serves /blog from the marketing tenant instead of redirecting", async () => {
		expect(
			await marketingResponse(
				new Request("https://landing.tedix.dev/blog"),
				env,
			),
		).toBeNull();
	});
	it.each(["tedix.dev", "www.tedix.dev", "landing.tedix.dev"])(
		"redirects article slash variants on %s directly to the canonical host",
		async (host) => {
			const marketingEnv = {
				...env,
				MARKETING_DOMAINS: "tedix.dev,www.tedix.dev,landing.tedix.dev",
			};
			for (const method of ["GET", "HEAD"]) {
				const redirect = await marketingResponse(
					new Request(`https://${host}/blog/example-post/?ref=source`, {
						method,
					}),
					marketingEnv,
				);
				expect(redirect?.status).toBe(301);
				expect(redirect?.headers.get("Location")).toBe(
					"https://tedix.dev/blog/example-post?ref=source",
				);
			}
			expect(
				await marketingResponse(
					new Request(`https://${host}/blog/example-post`),
					marketingEnv,
				),
			).toBeNull();
		},
	);
});

describe("site routing publication validation", () => {
	it("rejects unsafe destinations and retained storage paths", () => {
		expect(
			SiteRoutingDefinitionSchema.safeParse({ siteRouting: routing }).success,
		).toBe(true);
		for (const targetOrigin of [
			"http://new.example",
			"https://user:password@new.example",
			"https://new.example/path",
			"https://new.example?query=1",
		]) {
			expect(
				SiteRoutingDefinitionSchema.safeParse({
					siteRouting: {
						...routing,
						legacyBlogs: [{ ...routing.legacyBlogs[0], targetOrigin }],
					},
				}).success,
			).toBe(false);
		}
		for (const key of [
			"tenant-bundles/site/main.js",
			"retired-media/../main.js",
			"retired-media/sample/../../main.js",
		]) {
			expect(
				SiteRoutingDefinitionSchema.safeParse({
					siteRouting: {
						...routing,
						retainedMedia: [{ ...routing.retainedMedia[0], key }],
					},
				}).success,
			).toBe(false);
		}
		expect(
			SiteRoutingDefinitionSchema.safeParse({
				siteRouting: {
					...routing,
					retainedMedia: [
						{ ...routing.retainedMedia[0], path: "//other.example/icon.ico" },
					],
				},
			}).success,
		).toBe(false);
		expect(
			SiteRoutingDefinitionSchema.safeParse({
				siteRouting: {
					...routing,
					legacyBlogs: [routing.legacyBlogs[0], routing.legacyBlogs[0]],
				},
			}).success,
		).toBe(false);
	});
});
