import type { BillingOverview } from "@tedix/api-contract/schemas/billing";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { handleLocalRpc } from "../../dev/local-fixtures";
import { BillingCreditWallet } from "./billing-credit-wallet";

function overview() {
	return (
		handleLocalRpc("/api/rpc/billing/getOverview", "POST", { json: {} })!
			.body as { json: BillingOverview }
	).json;
}

function render(value: BillingOverview) {
	return new DOMParser().parseFromString(
		renderToStaticMarkup(<BillingCreditWallet overview={value} />),
		"text/html",
	);
}

describe("BillingCreditWallet", () => {
	it("leads a zero-credit token plan with the remaining allowance", () => {
		const value = overview();
		value.snapshot.availableCreditMicros = 0;
		value.snapshot.creditBalanceMicros = 0;
		const doc = render(value);
		expect(doc.body.textContent).toContain("Token plan allowance");
		expect(doc.body.textContent).toContain(
			"Usage credits · separate wallet available",
		);
		expect(doc.querySelector(".type-tedix-metric")?.textContent).toBe(
			"3,700,000 tokens",
		);
	});

	it("preserves unlimited allowance and a blocked runtime independently", () => {
		const value = overview();
		value.snapshot.includedTokens = 0;
		value.snapshot.allowOverage = true;
		value.plan.overageUnitPriceMicros = 0;
		value.inferenceCapacity.available = false;
		value.inferenceCapacity.blockingReason = "inference_capacity_exhausted";
		const text = render(value).body.textContent;
		expect(text).toContain("Unlimited tokens");
		expect(text).toContain("Usage paused");
		expect(text).toContain("Today's usage limit has been reached.");
	});

	it("leads monetary plans with credits instead of a legacy token allowance", () => {
		const value = overview();
		value.credits = {
			billingMode: "monetary",
			currency: "eur",
			creditValueMicros: 10_000,
			includedMicros: 1_000_000,
			usedIncludedMicros: 0,
			remainingIncludedMicros: 1_000_000,
			walletBalanceMicros: 1_000_000,
			availableMicros: 1_000_000,
			reservedMicros: 0,
			spentMicros: 0,
			monthlyCapMicros: null,
		};
		const text = render(value).body.textContent;
		expect(text).toContain("Available credits to spend");
		expect(text).toContain("100 credits");
		expect(text).not.toContain("Included token allowance remaining");
	});
});
