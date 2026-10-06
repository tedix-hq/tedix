import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	getBySlug: vi.fn(),
	create: vi.fn(),
}));
vi.mock("./marketing-api", () => ({
	getCatalogClient: () => ({ catalog: mocks }),
	getOrganizationServiceClient: () => ({ workItems: { create: mocks.create } }),
}));
import {
	isMarketingContactPath,
	marketingResponse,
	type MarketingEnv,
} from "./marketing";
import { patchReverseProxyHtml, tenantMediaKeyFromHref } from "./index";
const env = {
	MARKETING_DOMAINS: "landing.tedix.dev",
	CLI_DOWNLOAD_HOST: "downloads.tedix.dev",
} as MarketingEnv;
beforeEach(() => vi.clearAllMocks());
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
		["/eurolabs/?ref=a", "https://landing.tedix.dev/EuroLabs?ref=a", 301],
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
		[
			"/posts/mcp-tools-the-api-for-ai-agents/",
			"https://tedix.dev/blog/mcp-tools-the-api-for-ai-agents",
		],
		[
			"/posts/chatgpt-app-discoverability-guide/",
			"https://tedix.dev/blog/how-to-make-your-mcp-app-discoverable",
		],
		["/posts/agentic-commerce/", "https://tedix.dev/blog"],
		["/category/ai-commerce/", "https://tedix.dev/blog"],
		["/", "https://tedix.dev/blog"],
		["/rss.xml", "https://tedix.dev/rss.xml"],
	])("folds blog.tedix.dev%s into tedix.dev", async (path, target) => {
		const r = await marketingResponse(
			new Request("https://blog.tedix.dev" + path),
			env,
		);
		expect(r?.status).toBe(301);
		expect(r?.headers.get("Location")).toBe(target);
	});
	it.each([
		[
			"/_emdash/api/media/file/01KT568RETPJQQ0DM7YXE62BKB.png",
			"/_emdash/api/media/file/01M3HVQ56JFTGGEMT9DWJDBKDY.png",
		],
		[
			"/_emdash/api/media/file/01KT568R52PCBPNDCGWPC0DCAN.png",
			"/_emdash/api/media/file/01M3HVQEFF0NTV62Y7ZDJ41XG4.png",
		],
		[
			"/_emdash/api/media/file/01KT568NFTMTTWEH9TRH8PQYJ5.png",
			"/_emdash/api/media/file/01M3HVQRGJGJF3BESR0J7R08ST.png",
		],
		[
			"/_emdash/api/media/file/01KT568BQTDFCNNSEN1VMWEJG6.png",
			"/_emdash/api/media/file/01M3HVQY8HW7XC122QVNZ1Z53Y.png",
		],
		[
			"/_emdash/api/media/file/brand/default-og.png",
			"/_emdash/api/media/file/01M2Y7CVAQSA2VFR24PBEXQ8VW.png",
		],
		[
			"/_emdash/api/media/file/brand/logo.png",
			"/_emdash/api/media/file/01M2Y7CMEYFS5XYSJG1CYQ71N3.png",
		],
		[
			"/_emdash/api/media/file/brand/favicon.ico",
			"/_tedix/retired-media/blog-favicon.ico",
		],
		[
			"/_emdash/api/media/file/posts/how-to-make-your-mcp-app-discoverable/1777633015682.png",
			"/_emdash/api/media/file/01M3HVR6WN0YKVNFHWMS1NHF2B.png",
		],
		[
			"/_emdash/api/media/file/posts/chatgpt-app-discoverability-guide/1777633011723.png",
			"/_emdash/api/media/file/01M3HNKSHSB2R32QPEYK4691N3.png",
		],
		[
			"/_emdash/api/media/file/posts/mechanics-of-selling-in-chatgpt/1777633007880.png",
			"/_emdash/api/media/file/01M3HNKK9WF5N37CH2GWCTSFVM.png",
		],
		[
			"/_emdash/api/media/file/posts/agentic-commerce/1777633001593.png",
			"/_emdash/api/media/file/01M3HNKC1R1BKMYP2HJBRZCZY7.png",
		],
		[
			"/_emdash/api/media/file/posts/how-brands-can-sell-in-chatgpt/1777632998022.png",
			"/_emdash/api/media/file/01M3HNK5EXQ3MJZKW6W9MPQJSD.png",
		],
		[
			"/_emdash/api/media/file/posts/lead-generation-ai-chats/1777632994219.png",
			"/_emdash/api/media/file/01M3HNJX4ASC79FXZJ57J84JN4.png",
		],
		[
			"/_emdash/api/media/file/posts/mcp-as-a-service-explained-why-model-context-protocol-matters-for-enterprise-ai/1777632989839.png",
			"/_emdash/api/media/file/01M3HNJMTVRSHC13AF4K88DVF8.png",
		],
		[
			"/_emdash/api/media/file/posts/autonomous-ai-agents-architecture-memory-and-skill-learning/1777632983781.png",
			"/_emdash/api/media/file/01M3HVRG9KXQPG1BZMJDYZQ6CT.png",
		],
		[
			"/_emdash/api/media/file/posts/crewai-vs-tedix-vs-langgraph-ai-agent-platform-comparison-2026/1777632979667.png",
			"/_emdash/api/media/file/01M3HVRTRY8APG5N0XV36GS565.png",
		],
	])(
		"redirects preserved media %s to its retained bytes",
		async (path, target) => {
			const response = await marketingResponse(
				new Request(`https://blog.tedix.dev${path}`),
				env,
			);
			expect(response?.status).toBe(301);
			expect(response?.headers.get("Location")).toBe(
				`https://tedix.dev${target}`,
			);
		},
	);
	it("fails closed when the retained favicon bytes are missing or altered", async () => {
		const get = vi
			.fn()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({
				arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
			});
		const faviconEnv = {
			...env,
			TENANT_BUNDLES: { get } as unknown as R2Bucket,
		};
		const request = new Request(
			"https://tedix.dev/_tedix/retired-media/blog-favicon.ico",
		);
		expect((await marketingResponse(request, faviconEnv))?.status).toBe(503);
		expect((await marketingResponse(request, faviconEnv))?.status).toBe(503);
		expect(get).toHaveBeenCalledWith(
			expect.stringMatching(
				/^retired-media\/blog\.tedix\.dev\/[a-f0-9]{64}\.ico$/,
			),
		);
	});
	it("leaves old admin and unlisted media to tenant routing", async () => {
		expect(
			await marketingResponse(
				new Request("https://blog.tedix.dev/_emdash/admin/"),
				env,
			),
		).toBeNull();
		expect(
			await marketingResponse(
				new Request(
					"https://blog.tedix.dev/_emdash/api/media/file/not-in-the-inventory.png",
				),
				env,
			),
		).toBeNull();
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
