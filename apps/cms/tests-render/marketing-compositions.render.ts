import { readFileSync } from "node:fs";
import { experimental_AstroContainer as AstroContainer } from "../templates/marketing/node_modules/astro/dist/container/index.js";
import { describe, expect, it } from "vite-plus/test";
import MarketingBlocks from "../templates/marketing/src/components/MarketingBlocks.astro";
import type { PageContentBlock } from "../templates/marketing/emdash-env.d.ts";

const seed = JSON.parse(
	readFileSync(
		new URL("../templates/marketing/seed/seed.json", import.meta.url),
		"utf8",
	),
) as { sections: Array<{ slug: string; content: PageContentBlock[] }> };

async function render(value: PageContentBlock[]) {
	const container = await AstroContainer.create();
	return container.renderToString(MarketingBlocks, {
		props: { value },
		request: new Request("https://example.test/resources"),
	});
}

describe("marketing compositions", () => {
	it.each([
		["link-directory", "Resources", 'href="/overview"'],
		["founder-profile", "Alex Morgan", 'href="https://example.com"'],
		["research-page", "Research", 'href="https://example.com/research"'],
	])(
		"renders the seeded %s composition through native Blocks",
		async (slug, heading, link) => {
			const section = seed.sections.find(
				(candidate) => candidate.slug === slug,
			);
			expect(section).toBeDefined();
			const html = await render(section!.content);
			expect(html).toMatch(new RegExp(`<h1[^>]*>${heading}</h1>`));
			expect(html).toContain(link);
			if (slug === "founder-profile") {
				expect(html.indexOf("Alex Morgan")).toBeLessThan(
					html.indexOf("Selected work"),
				);
				expect(html).toContain("Building useful tools with a small team.");
			}
			if (slug === "research-page") {
				expect(html).toContain('id="findings"');
				expect(html).toContain("Describe the evidence and its limitations.");
			}
		},
	);

	it("renders edits and row/block reordering without a component change", async () => {
		const value: PageContentBlock[] = [
			{
				_type: "marketing_link_directory",
				_version: 1,
				_key: "resources",
				heading: "Updated resources",
				page_heading: true,
				items: [
					{ title: "Second resource", href: "/second" },
					{ title: "First resource", href: "/first", link_label: "Read this" },
				],
			},
			{
				_type: "marketing_research_section",
				_version: 1,
				_key: "findings",
				heading: "Updated findings",
				links: [{ label: "Updated source", href: "/source" }],
			},
		];
		const html = await render(value);
		expect(html.indexOf("Second resource")).toBeLessThan(
			html.indexOf("First resource"),
		);
		expect(html).toContain('href="/first"');
		expect(html.match(/href="\/first"/g)).toHaveLength(1);
		expect(html).toContain("Read this");
		expect(html).toContain('href="/source"');
		const reordered = await render([...value].reverse());
		expect(reordered.indexOf("Updated findings")).toBeLessThan(
			reordered.indexOf("Updated resources"),
		);
		expect(value.map((block) => block._key)).toEqual(["resources", "findings"]);
	});

	it("renders native portrait, card and research media with stored alt text and captions", async () => {
		const image = {
			id: "image",
			src: "https://example.test/portrait.png",
			alt: "Stored portrait alt",
		};
		const html = await render([
			{
				_type: "marketing_founder_profile",
				_version: 1,
				_key: "profile",
				name: "Sam Lee",
				image,
			},
			{
				_type: "marketing_link_directory",
				_version: 1,
				_key: "links",
				heading: "Work",
				items: [{ title: "Project", href: "/project", image }],
			},
			{
				_type: "marketing_research_section",
				_version: 1,
				_key: "research",
				heading: "Evidence",
				image,
				caption: "Stored caption",
			},
		]);
		expect(html.match(/alt="Stored portrait alt"/g)).toHaveLength(3);
		expect(html).toContain("portrait.png");
		expect(html).toMatch(/<figcaption[^>]*>Stored caption<\/figcaption>/);
		expect(html).not.toContain("undefined");
	});
});
