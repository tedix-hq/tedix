import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Text } from "./text";

describe("Kumo Text adapter", () => {
	it("defaults to a paragraph and keeps Kumo's `as` polymorphism for the outline", () => {
		const paragraph = renderToStaticMarkup(<Text>Workspace ready</Text>);
		expect(paragraph).toMatch(/^<p/);
		expect(paragraph).toContain('data-slot="text"');
		expect(paragraph).toContain("Workspace ready");

		const heading = renderToStaticMarkup(
			<Text as="h2" role="section" weight="semibold">
				Connections
			</Text>,
		);
		expect(heading).toMatch(/^<h2/);
		expect(heading).toContain("Connections");
	});
});
