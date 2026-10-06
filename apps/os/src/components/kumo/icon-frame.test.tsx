import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { IconFrame } from "./icon-frame";

describe("Kumo IconFrame adapter", () => {
	it("exposes its size and appearance as data attributes with sensible defaults", () => {
		const defaults = renderToStaticMarkup(
			<IconFrame aria-hidden>Icon</IconFrame>,
		);
		expect(defaults).toContain('data-slot="icon-frame"');
		expect(defaults).toContain('data-size="md"');
		expect(defaults).toContain('data-appearance="outline"');

		const compact = renderToStaticMarkup(
			<IconFrame appearance="fill" size="sm">
				Icon
			</IconFrame>,
		);
		expect(compact).toContain('data-size="sm"');
		expect(compact).toContain('data-appearance="fill"');
	});
});
