import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Input } from "./input";
import { Textarea } from "./textarea";

describe("Kumo form control adapters", () => {
	it("forwards native input attributes through Kumo Input", () => {
		const html = renderToStaticMarkup(
			<Input aria-label="Search" autoComplete="off" name="query" required />,
		);

		expect(html).toContain('data-slot="input"');
		expect(html).toContain('aria-label="Search"');
		expect(html).toContain('name="query"');
		expect(html).toContain('autoComplete="off"');
		expect(html).toContain("required");
	});

	it("forwards native textarea attributes through Kumo InputArea", () => {
		const html = renderToStaticMarkup(
			<Textarea aria-label="Notes" name="notes" rows={4} />,
		);

		expect(html).toContain('data-kumo-component="Textarea"');
		expect(html).toContain('name="notes"');
		expect(html).toContain('rows="4"');
	});
});
