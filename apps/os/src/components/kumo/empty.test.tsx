import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { Empty, EmptyTitle } from "./empty";

describe("Kumo Empty adapter", () => {
	it("forwards root props and renders prop-driven and compositional titles as headings", () => {
		const propDriven = renderToStaticMarkup(
			<Empty
				data-testid="empty-state"
				title="No workers"
				description="Add one."
			/>,
		);
		expect(propDriven).toContain('data-testid="empty-state"');
		expect(propDriven).toContain("<h2");
		expect(propDriven).toContain("No workers");
		expect(propDriven).toContain("Add one.");

		const compositional = renderToStaticMarkup(
			<Empty appearance="quiet">
				<EmptyTitle>No results</EmptyTitle>
			</Empty>,
		);
		expect(compositional).toContain('data-appearance="quiet"');
		expect(compositional).toContain("<h2");
		expect(compositional).toContain("No results");
	});
});
