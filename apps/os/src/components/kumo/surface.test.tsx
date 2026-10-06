import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Surface } from "./surface";

describe("Kumo Surface adapter", () => {
	it("exposes tier and variant, stays polymorphic, and forwards native attributes", () => {
		const defaults = renderToStaticMarkup(
			<Surface id="composition">Payload</Surface>,
		);
		expect(defaults).toMatch(/^<div/);
		expect(defaults).toContain('data-slot="surface"');
		expect(defaults).toContain('data-tier="well"');
		expect(defaults).toContain('data-variant="flat"');
		expect(defaults).toContain('id="composition"');
		expect(defaults).toContain("Payload");

		const raised = renderToStaticMarkup(
			<Surface tier="panel" variant="raised">
				Raised
			</Surface>,
		);
		expect(raised).toContain('data-tier="panel"');
		expect(raised).toContain('data-variant="raised"');

		expect(
			renderToStaticMarkup(<Surface as="section">Section</Surface>),
		).toMatch(/^<section/);
		expect(
			renderToStaticMarkup(<Surface render={<aside />}>Aside</Surface>),
		).toMatch(/^<aside/);
	});
});
