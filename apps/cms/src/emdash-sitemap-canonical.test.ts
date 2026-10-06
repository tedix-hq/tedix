import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

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
	"getPublicOrigin",
	"resolveLocalizedContentRoutePath",
	"getI18nConfig",
	"isI18nEnabled",
	"buildSeoImageUrl",
	"virtualConfig",
	source.replace(/^import .*;$/gm, "").replace(/^export .*;$/gm, "") +
		"\nreturn GET;",
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
					{ collection: "pages", urlPattern: "/{slug}", entries: [entry] },
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
