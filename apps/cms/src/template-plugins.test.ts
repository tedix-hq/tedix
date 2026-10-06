import type {
	ContentPublishStateChangeEvent,
	PluginContext,
} from "emdash/plugin";
import { describe, expect, it, vi } from "vite-plus/test";

import newsletter from "../templates/tedix/src/plugins/emdash-newsletter/index";
import pageSearch, {
	projectPageSearchText,
} from "../templates/tedix/src/plugins/tedix-page-search/index";
import tediBridge from "../templates/tedix/src/plugins/tedix-tedi-bridge/index";

vi.mock("cloudflare:workers", () => ({ env: { ORG_SLUG: "acme" } }));
vi.mock("emdash", () => ({
	getCollectionInfo: async () => ({ urlPattern: "/blog/{slug}" }),
}));

describe("tedix-page-search native block projection", () => {
	const content = [
		{
			_type: "marketing_hero",
			_version: 1,
			_key: "hero-1",
			headline: "  Agents you can hold accountable. ",
			subheadline: "Proof before claims.",
			primary_cta_label: "Request access",
			primary_cta_url: "https://tedix.dev/contact",
		},
		{
			_type: "marketing_prose",
			_version: 1,
			_key: "prose-1",
			body: [
				{
					_type: "block",
					children: [{ _type: "span", text: "One  verified\n change." }],
					markDefs: [{ _type: "link", href: "https://example.com/internal" }],
				},
			],
		},
		{
			_type: "marketing_faq",
			_version: 1,
			_key: "faq-1",
			items: [
				{ question: "Who approves?", answer: "An independent reviewer." },
			],
		},
	];

	it("indexes visible block copy in order without URLs or block metadata", () => {
		expect(projectPageSearchText(content)).toBe(
			"Agents you can hold accountable.\nProof before claims.\nRequest access\nOne verified change.\nWho approves?\nAn independent reviewer.",
		);
	});

	it("indexes native image descriptions without media or tool metadata", () => {
		const nativeContent = [
			{
				_type: "marketing_hero",
				_version: 2,
				headline: "A visible headline",
				image: {
					id: "private-media-id",
					provider: "local",
					filename: "private-image.jpg",
					blurhash: "private-blurhash",
					meta: { storageKey: "private-storage-key" },
					alt: "A useful image description",
					caption: "A useful caption",
					completionEvidence: { toolName: "media_to_field_value" },
				},
			},
			{
				_type: "marketing_logo_strip",
				_version: 2,
				items: [
					{
						image: {
							id: "",
							provider: "external",
							src: "https://example.com/logo.svg",
							alt: "Partner logo",
						},
						href: "https://example.com",
					},
				],
			},
			{
				_type: "marketing_testimonials",
				_version: 2,
				items: [
					{
						avatar: { id: "avatar-id", alt: "Author portrait" },
						quote: "A visible testimonial",
					},
				],
			},
		];

		expect(projectPageSearchText(nativeContent)).toBe(
			"A visible headline\nA useful image description\nA useful caption\nPartner logo\nAuthor portrait\nA visible testimonial",
		);
	});

	it("updates the projection on a partial pages content save", async () => {
		const result = await pageSearch.hooks["content:beforeSave"].handler({
			collection: "pages",
			content: { content, search_text: "stale" },
			isNew: false,
		});
		expect(result).toEqual({
			content,
			search_text: projectPageSearchText(content),
		});
		expect(pageSearch.hooks["content:beforeSave"].errorPolicy).toBe("abort");
	});

	it("leaves unrelated fields and collections untouched and clears removed blocks", async () => {
		const hook = pageSearch.hooks["content:beforeSave"].handler;
		expect(
			await hook({
				collection: "pages",
				content: { title: "Updated" },
				isNew: false,
			}),
		).toBeUndefined();
		expect(
			await hook({ collection: "posts", content: { content }, isNew: false }),
		).toBeUndefined();
		expect(
			await hook({
				collection: "pages",
				content: { content: [] },
				isNew: false,
			}),
		).toEqual({ content: [], search_text: "" });
	});

	it("rejects malformed pages.content instead of keeping a stale index", async () => {
		await expect(
			pageSearch.hooks["content:beforeSave"].handler({
				collection: "pages",
				content: { content: null },
				isNew: false,
			}),
		).rejects.toThrow("pages.content must be an array");
		await expect(
			pageSearch.hooks["content:beforeSave"].handler({
				collection: "pages",
				content: { search_text: "manual edit" },
				isNew: false,
			}),
		).rejects.toThrow("pages.search_text is derived from pages.content");
	});
});

describe("tedix-tedi-bridge publish hook", () => {
	it("learns the published event.content item with grouped taxonomies", async () => {
		const requests: Array<{ input: string; init?: RequestInit }> = [];
		const termCalls: unknown[][] = [];
		const settings = new Map<string, unknown>([
			["settings:tedi.platformApiUrl", "https://platform.example/"],
			["settings:tedi.platformApiKey", "sk_test"],
			["settings:tedi.id", "tedi-1"],
			["settings:tedi.domain", "release-notes"],
			["settings:tedi.collections", "posts, updates"],
		]);
		const ctx = {
			http: {
				fetch: async (input: string, init?: RequestInit) => {
					requests.push({ input, init });
					return Response.json({ json: {} });
				},
			},
			kv: { get: async (key: string) => settings.get(key) },
			taxonomies: {
				getEntryTerms: async (...args: unknown[]) => {
					termCalls.push(args);
					return [
						{ taxonomy: "tag", slug: "mcp", label: "MCP" },
						{ taxonomy: "tag", slug: "agents", label: "Agents" },
						{ taxonomy: "category", slug: "product", label: "Product" },
					];
				},
			},
			log: { info: () => {}, warn: () => {} },
		} as unknown as PluginContext;
		const event = {
			collection: "updates",
			content: {
				id: "post-1",
				slug: "july-release",
				locale: "de",
				data: { title: "July release", excerpt: "Strong growth." },
			},
		} as unknown as ContentPublishStateChangeEvent;

		await tediBridge.hooks["content:afterPublish"].handler(event, ctx);

		expect(termCalls).toEqual([["updates", "post-1", { locale: "de" }]]);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.input).toBe(
			"https://platform.example/rpc/memory/learn",
		);
		const headers = new Headers(requests[0]?.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer sk_test");
		const wireBody = JSON.parse(String(requests[0]?.init?.body));
		expect(wireBody.json).toMatchObject({
			content:
				'Published article: "July release" (slug: july-release). Strong growth. Taxonomies: tag: MCP, Agents; category: Product.',
			domain: "release-notes",
			source: "cms://updates/july-release",
			tediId: "tedi-1",
		});
	});
});

describe("emdash-newsletter digest hook", () => {
	it("renders the digest from the published event.content item", async () => {
		const settings = new Map<string, unknown>([
			["settings:newsletter.platformApiKey", "sk_test"],
			["settings:newsletter.platformApiUrl", "https://platform.example"],
		]);
		const bodies: Array<{ json: Record<string, unknown> }> = [];
		const ctx = {
			kv: { get: async (key: string) => settings.get(key) },
			storage: {
				subscribers: {
					query: async () => ({
						items: [
							{
								id: "sub_1",
								data: { email: "reader@example.com", unsubscribeToken: "u1" },
							},
						],
						hasMore: false,
					}),
				},
			},
			http: {
				fetch: async (_url: string, init?: RequestInit) => {
					bodies.push(JSON.parse(String(init?.body)));
					return Response.json({ json: { ok: true } });
				},
			},
			site: { name: "Acme", url: "https://acme.example" },
			url: (path: string) => `https://acme.example${path}`,
			log: { info: () => {}, warn: () => {} },
		} as unknown as PluginContext;
		const event = {
			collection: "posts",
			content: {
				id: "post-1",
				slug: "launch-day",
				data: { title: "Launch day", excerpt: "We shipped." },
			},
		} as unknown as ContentPublishStateChangeEvent;

		await newsletter.hooks["content:afterPublish"].handler(event, ctx);

		expect(bodies).toHaveLength(1);
		expect(bodies[0]?.json).toMatchObject({
			appSlug: "acme",
			subject: "New on Acme: Launch day",
			to: [{ email: "reader@example.com" }],
		});
		expect(String(bodies[0]?.json.text)).toContain(
			"Read more: https://acme.example/blog/launch-day",
		);
	});
});
