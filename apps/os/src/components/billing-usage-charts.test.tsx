import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { BillingUsageCharts } from "./billing-usage-charts";

vi.mock("@/components/kumo/event-chart", () => ({
	Chart: ({ options }: { options: { aria?: { description?: string } } }) => (
		<div data-chart-description={options.aria?.description} />
	),
	ChartPalette: {
		categorical: () => "#000",
		text: () => "#000",
	},
}));

const periodLabel = "Sep 1 – Oct 15";

describe("BillingUsageCharts", () => {
	it("shows a Kumo empty state when neither breakdown has records", () => {
		const html = renderToStaticMarkup(
			<BillingUsageCharts daily={[]} tedis={[]} periodLabel={periodLabel} />,
		);
		expect(html).toContain('data-slot="empty"');
		expect(html).toContain("No usage trend data yet");
		expect(html).toContain(periodLabel);
		expect(html).not.toContain("Cost incomplete");
	});

	it("keeps an empty daily series visible beside a populated tedi series", () => {
		const html = renderToStaticMarkup(
			<BillingUsageCharts
				daily={[]}
				tedis={[
					{
						tediId: "tedi-1",
						tediName: "CTO",
						tediSlug: "cto",
						estimatedCostUsd: 1.25,
						totalTokens: 1000,
						cacheHitRate: null,
					},
				]}
				periodLabel={periodLabel}
			/>,
		);
		expect(html).toContain("No daily usage records");
		expect(html).toContain("Provider cost by tedi");
		expect(html).toContain(
			`Top tedis by estimated provider cost for the billing period ${periodLabel}`,
		);
	});

	it("describes the actual period and preserves incomplete cost in exact data", () => {
		const html = renderToStaticMarkup(
			<BillingUsageCharts
				daily={[
					{ date: "2026-09-01", estimatedCostUsd: null, totalTokens: 250 },
				]}
				tedis={[]}
				periodLabel={periodLabel}
			/>,
		);
		expect(html).toContain(
			`Daily estimated provider cost for the billing period ${periodLabel}`,
		);
		expect(html).toContain("Cost incomplete");
		expect(html).toContain("No tedi usage records");
		expect(html).not.toContain("last 30 days");
	});
});
