import { experimental_AstroContainer as AstroContainer } from "../templates/marketing/node_modules/astro/dist/container/index.js";
import { describe, expect, it } from "vite-plus/test";
import reactRenderer from "../templates/marketing/node_modules/@astrojs/react/dist/server.js";
import NativePageBlock from "../templates/tedix/src/components/NativePageBlock.astro";
import MarketingBlocks from "../templates/marketing/src/components/MarketingBlocks.astro";
import EditorialPortableText from "../templates/marketing/src/components/EditorialPortableText.astro";
import {
	getPortableToc,
	portableToMarkdown,
} from "../templates/marketing/src/lib/portable-content";

const formsLocals = {
	emdash: {
		handlePublicPluginApiRoute: async () => ({
			success: true,
			data: {
				name: "Contact",
				slug: "contact",
				status: "active",
				pages: [
					{
						title: "Contact us",
						fields: [
							{
								id: "email",
								type: "email",
								label: "Email",
								name: "email",
								required: true,
								width: "full",
							},
						],
					},
				],
				settings: { spamProtection: "honeypot", submitLabel: "Send" },
			},
		}),
	},
};

const paragraph = (key: string, text: string, style = "normal") => ({
	_type: "block",
	_key: key,
	style,
	markDefs: [],
	children: [{ _type: "span", _key: `${key}-text`, text, marks: [] }],
});

async function render(
	component: unknown,
	props: Record<string, unknown>,
	locals = {},
) {
	const container = await AstroContainer.create();
	container.addServerRenderer({ renderer: reactRenderer });
	container.addClientRenderer({
		name: "@astrojs/react",
		entrypoint: "@astrojs/react/client.js",
	});
	return container.renderToString(
		component as Parameters<typeof container.renderToString>[0],
		{
			props,
			locals,
			request: new Request("https://example.test/posts/article"),
		},
	);
}

describe("native CMS renderer", () => {
	it("renders retained hero schemas directly in stored order without rewriting nested fields", async () => {
		const html = await render(MarketingBlocks, {
			value: [
				{
					_type: "marketing_hero",
					_version: 1,
					_key: "legacy",
					headline: "Legacy",
					primary_cta_label: "Open legacy",
					primary_cta_url: "/legacy",
					image_url: "https://example.test/legacy.png",
				},
				{
					_type: "marketing_hero",
					_version: 2,
					_key: "native",
					headline: "Native",
					primary_cta_label: "Open native",
					primary_cta_url: "/native",
					image: {
						id: "hero",
						src: "https://example.test/native.png",
						alt: "Hero",
						darkVariant: { id: "dark", src: "https://example.test/dark.png" },
					},
				},
			],
		});
		expect(html.indexOf("Legacy")).toBeLessThan(html.indexOf("Native"));
		expect(html).toContain('href="/legacy"');
		expect(html).toContain('href="/native"');
		expect(html).toContain("legacy.png");
		expect(html).toContain("native.png");
		expect(html).toContain("dark.png");
	});

	it("renders native and retained repeater media and pricing CTA fields", async () => {
		const html = await render(MarketingBlocks, {
			value: [
				{
					_type: "marketing_logo_strip",
					_version: 1,
					_key: "old-logo",
					items: [
						{
							url: "https://example.test/old-logo.svg",
							alt: "Old partner",
							href: "/old-partner",
						},
					],
				},
				{
					_type: "marketing_logo_strip",
					_version: 2,
					_key: "new-logo",
					items: [
						{
							image: {
								id: "logo",
								src: "https://example.test/new-logo.svg",
								alt: "New partner",
							},
							href: "/new-partner",
						},
					],
				},
				{
					_type: "marketing_pricing",
					_version: 1,
					_key: "pricing",
					plans: [
						{
							name: "Plan",
							features: "One\nTwo",
							cta_label: "Choose",
							cta_url: "/choose",
							highlighted: true,
						},
					],
				},
			],
		});
		expect(html).toContain('alt="Old partner"');
		expect(html).toContain('alt="New partner"');
		expect(html).toContain('href="/new-partner"');
		expect(html).toContain('href="/choose"');
		expect(html).toContain("Most popular");
		expect(html).toMatch(/<li[^>]*>One<\/li>/);
	});

	it("keeps prose, plugin embeds, sanitized HTML and isolated frames in native rendering", async () => {
		const html = await render(
			MarketingBlocks,
			{
				value: [
					{
						_type: "marketing_prose",
						_version: 1,
						_key: "prose",
						body: [
							paragraph("intro", "Readable content"),
							{ _type: "emdash-form", _key: "plugin", formId: "contact" },
							{
								_type: "htmlBlock",
								_key: "inline",
								html: "<p>Inline content</p><script>unsafe()</script>",
								isolated: false,
							},
							{
								_type: "htmlBlock",
								_key: "frame",
								html: "<p>Widget content</p>",
								css: "p{color:red}",
								js: "console.log('widget')",
								isolated: true,
							},
							{
								_type: "iframe",
								_key: "iframe",
								src: "https://example.test/embed",
								title: "External frame",
							},
						],
					},
				],
			},
			formsLocals,
		);
		expect(html).toContain("Readable content");
		expect(html).toContain('action="/_emdash/api/plugins/emdash-forms/submit"');
		expect(html).toContain('name="email"');
		expect(html).toContain("Inline content");
		expect(html).not.toContain("unsafe()");
		expect(html).toContain("Widget content");
		expect(html).toContain("sandbox=");
		expect(html).toContain('src="https://example.test/embed"');
	});

	it("uses the same native form renderer in the editorial starter prose", async () => {
		const html = await render(
			NativePageBlock,
			{
				value: {
					_type: "marketing_prose",
					_version: 1,
					_key: "editorial-prose",
					body: [{ _type: "emdash-form", _key: "contact", formId: "contact" }],
				},
			},
			formsLocals,
		);
		expect(html).toContain('data-form-id="contact"');
		expect(html).toContain('name="email"');
	});

	it("preserves localized FAQ markup while skipping malformed retained items", async () => {
		const html = await render(EditorialPortableText, {
			faqHeading: "Questions",
			value: [
				{
					_type: "faq",
					_key: "questions",
					items: [
						{ question: "  Can I edit?  ", answer: "  Yes.  " },
						{ question: 42, answer: "Malformed" },
					],
				},
			],
		});
		expect(html).toContain("Questions</h2>");
		expect(html).toContain('class="emdash-faq-item"');
		expect(html).toContain("Can I edit?</summary>");
		expect(html).not.toContain("Malformed");
	});

	it("preserves native edit metadata and renders an authenticated inline editor", async () => {
		const value = [paragraph("editable", "Draft content")];
		const metadata = { collection: "posts", id: "post-id", field: "content" };
		Object.defineProperty(value, Symbol.for("__emdash"), { value: metadata });
		const html = await render(EditorialPortableText, { value });
		expect(html).toContain("astro-island");
		expect(html).toContain("InlinePortableTextEditor");
		expect(html).toContain("post-id");
		expect(
			Object.getOwnPropertyDescriptor(value, Symbol.for("__emdash"))?.value,
		).toBe(metadata);
	});

	it("keeps duplicate-aware article heading anchors aligned with its existing TOC and Markdown export", async () => {
		const value = [
			paragraph("blank", "", "h2"),
			paragraph("first", "Same heading", "h2"),
			paragraph("second", "Same heading", "h3"),
			paragraph("body", "Body"),
		];
		const html = await render(EditorialPortableText, { value });
		for (const heading of getPortableToc(value))
			expect(html).toContain(`id="${heading.id}"`);
		expect(getPortableToc(value).map((heading) => heading.id)).toEqual([
			"same-heading",
			"same-heading-2",
		]);
		expect(
			portableToMarkdown(value, {
				origin: "https://example.test",
				faqHeading: "FAQ",
			}),
		).toContain("## Same heading");
		expect(value[0]).not.toHaveProperty("id");
	});
});
