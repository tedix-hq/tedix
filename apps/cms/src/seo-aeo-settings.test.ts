import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import seoAeo from "../templates/tedix/src/plugins/tedix-seo-aeo/index";

const { getSiteSettings } = vi.hoisted(() => ({ getSiteSettings: vi.fn() }));

vi.mock("cloudflare:workers", () => ({
	env: { ORG_SLUG: "garage", SITE_TITLE: "Starter Blog" },
}));
vi.mock("emdash", () => ({
	getCollectionInfo: async () => ({ urlPattern: "/posts/{slug}" }),
	getSiteSettings,
}));

const metadata = seoAeo.hooks["page:metadata"] as unknown as (
	event: { page: Record<string, unknown> },
	ctx: Record<string, unknown>,
) => Promise<Array<{ id: string; graph?: Record<string, unknown> }>>;

describe("Organization metadata", () => {
	beforeEach(() => getSiteSettings.mockReset());

	it("uses native tenant settings ahead of the internal site name", async () => {
		getSiteSettings.mockResolvedValue({
			title: "GarageDesk",
			url: "https://garage.example.test",
			logo: { url: "/_emdash/api/media/file/logo.png" },
			tagline: "Workshop management software",
			social: { linkedin: "https://social.example.test/company/garage" },
		});
		const kvGet = vi.fn();
		const contributions = await metadata(
			{
				page: {
					path: "/",
					url: "https://garage.example.test/",
					canonical: "https://garage.example.test/",
					siteUrl: "https://garage.example.test",
					siteName: "GarageDesk",
					pageType: "website",
				},
			},
			{ site: { name: "Starter Blog" }, kv: { get: kvGet } },
		);
		const organization = contributions.find(
			(entry) => entry.id === "tedix-seo-aeo:identity",
		)?.graph;
		expect(organization).toMatchObject({
			"@type": "Organization",
			name: "GarageDesk",
			url: "https://garage.example.test",
			logo: {
				url: "https://garage.example.test/_emdash/api/media/file/logo.png",
			},
			description: "Workshop management software",
			sameAs: ["https://social.example.test/company/garage"],
		});
		expect(kvGet).not.toHaveBeenCalled();
	});
});

describe("Native graph integration", () => {
	it("connects native article and website graphs to a personal owner without a competing Article", async () => {
		getSiteSettings.mockResolvedValue({
			title: "Alex Example",
			url: "https://personal.example",
			seo: { defaultOgImage: { url: "/portrait.png" } },
		});
		const page = {
			pageType: "article",
			path: "/blog/skills",
			canonical: "https://personal.example/blog/skills",
			url: "https://personal.example/blog/skills",
			siteUrl: "https://personal.example",
			siteName: "Alex Example",
			title: "Skills",
			articleMeta: {
				author: "Alex Example",
				publishedTime: "2026-10-03T12:00:00Z",
			},
			content: { collection: "posts", id: "post-1" },
		};
		const contributions = await metadata(
			{ page },
			{
				settings: { get: async () => "Person" },
				content: {
					get: async () => ({
						data: {
							bylines: [
								{
									byline: {
										displayName: "Alex Example",
										websiteUrl: "https://personal.example/",
									},
								},
							],
						},
					}),
				},
			},
		);
		const graphs = contributions.filter((c) => c.graph).map((c) => c.graph!);
		expect(graphs.filter((g) => g["@type"] === "Article")).toHaveLength(0);
		expect(graphs.filter((g) => g["@type"] === "Organization")).toHaveLength(0);
		const primary = contributions.find((c) => c.id === "primary")!.graph!;
		expect(primary).toMatchObject({
			"@type": "BlogPosting",
			image: "https://personal.example/portrait.png",
			datePublished: "2026-10-03T12:00:00Z",
			publisher: { "@id": "https://personal.example#person" },
			author: {
				"@type": "Person",
				name: "Alex Example",
				url: "https://personal.example/",
			},
		});
		expect(graphs.find((g) => g["@type"] === "WebSite")).toMatchObject({
			"@id": "https://personal.example/#website",
		});
		expect(primary.isPartOf).toEqual({
			"@id": "https://personal.example/#website",
		});
		expect(
			graphs.find(
				(g) => g["@id"] === "https://personal.example/blog/skills#author",
			),
		).not.toHaveProperty("worksFor");
	});
});
