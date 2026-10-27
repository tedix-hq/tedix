import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { SegmentedControl } from "./segmented-control";

const options = [
	{ value: "24h", label: "24h" },
	{ value: "7d", label: "7d" },
	{ value: "30d", label: "30d" },
] as const;

describe("SegmentedControl", () => {
	it("is one named composite choice group with a single pressed segment", () => {
		const html = renderToStaticMarkup(
			<SegmentedControl
				ariaLabel="Usage period"
				onValueChange={() => {}}
				options={options}
				value="7d"
			/>,
		);

		expect(html).toContain('role="group"');
		expect(html).toContain('aria-label="Usage period"');
		expect(html).toContain('aria-pressed="true"');
		expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
		// Base UI's ToggleGroup owns single-select and roving arrow-key focus, so
		// the rail is one tab stop and the pressed segment is the composite's
		// active item.
		expect(html).toContain('data-orientation="horizontal"');
		expect(html).toContain('data-pressed=""');
		expect(html.match(/tabindex="-1"/g)).toHaveLength(3);
	});

	it("draws icon-only segments as named, centred icon buttons", () => {
		const html = renderToStaticMarkup(
			<SegmentedControl
				ariaLabel="Layout"
				iconOnly
				onValueChange={() => {}}
				options={[
					{ value: "list", label: "List view", icon: <svg data-list="" /> },
					{ value: "grid", label: "Grid view", icon: <svg data-grid="" /> },
				]}
				value="grid"
			/>,
		);

		expect(html).toContain('aria-label="List view"');
		expect(html).toContain('aria-label="Grid view"');
		expect(html.match(/data-icon-only="true"/g)).toHaveLength(2);
		// Kumo turns the square button's title into its hover tooltip.
		expect(html.match(/data-base-ui-tooltip-trigger/g)).toHaveLength(2);
		expect(html).toMatch(/!justify-center/);
		expect(html).toMatch(/!rounded-md/);
		expect(html).not.toContain("!rounded-full");
		expect(html).not.toContain("sr-only");
		expect(html).toContain("data-list");
	});

	it("draws a text segment's icon before its label", () => {
		const html = renderToStaticMarkup(
			<SegmentedControl
				ariaLabel="Theme"
				onValueChange={() => {}}
				options={[
					{ value: "light", label: "Light", icon: <svg data-sun="" /> },
					{ value: "dark", label: "Dark" },
				]}
				value="light"
			/>,
		);

		expect(html.indexOf("data-sun")).toBeLessThan(html.indexOf("Light"));
		expect(html).not.toContain("data-icon-only");
	});
});
