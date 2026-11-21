import {
	createPublicPageContext,
	generateBaseSeoContributions,
	resolvePageMetadata,
} from "emdash/page";
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
		expect(
			contributions.some(
				(entry) => entry.graph?.["@type"] === "SoftwareApplication",
			),
		).toBe(false);
	});
});

describe("Tedix public structured data", () => {
	it("renders the same Organization on the homepage, landing pages, blog and posts", async () => {
		const siteUrl = "https://tedix.dev";
		const orgId = `${siteUrl}/#organization`;
		const websiteId = `${siteUrl}/#website`;
		const description =
			"Share connections, systems and knowledge across a unified infrastructure layer. Build your AI stack once, and every department and subsidiary can use it.";
		getSiteSettings.mockResolvedValue({
			title: "CMS site",
			url: siteUrl,
			logo: "/old-logo.png",
			tagline: "Old description",
		});
		const ctx = {
			content: {
				get: async () => ({
					data: {
						bylines: [
							{
								byline: {
									displayName: "Alex Example",
									bio: "CEO at Tedix. Building autonomous AI workers for teams.",
								},
							},
						],
					},
				}),
			},
		};
		for (const [path, expectedTypes] of [
			["/", ["Organization", "WebSite", "SoftwareApplication", "WebPage"]],
			[
				"/privacy/",
				["Organization", "WebSite", "SoftwareApplication", "WebPage"],
			],
			["/apps/", ["Organization", "WebSite", "SoftwareApplication"]],
			["/apps/example/", ["Organization", "WebSite"]],
			["/blog/", ["Organization", "WebSite", "CollectionPage"]],
			[
				"/blog/example/",
				["Organization", "WebSite", "BlogPosting", "BreadcrumbList", "Person"],
			],
		] as const) {
			const isPost = path === "/blog/example/";
			const page = createPublicPageContext({
				kind: isPost ? "content" : "custom",
				url: `${siteUrl}${path}`,
				canonical: `${siteUrl}${path}`,
				siteUrl: `${siteUrl}/`,
				siteName: "CMS site",
				title: "Example title",
				description: "Page-specific description",
				image: "/page.png",
				...(isPost && {
					content: { collection: "posts", id: "post-1" },
					articleMeta: {
						publishedTime: "2026-11-17T08:10:00+01:00",
						modifiedTime: "2026-11-18 07:18:01",
					},
				}),
			});
			const resolved = resolvePageMetadata([
				...(await seoAeo.hooks["page:metadata"]({ page }, ctx)),
				...generateBaseSeoContributions(page),
			]);
			expect(resolved.links.filter((link) => link.hreflang)).toEqual(
				isPost
					? []
					: [{ rel: "alternate", hreflang: "en", href: page.canonical }],
			);
			if (path === "/apps/example/") {
				const hidden = resolvePageMetadata(
					await seoAeo.hooks["page:metadata"](
						{ page: { ...page, seo: { robots: "noindex, nofollow" } } },
						ctx,
					),
				);
				expect(hidden.links.filter((link) => link.hreflang)).toEqual([]);
			}
			const graphs = resolved.jsonld.map(({ json }) => JSON.parse(json));
			expect(
				graphs.map((graph) => graph["@type"]),
				path,
			).toEqual(expectedTypes);
			expect(graphs[0]).toMatchObject({
				"@id": orgId,
				name: "Tedix",
				logo: {
					"@type": "ImageObject",
					url: `${siteUrl}/images/tedi-astronaut-waving.png`,
				},
				description,
			});
			expect(graphs[1]).toMatchObject({
				"@id": websiteId,
				description,
				publisher: { "@id": orgId },
				potentialAction: {
					target: { urlTemplate: `${siteUrl}/apps?q={search_term_string}` },
				},
			});
			if (path === "/" || path === "/privacy/") {
				expect(graphs[2]).toMatchObject({
					"@id": `${siteUrl}/#softwareapplication`,
					description,
					publisher: { "@id": orgId },
					provider: { "@id": orgId },
				});
				expect(graphs[3]).toMatchObject({
					"@id": `${siteUrl}${path}#webpage`,
					description: "Page-specific description",
					isPartOf: { "@id": websiteId },
					about: { "@id": orgId },
					primaryImageOfPage: { url: `${siteUrl}/page.png` },
				});
			}
			if (isPost) {
				expect(graphs[2]).toMatchObject({
					publisher: { "@id": orgId },
					datePublished: "2026-11-17T07:10:00.000Z",
					dateModified: "2026-11-18T07:18:01.000Z",
				});
				expect(graphs[4]).toMatchObject({
					description: "CEO at Tedix. Building AI agents for teams.",
					worksFor: { "@id": orgId },
				});
			}
		}
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

describe("FAQPage structured data", () => {
	it("derives FAQPage from a native marketing FAQ section on a marketing page", async () => {
		getSiteSettings.mockResolvedValue({ title: "GarageDesk" });
		const contributions = await metadata(
			{
				page: {
					pageType: "website",
					path: "/pricing",
					url: "https://garage.example.test/pricing",
					canonical: "https://garage.example.test/pricing",
					siteUrl: "https://garage.example.test",
					siteName: "GarageDesk",
					content: { collection: "pages", id: "pricing" },
				},
			},
			{
				site: { name: "GarageDesk" },
				kv: { get: vi.fn() },
				content: {
					get: vi.fn(async () => ({
						data: {
							content: [
								{ _type: "marketing_hero", _version: 1, headline: "Plans" },
								{
									_type: "marketing_faq",
									_version: 1,
									items: [
										{ question: "Is there a trial?", answer: "Yes, 14 days." },
									],
								},
							],
						},
					})),
				},
			},
		);
		expect(
			contributions.find((entry) => entry.id === "tedix-seo-aeo:faq")?.graph,
		).toMatchObject({
			"@type": "FAQPage",
			mainEntity: [
				{
					"@type": "Question",
					name: "Is there a trial?",
					acceptedAnswer: { "@type": "Answer", text: "Yes, 14 days." },
				},
			],
		});
	});
});
