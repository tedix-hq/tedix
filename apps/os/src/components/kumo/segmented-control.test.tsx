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
});
