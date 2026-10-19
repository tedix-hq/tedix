import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Meter } from "./meter";

describe("Kumo Meter adapter", () => {
	it.each([0, 35, 100])("names a bounded reading at %s percent", (value) => {
		const html = renderToStaticMarkup(
			<Meter label="Daily token capacity used" value={value} />,
		);

		expect(html).toContain('role="meter"');
		expect(html).toContain('aria-label="Daily token capacity used"');
		expect(html).toContain('aria-valuemin="0"');
		expect(html).toContain('aria-valuemax="100"');
		expect(html).toContain(`aria-valuenow="${value}"`);
		expect(html).toContain(`aria-valuetext="${value}%"`);
	});

	it("names a dense reading before its hidden caption mounts", () => {
		const html = renderToStaticMarkup(
			<Meter hideLabel label="Trace proof coverage" value={65} />,
		);

		expect(html).toContain('role="meter"');
		expect(html).toContain('aria-label="Trace proof coverage"');
		expect(html).toContain('aria-valuetext="65%"');
		expect(html).not.toContain('role="progressbar"');
	});
});
