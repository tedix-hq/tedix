import type { OrgUsageOutput } from "@tedix/api-contract/contracts/org-usage";
import {
	BillingOverviewSchema,
	type BillingOverview,
} from "@tedix/api-contract/schemas/billing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
	billingOverviewQueryOptions,
	billingPlansQueryOptions,
	orgUsageQueryOptions,
	ORG_USAGE_PERIOD,
} from "@/lib/os-query-options";
import { BillingUsageOverview } from "./admin-billing-usage";
import { SubscriptionSection } from "./billing-subscription-section";
const org = "fictional-organization";
function overview(): BillingOverview {
	return BillingOverviewSchema.parse({
		stripeEnvironment: "test",
		workstationCostCoverage: {
			periodStart: "2026-09-01T00:00:00.000Z",
			periodEnd: "2026-10-01T00:00:00.000Z",
			observedAt: "2026-09-20T00:00:00.000Z",
			unit: "compute_seconds",
			basis: "recorded_lease_end_wall_clock",
			status: "partial",
			knownAttributedCostMicros: 2000000,
			total: { rowCount: 3, leaseSeconds: 300 },
			reconciled: { rowCount: 1, leaseSeconds: 100 },
			pending: { rowCount: 1, leaseSeconds: 100 },
			unproven: { rowCount: 1, leaseSeconds: 100 },
		},
		snapshot: {
			status: "active",
			billingMode: "stripe",
			planKey: "growth",
			planVersion: 1,
			periodStart: "2026-09-01T00:00:00.000Z",
			periodEnd: "2026-10-01T00:00:00.000Z",
			includedTokens: 200,
			usedTokens: 50,
			reservedTokens: 10,
			remainingIncludedTokens: 140,
			creditBalanceMicros: 0,
			reservedChargeMicros: 0,
			availableCreditMicros: 0,
			customerChargeMicros: 0,
			hardSpendLimitMicros: null,
			allowOverage: false,
			stripeCustomerId: null,
		},
		plan: {
			name: "Growth",
			currency: "usd",
			monthlyPriceMicros: 25000000,
			annualPriceMicros: 250000000,
			includedMonthlyCreditMicros: 0,
			overageUnitTokens: 1000,
			overageUnitPriceMicros: 100,
			maxTedis: 4,
			maxCronJobsPerTedi: 3,
			maxIterationsPerTask: 10,
			defaultDailyTokenLimit: 500,
			defaultDailyMessageLimit: 10,
		},
		period: {
			usedInputTokens: 40,
			usedOutputTokens: 10,
			meteredOverageTokens: 0,
			providerCostMicros: 500000,
			customerChargeMicros: 0,
			creditAppliedMicros: 0,
		},
		inferenceCapacity: {
			available: true,
			monthlyMetered: false,
			blockingReason: null,
			unblockAction: "none",
			budgetDay: "2026-09-01",
			baseDailyTokenLimit: 500,
			baseDailySpendLimitMicros: null,
			allocatedTokens: 0,
			allocatedSpendCapacityMicros: 0,
			sponsoredTokens: 0,
			sponsoredSpendCapacityMicros: 0,
			usedTokens: 50,
			usedSpendMicros: 500000,
			remainingTokens: 450,
			remainingSpendMicros: null,
			expiresAt: "2026-09-02T00:00:00.000Z",
			packs: [],
			allocations: [],
			tediOverflow: [],
		},
		serviceCredits: { seo: null },
	});
}
function usage(): OrgUsageOutput {
	return {
		organization: {
			id: org,
			name: "Fictional company",
			tier: "growth",
			status: "active",
		},
		period: "30d",
		window: {
			from: "2026-09-01T00:00:00.000Z",
			to: "2026-10-01T00:00:00.000Z",
		},
		totals: {
			totalTokens: 100,
			inputTokens: 70,
			outputTokens: 20,
			cacheReadTokens: 10,
			cacheWriteTokens: 0,
			estimatedCostUsd: null,
			knownSubtotalUsd: 1.25,
			pricedRowCount: 2,
			unpricedRowCount: 1,
			unpricedTokens: 40,
			costCompleteness: "partial",
			activeTedis: 1,
		},
		planLimits: {
			maxTokensPerMonth: 200,
			currentMonthTokens: 50,
			usagePct: 0.25,
			maxTedis: 4,
			currentTedis: 1,
		},
		daily: [],
		tediBreakdown: [],
		modelBreakdown: [],
		sourceBreakdown: [],
	};
}
function render(
	value = usage(),
	opts: {
		pending?: boolean;
		error?: boolean;
		subscription?: boolean;
		unlimited?: boolean;
		workstationUnknown?: boolean;
	} = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity } },
	});
	const bill = overview();
	if (opts.workstationUnknown)
		bill.workstationCostCoverage = {
			...bill.workstationCostCoverage,
			status: "partial",
			knownAttributedCostMicros: null,
			total: { rowCount: 1, leaseSeconds: 100 },
			reconciled: { rowCount: 0, leaseSeconds: 0 },
			pending: { rowCount: 1, leaseSeconds: 100 },
			unproven: { rowCount: 0, leaseSeconds: 0 },
		};
	if (opts.unlimited) {
		bill.snapshot.includedTokens = 0;
		bill.snapshot.allowOverage = true;
		bill.plan.overageUnitPriceMicros = 0;
		bill.period!.meteredOverageTokens = 80000;
	}
	client.setQueryData(billingOverviewQueryOptions().queryKey, bill);
	const query = orgUsageQueryOptions(org, ORG_USAGE_PERIOD, {
		from: bill.snapshot.periodStart,
		to: bill.snapshot.periodEnd,
	});
	if (!opts.pending) client.setQueryData(query.queryKey, value);
	if (opts.error)
		client
			.getQueryCache()
			.find({ queryKey: query.queryKey })
			?.setState({ status: "error", error: new Error("Usage unavailable") });
	if (opts.subscription)
		client.setQueryData(billingPlansQueryOptions().queryKey, {
			stripeEnvironment: "test",
			plans: [],
		});
	const html = renderToStaticMarkup(
		<QueryClientProvider client={client}>
			<BillingUsageOverview organizationId={org} />
			{opts.subscription && <SubscriptionSection />}
		</QueryClientProvider>,
	);
	client.clear();
	return html;
}
describe("billing population coverage", () => {
	it("distinguishes settled allowance math from observed pricing coverage", () => {
		const html = render();
		expect(html).toContain("Settled billing tokens");
		expect(html).toContain(">50<");
		expect(html).toContain("150 remaining of 200");
		expect(html).toContain("Observed model tokens");
		expect(html).toContain(">100<");
		expect(html).toContain("$1.25");
		expect(html).toContain("Partial pricing coverage");
		expect(html).toContain("2 priced rows · 1 unpriced rows");
		expect(html).toContain(">40<");
		expect(html).toContain("records that may be held");
	});
	it("separates test subscription payments, metered charges and settled model costs", () => {
		const html = render(usage(), { subscription: true });
		expect(html).toContain("Metered usage charges");
		expect(html).toContain("Settled model cost");
		expect(html).toMatch(/\$0\.5(?:0)?</);
		expect(html).toContain("exclude the subscription price");
		expect(html).toContain("not an invoice");
		expect(html).toContain("Billing test mode");
		expect(html).toContain("No real payment method will be charged");
		expect(html).toContain("recorded usage and model costs are not simulated");
	});
	it.each(["complete", "partial", "unknown"] as const)(
		"keeps %s known zero distinct from a full cost",
		(coverage) => {
			const value = usage();
			value.totals = {
				...value.totals,
				knownSubtotalUsd: 0,
				estimatedCostUsd: coverage === "complete" ? 0 : null,
				pricedRowCount: coverage === "unknown" ? 0 : 1,
				unpricedRowCount: coverage === "complete" ? 0 : 1,
				unpricedTokens: coverage === "complete" ? 0 : 100,
				costCompleteness: coverage,
			};
			const html = render(value);
			expect(html).toContain(
				`${coverage[0]?.toUpperCase()}${coverage.slice(1)} pricing coverage`,
			);
			expect(html).toContain("not a payable amount");
		},
	);
	it("retains settled totals when the observed ledger has no rows", () => {
		const value = usage();
		value.totals = {
			...value.totals,
			totalTokens: 0,
			knownSubtotalUsd: 0,
			estimatedCostUsd: null,
			pricedRowCount: 0,
			unpricedRowCount: 0,
			unpricedTokens: 0,
			costCompleteness: "unknown",
		};
		const html = render(value);
		expect(html).toContain(">50<");
		expect(html).toContain("Unknown pricing coverage");
	});
	it("keeps pending and failed reads unavailable rather than returning zero coverage", () => {
		const pending = render(usage(), { pending: true });
		expect(pending).toContain('aria-busy="true"');
		expect(pending).not.toContain("Known model-cost subtotal");
		const failed = render(usage(), { error: true });
		expect(failed).toContain("Billing usage could not be read");
		expect(failed).not.toContain("Observed model tokens");
	});
});

it("does not describe unlimited-plan settled tokens as paid overage", () => {
	const html = render(usage(), { unlimited: true });
	expect(html).toContain("Unlimited plan allowance");
	expect(html).toContain(
		"Estimated usage this period · unlimited token allowance",
	);
	expect(html).not.toContain("80,000 metered overage tokens");
	expect(html).toContain("Metered usage charges");
});

it("shows separate reconciled workstation subtotal and recorded coverage", () => {
	const html = render(usage());
	expect(html).toContain("Reconciled workstation cost");
	expect(html).toContain(">$2<");
	expect(html).toContain("1 pending rows");
	expect(html).toContain("1 unproven rows");
	expect(html).toContain("Wall-clock lease duration is a proxy");
	expect(html).toContain(
		"does not establish an invoice or total infrastructure spend",
	);
	expect(html).toContain("Pending stored zero does not mean free");
});
it("unknown workstation subtotal is never displayed as free zero", () => {
	const html = render(usage(), { workstationUnknown: true });
	expect(html).toContain(">Unknown<");
	expect(html).toContain("1 pending rows");
	expect(render(usage(), { pending: true })).not.toContain(
		"Reconciled workstation cost",
	);
	expect(render(usage(), { error: true })).not.toContain(
		"Reconciled workstation cost",
	);
});
