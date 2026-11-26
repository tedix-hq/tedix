import { experimental_AstroContainer as AstroContainer } from "../templates/marketing/node_modules/astro/dist/container/index.js";
import { describe, expect, it, vi } from "vite-plus/test";
import NativePageBlock from "../templates/tedix/src/components/NativePageBlock.astro";

vi.mock(
	"../templates/tedix/node_modules/emdash/src/media/provider-loader.js",
	() => ({
		getMediaProvider: async () => ({
			getEmbed: (image: { id: string }) => ({
				type: "image",
				src: `/images/${image.id}?width=2400`,
				getSrc: ({ width }: { width: number }) =>
					`/images/${image.id}?width=${width}`,
			}),
		}),
	}),
);

const image = (id: string) => ({
	id,
	provider: "responsive-fixture",
	width: 2400,
	height: 800,
	alt: `Stored ${id} alt`,
});
const blocks = [
	{ _type: "marketing_hero", headline: "Image sizing", image: image("hero") },
	{
		_type: "marketing_logo_strip",
		items: [
			{ image: image("linked-logo"), href: "/partner" },
			{ image: image("logo") },
		],
	},
	{ _type: "marketing_cta", headline: "CTA", image: image("cta") },
	{
		_type: "marketing_text_with_image",
		heading: "Split",
		image_side: "left",
		image: image("split"),
	},
	{
		_type: "marketing_testimonials",
		items: [{ quote: "Useful", author: "Sam", avatar: image("avatar") }],
	},
];

async function render(value: Record<string, unknown>, version = 2) {
	const container = await AstroContainer.create();
	return container.renderToString(NativePageBlock, {
		props: { value: { _version: version, _key: value._type, ...value } },
		request: new Request("https://example.test/images"),
	});
}

describe("Tedix native block images", () => {
	it("passes layout sizes through native Image without losing provider variants or alt text", async () => {
		const html = (await Promise.all(blocks.map((block) => render(block)))).join(
			"\n",
		);
		const tags = html.match(/<img\b[^>]*>/g)!;
		expect(tags).toHaveLength(6);
		for (const tag of tags) {
			expect(tag).toMatch(/srcset="[^"]+\?width=640 640w, /);
			expect(tag).toMatch(/alt="Stored [^"]+ alt"/);
		}
		expect(tags[0]).toContain("(min-width: 1152px) 532px");
		expect(tags[0]).toContain("(min-width: 1024px) calc((100vw - 88px) / 2)");
		expect(tags[0]).toContain(
			"(min-width: 768px) calc((100vw - 72px) / 2), calc(100vw - 32px)",
		);
		expect(tags[0]).toContain('loading="eager"');
		expect(tags[0]).toContain('fetchpriority="high"');
		expect(tags[1]).toContain('sizes="144px"');
		expect(tags[2]).toContain('sizes="144px"');
		expect(html).toContain('href="/partner"');
		expect(tags[3]).toContain("(min-width: 1152px) 536px");
		expect(tags[3]).toContain("(min-width: 1024px) calc((100vw - 80px) / 2)");
		expect(tags[3]).toContain("(min-width: 768px) calc((100vw - 64px) / 2)");
		expect(tags[4]).toContain("(min-width: 1152px) 532px");
		expect(tags[4]).toContain("md:order-1");
		expect(tags[5]).toContain('sizes="40px"');
		for (const tag of tags.slice(1)) expect(tag).toContain('loading="lazy"');
	});

	it("retains URL-image v1 blocks and native images without optimization", async () => {
		const html = (
			await Promise.all([
				render({ _type: "marketing_hero", image_url: "/legacy-hero.png" }, 1),
				render(
					{
						_type: "marketing_logo_strip",
						items: [
							{ url: "/legacy-logo.png", alt: "Legacy logo", href: "/partner" },
							{ url: "/legacy-unlinked.png" },
						],
					},
					1,
				),
				render({ _type: "marketing_cta", image_url: "/legacy-cta.png" }, 1),
				render(
					{
						_type: "marketing_text_with_image",
						image_url: "/legacy-split.png",
					},
					1,
				),
				render(
					{
						_type: "marketing_testimonials",
						items: [{ avatar: "/legacy-avatar.png" }],
					},
					1,
				),
				render({
					_type: "marketing_hero",
					image: {
						id: "plain",
						src: "https://example.test/plain.png",
						alt: "Plain image",
					},
				}),
			])
		).join("\n");
		for (const name of ["hero", "logo", "unlinked", "cta", "split", "avatar"]) {
			expect(html).toContain(`src="/legacy-${name}.png"`);
		}
		expect(html).toContain('alt="Legacy logo"');
		expect(html).toContain('src="https://example.test/plain.png"');
		expect(html).toContain('alt="Plain image"');
		expect(html).not.toContain("srcset=");
	});
});
