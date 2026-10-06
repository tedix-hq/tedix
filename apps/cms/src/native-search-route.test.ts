import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
const native = vi.hoisted(() => ({
	search: vi.fn(),
	getCollectionInfo: vi.fn(),
	getPluginSettings: vi.fn(),
	env: {
		PUBLIC_SITE_URL: "https://site.example",
		PUBLIC_PATH_PREFIX: "",
		DEFAULT_LOCALE: "en",
	},
}));
vi.mock("cloudflare:workers", () => ({ env: native.env }));
vi.mock("emdash", () => ({
	search: native.search,
	getCollectionInfo: native.getCollectionInfo,
	getPluginSettings: native.getPluginSettings,
}));
vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));
vi.mock("virtual:emdash/build", () => ({ buildTime: null }));
vi.mock("virtual:emdash/config", () => ({
	default: { database: {}, migrations: { runtime: "manual", dev: "manual" } },
}));
vi.mock("virtual:emdash/dialect", () => ({
	createDialect: null,
	createCoalescingDialect: null,
	createRequestScopedDb: null,
}));
vi.mock("virtual:emdash/media-providers", () => ({ mediaProviders: [] }));
vi.mock("virtual:emdash/plugins", () => ({ plugins: [] }));
vi.mock("virtual:emdash/sandbox-runner", () => ({
	sandboxEnabled: false,
	sandboxBypassed: false,
	createSandboxRunner: null,
}));
vi.mock("virtual:emdash/sandboxed-plugins", () => ({ sandboxedPlugins: [] }));
vi.mock("virtual:emdash/scheduler", () => ({ createScheduler: null }));
vi.mock("virtual:emdash/storage", () => ({ createStorage: null }));
vi.mock("virtual:emdash/seed", () => ({ seed: null, userSeed: null }));
import { onRequest as installedMiddleware } from "../templates/tedix/node_modules/emdash/dist/astro/middleware.mjs";
import { EmDashRuntime } from "../templates/tedix/node_modules/emdash/dist/plugin-test-runtime.mjs";
import { GET } from "../templates/tedix/src/pages/_tedix/search.json";

const healthy = vi.fn();
async function run(query = "q=body+phrase", user?: unknown) {
	return GET({
		url: new URL(`https://tenant.cms.tedix.dev/_tedix/search.json?${query}`),
		locals: { emdash: { ensureSearchHealthy: healthy }, user },
	} as never);
}
beforeEach(() => {
	vi.clearAllMocks();
	native.env.PUBLIC_PATH_PREFIX = "";
	native.env.DEFAULT_LOCALE = "en";
	native.getPluginSettings.mockResolvedValue({
		policy: { collection: "pages", slugs: ["welcome"], dependencies: [] },
	});
});
describe("native published search URL projection", () => {
	it("serves anonymous search through the installed native middleware without requiring privileged db locals", async () => {
		const create = vi.spyOn(EmDashRuntime, "create").mockResolvedValue({
			collectPageMetadata: vi.fn(),
			collectPageFragments: vi.fn(),
			storage: undefined,
		} as never);
		native.search.mockResolvedValue({ items: [] });
		const url = new URL(
			"https://tenant.cms.tedix.dev/_tedix/search.json?q=body",
		);
		const context = {
			url,
			request: new Request(url),
			locals: {},
			cookies: { get: () => undefined, headers: () => [] },
			isPrerendered: false,
		};
		try {
			const response = await installedMiddleware(context as never, async () => {
				expect(context.locals).toHaveProperty("emdash.collectPageMetadata");
				expect(context.locals).not.toHaveProperty("emdash.db");
				return GET(context as never);
			});
			if (!(response instanceof Response))
				throw new Error("Installed middleware did not return a response");
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ data: { items: [] } });
			expect(native.search).toHaveBeenCalledWith("body", {
				status: "published",
				limit: 10,
			});
		} finally {
			create.mockRestore();
		}
	});
	it("forwards body queries to native published search and uses the collection's blog URL pattern", async () => {
		native.search.mockResolvedValue({
			items: [
				{
					collection: "posts",
					id: "1",
					slug: "native-title",
					locale: "en",
					title: "Body phrase inside an article",
				},
			],
		});
		native.getCollectionInfo.mockResolvedValue({ urlPattern: "/blog/{slug}" });
		const response = await run();
		expect(native.search).toHaveBeenCalledWith("body phrase", {
			status: "published",
			limit: 10,
		});
		expect(await response.json()).toEqual({
			data: {
				items: [
					{
						collection: "posts",
						id: "1",
						slug: "native-title",
						locale: "en",
						title: "Body phrase inside an article",
						url: "https://site.example/blog/native-title",
					},
				],
			},
		});
	});
	it("uses configured homepage policy for the root and preserves secondary locales and a public mount", async () => {
		native.env.PUBLIC_PATH_PREFIX = "/guide";
		native.env.DEFAULT_LOCALE = "de";
		native.search.mockResolvedValue({
			items: [
				{
					collection: "pages",
					id: "2",
					slug: "welcome",
					locale: "de",
					title: "Start",
				},
				{
					collection: "pages",
					id: "3",
					slug: "welcome",
					locale: "en",
					title: "Home",
				},
				{
					collection: "articles",
					id: "4",
					slug: "translation",
					locale: "en",
					title: "Translated",
				},
			],
		});
		native.getCollectionInfo.mockResolvedValue({
			urlPattern: "/guide/read/{slug}",
		});
		const payload = (await (await run()).json()) as any;
		expect(payload.data.items.map((item: any) => item.url)).toEqual([
			"https://site.example/guide/",
			"https://site.example/guide/en/",
			"https://site.example/guide/en/read/translation",
		]);
	});
	it("passes native filters and result limits through and preserves snippets", async () => {
		native.search.mockResolvedValue({
			items: [
				{
					collection: "pages",
					id: "8",
					slug: "welcome",
					locale: "de",
					snippet: "<mark>Native</mark> &amp; searchable",
				},
			],
		});
		const response = await run(
			"q=Native&collections=posts,pages&locale=de&limit=25",
		);
		expect(native.search).toHaveBeenCalledWith("Native", {
			status: "published",
			collections: ["posts", "pages"],
			locale: "de",
			limit: 25,
		});
		expect(((await response.json()) as any).data.items[0].snippet).toBe(
			"<mark>Native</mark> &amp; searchable",
		);
	});
	it("rejects invalid native filter values without running a query", async () => {
		for (const query of [
			"q=test&limit=0",
			"q=test&limit=101",
			"q=test&limit=1.5",
			"q=test&collections=../private",
			"q=test&locale=de%26draft",
			"q=test&collections=",
		]) {
			expect((await run(query)).status).toBe(400);
		}
		expect(native.search).not.toHaveBeenCalled();
	});

	it("rejects a draft-status selector even for an administrator and keeps implicit search published", async () => {
		expect(
			(await run("q=secret&status=draft", { role: "administrator" })).status,
		).toBe(400);
		expect(native.search).not.toHaveBeenCalled();
		native.search.mockResolvedValue({ items: [] });
		await run("q=secret", { role: "administrator" });
		expect(native.search).toHaveBeenCalledWith("secret", {
			status: "published",
			limit: 10,
		});
	});
	it("uses native fallback paths when a collection has no URL pattern and fails closed on native search errors", async () => {
		native.search.mockResolvedValue({
			items: [
				{ collection: "other", id: "5", slug: "safe path", locale: "en" },
			],
		});
		native.getCollectionInfo.mockResolvedValue({});
		expect(((await (await run()).json()) as any).data.items[0].url).toBe(
			"https://site.example/other/safe%20path/",
		);
		native.search.mockRejectedValue(new Error("disabled"));
		expect((await run()).status).toBe(503);
	});
});
