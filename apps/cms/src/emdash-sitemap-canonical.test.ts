import { readdirSync, readFileSync } from "node:fs";
import { settingsUpdateBody } from "emdash/api/schemas";
import { describe, expect, it } from "vite-plus/test";
import { CMS_PROXY_TOOL_SCHEMAS } from "./agent/cms-proxy-schemas";

// Exercise the installed, patched endpoint while substituting its runtime services.
const source = readFileSync(
	new URL(
		"../templates/tedix/node_modules/emdash/dist/astro/routes/sitemap-_collection_.xml.mjs",
		import.meta.url,
	),
	"utf8",
);
const loadEndpoint = new Function(
	"handleSitemapData",
	"getSiteSettingsWithDb",
	"getPublicSiteUrl",
	"resolveLocalizedContentRoutePath",
	"getI18nConfig",
	"isI18nEnabled",
	"buildSeoImageUrl",
	"virtualConfig",
	"parseCollectionSitemapName",
	source
		.replace(/^import .*;$/gm, "")
		.replace(/^export .*;$/gm, "")
		.replaceAll("import.meta.env.BASE_URL", '"/"') + "\nreturn GET;",
);

async function sitemap(canonical: string | null) {
	const entry = {
		id: "home",
		slug: "home",
		locale: "en",
		translationGroup: "home-group",
		updatedAt: "2026-10-04T09:00:00Z",
		canonical,
	};
	const get = loadEndpoint(
		async () => ({
			success: true,
			data: {
				collections: [
					{
						collection: "pages",
						urlPattern: "/{slug}",
						entries: [entry],
						translations: [],
					},
				],
			},
		}),
		async () => ({ url: "https://personal.example" }),
		() => "https://personal.example",
		async () => "/home",
		() => ({ defaultLocale: "en", locales: ["en"] }),
		() => true,
		() => "",
		{},
		(name: string) => ({ collection: name, page: 1 }),
	);
	return get({
		params: { collection: "pages" },
		locals: { emdash: { db: {} } },
		url: new URL("https://personal.example/sitemap-pages.xml"),
	});
}

describe("Native sitemap canonical overrides", () => {
	it("uses the homepage canonical in loc and hreflang instead of its collection slug", async () => {
		const response = await sitemap("https://personal.example/");
		expect(response.headers.get("X-EmDash-Sitemap-Canonical")).toBe("1");
		const xml = await response.text();
		expect(xml).toContain("<loc>https://personal.example/</loc>");
		expect(xml).toContain('href="https://personal.example/"');
		expect(xml).not.toContain("https://personal.example/home");
	});
	it("preserves trailing slashes in explicit canonical URLs", async () => {
		expect(
			await (await sitemap("https://personal.example/writing/")).text(),
		).toContain("<loc>https://personal.example/writing/</loc>");
	});
	it("preserves native collection routing without an override", async () => {
		expect(await (await sitemap(null)).text()).toContain(
			"<loc>https://personal.example/home</loc>",
		);
	});
	it("falls back to native collection routing for an invalid canonical", async () => {
		expect(await (await sitemap("https://[")).text()).toContain(
			"<loc>https://personal.example/home</loc>",
		);
	});
	it("excludes an externally canonicalized page from this site's sitemap", async () => {
		expect(
			await (await sitemap("https://other.example/")).text(),
		).not.toContain("<loc>");
	});
});

// The bundler hashes this chunk's name, so locate it per EmDash release.
const emdashDist = new URL("../node_modules/emdash/dist/", import.meta.url);
const hreflangChunk = readdirSync(emdashDist).find((name) =>
	/^hreflang-[\w-]+\.mjs$/.test(name),
);
if (!hreflangChunk) throw new Error("EmDash hreflang chunk not found");
const hreflangSource = readFileSync(new URL(hreflangChunk, emdashDist), "utf8");
const loadHreflang = new Function(
	"ContentRepository",
	"getCollectionInfoWithDb",
	"resolveLocalizedContentRoutePath",
	"isI18nEnabled",
	"getI18nConfig",
	"withBasePath",
	hreflangSource
		.replace(/^import .*;$/gm, "")
		.replace(/^export .*;$/gm, "")
		.replaceAll("import.meta.env.BASE_URL", '"/"') +
		"\nreturn getHreflangAlternatesWithDb;",
);

async function alternates(seo: Array<Record<string, unknown>>) {
	const variants = ["en", "de"].map((locale) => ({
		id: locale,
		slug: "home",
		locale,
		status: "published",
		translationGroup: "home",
	}));
	const query = {
		select: () => query,
		where: () => query,
		execute: async () => seo,
	};
	const get = loadHreflang(
		class {
			findByIdOrSlug = async () => variants[0];
			findTranslations = async () => variants;
		},
		async () => ({ urlPattern: "/{slug}" }),
		async ({ locale }: { locale: string }) =>
			locale === "en" ? "/home" : "/de/home",
		() => true,
		() => ({ defaultLocale: "en" }),
		(url: string) => url,
	);
	return get({ selectFrom: () => query }, "pages", "en", {
		siteUrl: "https://personal.example",
	});
}

describe("Native hreflang canonical overrides", () => {
	it("uses each published variant's SEO canonical, matching the sitemap", async () => {
		expect(
			await alternates([
				{ content_id: "en", seo_canonical: "https://personal.example/" },
				{ content_id: "de", seo_canonical: "/de/" },
			]),
		).toEqual([
			{ hreflang: "de", href: "https://personal.example/de/" },
			{ hreflang: "en", href: "https://personal.example/" },
			{ hreflang: "x-default", href: "https://personal.example/" },
		]);
	});

	it("excludes noindex and externally canonicalized variants", async () => {
		expect(await alternates([{ content_id: "en", seo_no_index: 1 }])).toEqual(
			[],
		);
		expect(
			await alternates([
				{ content_id: "de", seo_canonical: "https://other.example/" },
			]),
		).toEqual([
			{ hreflang: "en", href: "https://personal.example/home" },
			{ hreflang: "x-default", href: "https://personal.example/home" },
		]);
	});
});

const indexSource = readFileSync(
	new URL(
		"../node_modules/emdash/dist/astro/routes/sitemap.xml.mjs",
		import.meta.url,
	),
	"utf8",
);
const loadIndex = new Function(
	"handleSitemapIndexData",
	"getSiteSettingsWithDb",
	"getPublicSiteUrl",
	indexSource
		.replace(/^import .*;$/gm, "")
		.replace(/^export .*;$/gm, "")
		.replaceAll("import.meta.env.BASE_URL", '"/"') + "\nreturn GET;",
);

it("keeps native collection sitemaps and lists configured children once without unsafe URLs", async () => {
	const get = loadIndex(
		async () => ({
			success: true,
			data: {
				sitemaps: [{ collection: "pages", page: 1, lastmod: "2026-11-21" }],
			},
		}),
		async () => ({
			seo: {
				additionalSitemaps: [
					"/sitemap-apps.xml",
					"/sitemap-apps.xml",
					"/sitemap-pages.xml",
					"https://other.example/sitemap.xml",
					"/sitemap.xml",
					"/sitemap-x.xml?bad=1",
				],
			},
		}),
		() => "https://personal.example",
	);
	const response = await get({
		locals: { emdash: { db: {} } },
		url: new URL("https://personal.example/sitemap.xml"),
	});
	expect(response.status).toBe(200);
	const xml = await response.text();
	expect(xml.match(/<loc>[^<]+<\/loc>/g)).toEqual([
		"<loc>https://personal.example/sitemap-pages.xml</loc>",
		"<loc>https://personal.example/sitemap-apps.xml</loc>",
	]);
	expect(xml).toContain("<lastmod>2026-11-21</lastmod>");
});

it("retains custom child settings through the CMS proxy and native write validation", () => {
	const input = { seo: { additionalSitemaps: ["/sitemap-catalog.xml"] } };
	const proxied = CMS_PROXY_TOOL_SCHEMAS.settings_update.input.parse(input);
	expect(settingsUpdateBody.parse(proxied)).toEqual(input);
	expect(
		settingsUpdateBody.safeParse({
			seo: { additionalSitemaps: ["https://other.example/sitemap.xml"] },
		}).success,
	).toBe(false);
});
