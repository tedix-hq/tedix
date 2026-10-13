import type { BillingOverview } from "@tedix/api-contract/schemas/billing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { billingOverviewQueryOptions } from "@/lib/os-query-options";
import {
	BillingOverageSection,
	parseOverageCapMicros,
} from "./billing-overage-section";

function render(
	overage: BillingOverview["overage"],
	credits?: BillingOverview["credits"],
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	client.setQueryData(billingOverviewQueryOptions().queryKey, {
		overage,
		credits,
	} as BillingOverview);
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<BillingOverageSection />
		</QueryClientProvider>,
	);
	client.clear();
	return html;
}

const off: BillingOverview["overage"] = {
	enabled: false,
	monthlyCapMicros: null,
	currency: "eur",
	planSellsOverage: true,
	monthToDateChargeMicros: 0,
	reservedChargeMicros: 0,
	capReached: false,
};

describe("BillingOverageSection", () => {
	it("renders the opt-in off by default with the cap disabled", () => {
		const html = render(off);
		expect(html).toContain("Allow overage");
		expect(html).toContain("Monthly cap (EUR)");
		expect(html).not.toContain("Cap reached");
		expect(html).toMatch(/id="overage-cap"[^>]*disabled/);
	});

	it("shows month-to-date overage against the cap and the cap-reached state", () => {
		const html = render({
			...off,
			enabled: true,
			monthlyCapMicros: 50_000_000,
			monthToDateChargeMicros: 48_000_000,
			reservedChargeMicros: 2_000_000,
			capReached: true,
		});
		expect(html).toContain("Cap reached");
		expect(html).toContain("Monthly overage cap reached");
		expect(html).toContain("€50 overage of €50 cap");
		expect(html).toContain("€2 held by running turns");
	});

	it("explains a plan that sells no overage", () => {
		const html = render({ ...off, planSellsOverage: false });
		expect(html).toContain("This plan does not sell overage");
	});
});

describe("parseOverageCapMicros", () => {
	it("converts whole and fractional currency units to micros", () => {
		expect(parseOverageCapMicros("50")).toBe(50_000_000);
		expect(parseOverageCapMicros("12.34")).toBe(12_340_000);
	});
	it("rejects empty, zero, negative and oversized caps", () => {
		expect(parseOverageCapMicros("")).toBeNull();
		expect(parseOverageCapMicros("0")).toBeNull();
		expect(parseOverageCapMicros("-5")).toBeNull();
		expect(parseOverageCapMicros("1000001")).toBeNull();
	});
});

it("offers a monetary budget without enabling the legacy cash overage switch", () => {
	const html = render(off, {
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
	});
	expect(html).toContain("Monthly credit spending cap");
	expect(html).toContain("1,200 credits (€12) used or reserved");
	expect(html).toContain("Monthly cap (EUR)");
	expect(html).not.toContain("Allow overage");
});
