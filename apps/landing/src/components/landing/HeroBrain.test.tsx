import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { HeroBrain } from "./HeroBrain";

function withSiteTheme(dark: boolean) {
	globalThis.document = {
		documentElement: { classList: { contains: () => dark } },
	} as unknown as Document;
}

describe("HeroBrain", () => {
	afterEach(() => {
		Reflect.deleteProperty(globalThis, "document");
	});

	it("loads only the light image, responsive and high priority, for the light site theme", () => {
		withSiteTheme(false);
		const html = renderToStaticMarkup(<HeroBrain variant="mobile" />);

		expect(html.match(/<img/g)).toHaveLength(1);
		expect(html).not.toContain("prefers-color-scheme");
		expect(html).toContain("hero-brain-light-480.avif 480w");
		expect(html).toContain("hero-brain-light-480.webp 480w");
		expect(html).not.toMatch(/hero-brain-\d/);
		expect(html).toContain('fetchPriority="high"');
		expect(html).toContain(
			'sizes="(max-width: 1023px) min(118vw, 560px), (max-width: 1360px) 70vw, 900px"',
		);
	});

	it("loads only the dark image when the site theme is dark, whatever the OS setting", () => {
		withSiteTheme(true);
		const html = renderToStaticMarkup(<HeroBrain variant="mobile" />);

		expect(html).toContain("hero-brain-480.avif 480w");
		expect(html).toContain('src="/images/hero-brain.jpg"');
		expect(html).not.toContain("hero-brain-light");
	});
});
