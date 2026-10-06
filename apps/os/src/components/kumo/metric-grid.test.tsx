import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { MetricGrid, MetricItem } from "./metric-grid";

describe("Kumo MetricGrid adapter", () => {
	it("renders a labelled definition list with one item per metric", () => {
		const html = renderToStaticMarkup(
			<MetricGrid aria-label="Reliability" columns={2}>
				<MetricItem
					label="Observed reliability"
					value="98%"
					description="49 of 50 runs completed."
				/>
				<MetricItem label="Feedback" value="12 helpful" />
			</MetricGrid>,
		);

		expect(html).toContain('data-slot="metric-grid"');
		expect(html).toContain('data-appearance="inline"');
		expect(html).toContain('aria-label="Reliability"');
		expect(html.match(/data-slot="metric-item"/g)).toHaveLength(2);
		expect(html).toContain("<dt");
		expect(html).toContain("<dd");
		expect(html).toContain("Observed reliability");
		expect(html).toContain("98%");
		expect(html).toContain("49 of 50 runs completed.");
	});
});
