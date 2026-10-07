import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { BillingUsageCharts } from "./billing-usage-charts";

vi.mock("@/components/kumo/event-chart", () => ({
	Chart: ({
		options,
	}: {
		options: {
			aria?: { description?: string };
			series?: Array<{ data: unknown[] }>;
		};
	}) => {
		chartOptions.push(options);
		return <div data-chart-description={options.aria?.description} />;
	},
	ChartPalette: {
		categorical: () => "#000",
		text: () => "#000",
	},
}));

const chartOptions: Array<{ series?: Array<{ data: unknown[] }> }> = [];
const priced = {
	knownSubtotalUsd: 1.25,
	reviewedEstimateRowCount: 0,
	reviewedEstimateTokens: 0,
	reviewedEstimateMicros: 0,
	sourceRetiredRowCount: 0,
	pricedRowCount: 1,
	unpricedRowCount: 0,
	unpricedTokens: 0,
	costCompleteness: "complete" as const,
};
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
						...priced,
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
		expect(html).toContain("Model cost by tedi");
		expect(html).toContain(
			`Top tedis by estimated model cost for the billing period ${periodLabel}`,
		);
	});

	it("describes the actual period and preserves incomplete cost in exact data", () => {
		const html = renderToStaticMarkup(
			<BillingUsageCharts
				daily={[
					{
						...priced,
						date: "2026-09-01",
						estimatedCostUsd: null,
						totalTokens: 250,
						inputTokens: 200,
						outputTokens: 50,
						costCompleteness: "partial",
						unpricedRowCount: 1,
						unpricedTokens: 100,
					},
				]}
				tedis={[]}
				periodLabel={periodLabel}
			/>,
		);
		expect(html).toContain(
			`Daily estimated model cost for the billing period ${periodLabel}`,
		);
		expect(html).toContain("Cost incomplete");
		expect(html).toContain("No tedi usage records");
		expect(html).not.toContain("last 30 days");
	});
});

it("preserves nullable chart gaps independently from zero and coverage subtotals", () => {
	chartOptions.length = 0;
	const html = renderToStaticMarkup(
		<BillingUsageCharts
			periodLabel={periodLabel}
			tedis={[]}
			daily={[
				{
					...priced,
					date: "2026-09-01",
					estimatedCostUsd: null,
					totalTokens: 250,
					inputTokens: 200,
					outputTokens: 50,
					costCompleteness: "partial",
					unpricedRowCount: 1,
					unpricedTokens: 100,
				},
				{
					...priced,
					date: "2026-09-02",
					estimatedCostUsd: 0,
					knownSubtotalUsd: 0,
					totalTokens: 20,
					inputTokens: 20,
					outputTokens: 0,
				},
				{
					...priced,
					date: "2026-09-03",
					estimatedCostUsd: null,
					knownSubtotalUsd: 0,
					pricedRowCount: 0,
					unpricedRowCount: 1,
					unpricedTokens: 30,
					costCompleteness: "unknown",
					totalTokens: 30,
					inputTokens: 30,
					outputTokens: 0,
				},
			]}
		/>,
	);
	expect(chartOptions[0]?.series?.[0]?.data).toEqual([null, 0, null]);
	expect(html).toContain("Known subtotal");
	expect(html).toContain("$1.25");
	expect(html).toContain("partial");
	expect(html).toContain("unknown");
	expect(html).toContain("Unpriced tokens");
	expect(html).toContain("not payable amounts");
});
