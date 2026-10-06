import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Kbd } from "./kbd";
import { Label } from "./label";

describe("Kumo compact copy adapters", () => {
	it("renders keyboard hints", () => {
		expect(renderToStaticMarkup(<Kbd>⌘K</Kbd>)).toContain("⌘K");
	});

	it("associates form labels with their control", () => {
		const html = renderToStaticMarkup(<Label htmlFor="name">Name</Label>);

		expect(html).toContain('for="name"');
		expect(html).toContain("Name");
	});
});
