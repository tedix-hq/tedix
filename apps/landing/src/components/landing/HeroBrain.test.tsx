import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { HeroBrain } from "./HeroBrain";

describe("HeroBrain", () => {
	it("offers one responsive, high-priority image per color scheme", () => {
		const html = renderToStaticMarkup(<HeroBrain variant="mobile" />);

		expect(html.match(/<img/g)).toHaveLength(1);
		expect(html).toContain('media="(prefers-color-scheme: dark)"');
		expect(html).toContain('type="image/avif"');
		expect(html).toContain('type="image/webp"');
		expect(html).toContain("hero-brain-light-480.avif 480w");
		expect(html).toContain("hero-brain-480.avif 480w");
		expect(html).toContain('fetchPriority="high"');
		expect(html).toContain(
			'sizes="(max-width: 1023px) min(118vw, 560px), (max-width: 1360px) 70vw, 900px"',
		);
	});
});
