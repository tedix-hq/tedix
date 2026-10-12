import type { BillingInferenceSpending } from "@tedix/api-contract/schemas/billing-spending";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { SettledSpendingRows } from "@/components/billing-settled-spending";
import {
	groupSettledCreditCharges,
	settledCreditCoverage,
} from "./billing-inference-spending";
const row: BillingInferenceSpending["rows"][number] = {
	id: "charge",
	runId: "run",
	traceId: "step",
	provider: "fictional",
	model: "fictional-model",
	occurredAt: "2026-10-02T00:00:00.000Z",
	creditAppliedMicros: 10000,
	customerChargeMicros: 20000,
	currency: "usd",
	creditValueMicros: 10000,
	rateVersionId: "price-1",
};
const data = (
	rows: BillingInferenceSpending["rows"],
): BillingInferenceSpending => ({
	from: "2026-10-01T00:00:00.000Z",
	to: "2026-10-31T00:00:00.000Z",
	hasMore: true,
	rows,
});
describe("settled credit presentation", () => {
	it("counts each customer receipt once, keeps unlinked charges visible, and separates denominations", () => {
		const groups = groupSettledCreditCharges([
			row,
			row,
			{ ...row, id: "second", creditValueMicros: 20000 },
			{ ...row, id: "orphan", runId: null },
		]);
		expect(groups).toHaveLength(2);
		expect(groups[0]).toMatchObject({
			chargeMicros: 60000,
			creditValueMicros: null,
		});
		expect(groups[1]).toMatchObject({ runId: null, chargeMicros: 30000 });
	});
	it("renders actual credits and currency, incomplete pages, missing prices and outcome limits", () => {
		const html = renderToStaticMarkup(
			<SettledSpendingRows
				data={data([
					row,
					{ ...row, id: "orphan", runId: null, rateVersionId: null },
				])}
			/>,
		);
		expect(html).toContain("3 credits");
		expect(html).toContain("$0.03");
		expect(html).toContain("run subtotals are incomplete");
		expect(html).toContain("Price version missing");
		expect(html).toContain("Charges without a linked run");
		expect(html).toContain("cost per accepted result is unavailable");
		expect(html).toContain("step trace step");
	});
	it("does not call an empty receipt window zero-cost execution", () => {
		const html = renderToStaticMarkup(<SettledSpendingRows data={data([])} />);
		expect(html).toContain("No settled monetary inference receipts");
		expect(html).toContain("Unsettled work");
	});
});
describe("conditional settled spending pace", () => {
	const input = {
		spentMicros: 100,
		availableMicros: 500,
		reservedMicros: 50,
		monthlyCapMicros: 200,
		periodStart: "2026-10-01T00:00:00.000Z",
		periodEnd: "2026-11-01T00:00:00.000Z",
		nowMs: Date.parse("2026-10-03T00:00:00.000Z"),
	};
	it("respects both the remaining cap including holds and available wallet funds", () => {
		expect(settledCreditCoverage(input)).toBe(1);
		expect(settledCreditCoverage({ ...input, monthlyCapMicros: null })).toBe(
			10,
		);
		expect(settledCreditCoverage({ ...input, availableMicros: 10 })).toBe(0.2);
	});
	it("bounds sparse-spend coverage to the current period", () => {
		expect(
			settledCreditCoverage({
				...input,
				spentMicros: 1,
				availableMicros: 100_000_000,
				monthlyCapMicros: null,
			}),
		).toBe(29);
	});
	it("keeps zero usage, invalid dates, short observations and closed periods unknown", () => {
		expect(
			settledCreditCoverage({ ...input, periodEnd: "invalid" }),
		).toBeNull();
		expect(settledCreditCoverage({ ...input, spentMicros: 0 })).toBeNull();
		expect(
			settledCreditCoverage({ ...input, nowMs: Date.parse(input.periodStart) }),
		).toBeNull();
		expect(
			settledCreditCoverage({ ...input, nowMs: Date.parse(input.periodEnd) }),
		).toBeNull();
	});
});
