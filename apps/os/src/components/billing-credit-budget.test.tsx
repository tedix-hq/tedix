import type { BillingCreditOverview } from "@tedix/api-contract/schemas/billing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	BillingCreditBudget,
	parseCreditBudget,
} from "./billing-credit-budget";

const credits: BillingCreditOverview = {
	billingMode: "monetary",
	currency: "eur",
	creditValueMicros: 10_000,
	includedMicros: 100_000_000,
	usedIncludedMicros: 10_000_000,
	remainingIncludedMicros: 90_000_000,
	walletBalanceMicros: 90_000_000,
	availableMicros: 88_000_000,
	reservedMicros: 2_000_000,
	spentMicros: 10_000_000,
	monthlyCapMicros: 50_000_000,
};

describe("credit budget input", () => {
	it("supports an explicit uncapped wallet and exact cents", () => {
		expect(parseCreditBudget("")).toBe(null);
		expect(parseCreditBudget("12.34")).toBe(12_340_000);
	});
	it.each(["0", "-5", "NaN", "Infinity", "1e3", "1.234", "1000000.01"])(
		"rejects unsafe cap %s",
		(value) => expect(parseCreditBudget(value)).toBeUndefined(),
	);
	it("associates an invalid cap with its validation explanation", () => {
		const client = new QueryClient();
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<BillingCreditBudget credits={{ ...credits, monthlyCapMicros: -1 }} />
			</QueryClientProvider>,
		);
		client.clear();
		const doc = new DOMParser().parseFromString(html, "text/html");
		const input = doc.querySelector("#monthly-credit-budget");
		expect(input?.getAttribute("aria-invalid")).toBe("true");
		expect(input?.getAttribute("aria-describedby")).toBe(
			"monthly-credit-budget-description",
		);
		expect(input?.getAttribute("aria-errormessage")).toBe(
			"monthly-credit-budget-description",
		);
	});
});
