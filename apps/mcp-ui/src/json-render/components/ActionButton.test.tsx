/**
 * Rendered with `react-dom/server`, matching this app's testing idiom
 * (url-safety.test.tsx): the component is pure output for the props under
 * test, and press behavior is a spec-registered action, not component logic.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ActionButtonComponent } from "./ActionButton";

const noop = () => {};

describe("ActionButtonComponent", () => {
	it("renders the label as a button", () => {
		const html = renderToStaticMarkup(
			<ActionButtonComponent label="File sweep item" onPress={noop} />,
		);
		expect(html).toContain("File sweep item");
		expect(html).toContain('type="button"');
		expect(html).not.toContain('disabled=""');
	});

	it("renders nothing without a label", () => {
		expect(
			renderToStaticMarkup(
				<ActionButtonComponent label={null} onPress={noop} />,
			),
		).toBe("");
	});

	it("maps tone to a variant class and honors disabled/fullWidth", () => {
		const html = renderToStaticMarkup(
			<ActionButtonComponent
				disabled
				fullWidth
				label="Blocked"
				onPress={noop}
				tone="destructive"
			/>,
		);
		expect(html).toContain('disabled=""');
		expect(html).toContain("w-full");
		expect(html).toContain("destructive");
	});
});
