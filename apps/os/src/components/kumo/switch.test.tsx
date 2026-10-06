import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Switch } from "./switch";

describe("Kumo Switch adapter", () => {
	it("renders a named switch reflecting its checked state", () => {
		const html = renderToStaticMarkup(
			<Switch aria-label="Enabled" checked onCheckedChange={() => {}} />,
		);

		expect(html).toContain('role="switch"');
		expect(html).toContain('aria-label="Enabled"');
		expect(html).toContain('aria-checked="true"');
	});
});
