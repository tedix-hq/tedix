import { describe, expect, it, vi } from "vite-plus/test";
import {
	buildObjectKey,
	candidateObjectPaths,
	contentTypeFor,
	parseHostAliases,
	responseHeaders,
	resolveSiteSlug,
	isSelectedEntryAlias,
	serveDocsSite,
} from "./serving";

describe("resolveSiteSlug", () => {
	it("maps the apex docs hostname to the configured root site", () => {
		expect(resolveSiteSlug("docs.tedix.dev", "docs.tedix.dev", "tedix")).toBe(
			"tedix",
		);
	});

	it("maps tenant subdomains and rejects nested or unrelated hosts", () => {
		expect(
			resolveSiteSlug("acme.docs.tedix.dev", "docs.tedix.dev", "tedix"),
		).toBe("acme");
		expect(
			resolveSiteSlug("x.acme.docs.tedix.dev", "docs.tedix.dev", "tedix"),
		).toBeNull();
		expect(
			resolveSiteSlug("docs.example.com", "docs.tedix.dev", "tedix"),
		).toBeNull();
	});

	it("maps configured exact host aliases without changing site slugs", () => {
		const aliases = parseHostAliases(
			JSON.stringify({ "help.acme.example": "acme-help" }),
		);
		expect(
			resolveSiteSlug("HELP.ACME.EXAMPLE", "docs.tedix.dev", "tedix", aliases),
		).toBe("acme-help");
	});

	it("rejects malformed host alias configuration", () => {
		expect(() => parseHostAliases("[]")).toThrow(
			"DOCS_HOST_ALIASES must be a JSON object",
		);
		expect(() =>
			parseHostAliases(JSON.stringify({ "docs.example.com": "bad/slug" })),
		).toThrow("Invalid Docs site slug");
	});
});

describe("static object resolution", () => {
	it("resolves clean URLs without accepting traversal", () => {
		expect(candidateObjectPaths("/guide")).toEqual([
			"guide",
			"guide/index.html",
		]);
		expect(candidateObjectPaths("/guide/")).toEqual(["guide/index.html"]);
		expect(candidateObjectPaths("/guide.md")).toEqual([
			"guide.md",
			"guide/index.md",
		]);
		expect(candidateObjectPaths("/readme.md")).toEqual([
			"readme.md",
			"readme/index.md",
		]);
		expect(candidateObjectPaths("/index/index.md")).toEqual([
			"index/index.md",
			"index.md",
		]);
		expect(candidateObjectPaths("/guide/index.md")).toEqual(["guide/index.md"]);
		expect(candidateObjectPaths("/../private")).toEqual([]);
		expect(candidateObjectPaths("/%2e%2e/private")).toEqual([]);
	});

	it("only recognizes the build-selected human entry alias", () => {
		expect(isSelectedEntryAlias("/readme", "/readme")).toBe(true);
		expect(isSelectedEntryAlias("/readme/", "/readme")).toBe(true);
		expect(isSelectedEntryAlias("/readme.md", "/readme")).toBe(false);
		expect(isSelectedEntryAlias("/index", "/readme")).toBe(false);
	});

	it("redirects the selected alias to the human root with its query", async () => {
		const get = vi.fn(async (key: string) =>
			key.endsWith("/manifest.json")
				? { json: async () => ({ entryPath: "/readme" }) }
				: null,
		);
		const response = await serveDocsSite(
			new Request("https://help.example/readme/?from=search"),
			{ get } as unknown as R2Bucket,
			{
				id: "site-1",
				orgSlug: "acme",
				slug: "help",
				status: "active",
				accessMode: "public",
				activeBuildId: "build-1",
				descopeTenantId: null,
			},
		);

		expect(response.status).toBe(308);
		expect(response.headers.get("Location")).toBe(
			"https://help.example/?from=search",
		);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
	});

	it("serves a legacy alias when its manifest has no entry metadata", async () => {
		const html = "<h1>Legacy home</h1>";
		const get = vi.fn(async (key: string) => {
			if (key.endsWith("/manifest.json")) {
				return { json: async () => ({ files: ["index/index.html"] }) };
			}
			if (key.endsWith("/index/index.html")) {
				return {
					body: html,
					httpEtag: '"legacy"',
					writeHttpMetadata(headers: Headers) {
						headers.set("Content-Type", "text/html; charset=utf-8");
					},
				};
			}
			return null;
		});
		const response = await serveDocsSite(
			new Request("https://help.example/index"),
			{ get } as unknown as R2Bucket,
			{
				id: "site-1",
				orgSlug: "acme",
				slug: "help",
				status: "active",
				accessMode: "public",
				activeBuildId: "legacy-build",
				descopeTenantId: null,
			},
		);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe(html);
	});

	it("serves the selected source through its machine Markdown twin", async () => {
		const markdown = "# README";
		const get = vi.fn(async (key: string) => {
			if (key.endsWith("/readme.md")) return null;
			if (key.endsWith("/readme/index.md")) {
				return {
					body: markdown,
					httpEtag: '"markdown"',
					writeHttpMetadata() {},
				};
			}
			return null;
		});
		const response = await serveDocsSite(
			new Request("https://help.example/readme.md"),
			{ get } as unknown as R2Bucket,
			{
				id: "site-1",
				orgSlug: "acme",
				slug: "help",
				status: "active",
				accessMode: "public",
				activeBuildId: "build-1",
				descopeTenantId: null,
			},
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/markdown");
		expect(await response.text()).toBe(markdown);
	});

	it("builds immutable object keys and content types", () => {
		expect(
			buildObjectKey(
				{ id: "site-1", activeBuildId: "build-1" },
				"_astro/app.js",
			),
		).toBe("sites/site-1/builds/build-1/_astro/app.js");
		expect(contentTypeFor("index.html")).toContain("text/html");
		expect(contentTypeFor("font.woff2")).toBe("font/woff2");
	});
});

describe("site cache boundaries", () => {
	const object = {
		httpEtag: '"etag"',
		writeHttpMetadata(headers: Headers) {
			headers.set("Content-Type", "text/html; charset=utf-8");
		},
	};

	it("keeps public assets cacheable", () => {
		const headers = responseHeaders(
			object,
			"_astro/app.js",
			"build-1",
			"public",
		);
		expect(headers.get("Cache-Control")).toBe(
			"public, max-age=31536000, immutable",
		);
		expect(headers.get("X-Robots-Tag")).toBeNull();
	});

	it("makes protected content private and non-indexable", () => {
		const headers = responseHeaders(
			object,
			"_astro/app.js",
			"build-1",
			"organization",
		);
		expect(headers.get("Cache-Control")).toBe("private, no-store");
		expect(headers.get("Vary")).toBe("Cookie, Authorization");
		expect(headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");
	});
});
