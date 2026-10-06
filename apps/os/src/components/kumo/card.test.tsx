import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Card, CardContent, CardDescription, CardTitle } from "./card";

describe("Card", () => {
	it("renders its anatomy on the flat base surface and exposes an explicit raised tone", () => {
		const html = renderToStaticMarkup(
			<Card>
				<CardTitle>Runtime</CardTitle>
				<CardDescription>Current operational state.</CardDescription>
				<CardContent>Operational content</CardContent>
			</Card>,
		);

		expect(html).toContain('data-tone="base"');
		expect(html).toContain("Runtime");
		expect(html).toContain("Current operational state.");
		expect(html).toContain("Operational content");

		expect(renderToStaticMarkup(<Card tone="raised" />)).toContain(
			'data-tone="raised"',
		);
	});
});
