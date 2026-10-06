import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Slider } from "./slider";

describe("Kumo Slider adapter", () => {
	it("renders a labelled slider with track, indicator, and thumb slots", () => {
		const html = renderToStaticMarkup(
			<Slider ariaLabel="Contrast" min={0} max={100} value={50} />,
		);

		expect(html).toContain('data-slot="slider"');
		expect(html).toContain('data-slot="slider-track"');
		expect(html).toContain('data-slot="slider-indicator"');
		expect(html).toContain('data-slot="slider-thumb"');
		expect(html).toContain('aria-label="Contrast"');
	});
});
