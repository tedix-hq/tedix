import type { OrgUsageOutput } from "@tedix/api-contract/contracts/org-usage";
import {
	BillingOverviewSchema,
	type BillingOverview,
} from "@tedix/api-contract/schemas/billing";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { BillingPlanStatus } from "./billing-plan-status";

const createPortal = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (original) => {
	const actual = await original<typeof import("@/lib/api")>();
	return {
		...actual,
		osApi: new Proxy(actual.osApi, {
			get(target, property) {
				if (property === "billing")
					return new Proxy(target.billing, {
						get(billing, method) {
							return method === "createPortal"
								? createPortal
								: Reflect.get(billing, method);
						},
					});
				return Reflect.get(target, property);
			},
		}),
	};
});
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
		overage: {
			enabled: false,
			monthlyCapMicros: null,
			currency: "eur",
			planSellsOverage: true,
			monthToDateChargeMicros: 0,
			reservedChargeMicros: 0,
			capReached: false,
		},
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
			currency: "eur",
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
			reviewedEstimateRowCount: 0,
			reviewedEstimateTokens: 0,
			reviewedEstimateMicros: 0,
			sourceRetiredRowCount: 0,
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
		monetary?: boolean;
		paused?: boolean;
		tinyCost?: boolean;
		legacyCurrency?: string;
		status?: BillingOverview["snapshot"]["status"];
		customer?: boolean;
		overviewError?: boolean;
	} = {},
) {
	const client = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				staleTime: Infinity,
				refetchOnMount: false,
				retryOnMount: false,
			},
		},
	});
	const bill = overview();
	if (opts.status) bill.snapshot.status = opts.status;
	if (opts.customer) bill.snapshot.stripeCustomerId = "cus_fictional";
	if (opts.legacyCurrency) bill.plan.currency = opts.legacyCurrency;
	if (opts.monetary)
		bill.credits = {
			billingMode: "monetary",
			currency: "eur",
			creditValueMicros: 10_000,
			includedMicros: 100_000_000,
			usedIncludedMicros: 15_000_000,
			remainingIncludedMicros: 85_000_000,
			walletBalanceMicros: 85_000_000,
			reservedMicros: 2_000_000,
			availableMicros: 83_000_000,
			spentMicros: 15_000_000,
			monthlyCapMicros: 90_000_000,
			perRunBudgetMicros: 5_000_000,
		};
	if (opts.paused) {
		bill.inferenceCapacity.available = false;
		bill.inferenceCapacity.blockingReason = "hard_spend_limit";
	}

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
	if (opts.tinyCost) bill.period!.providerCostMicros = 1;
	if (opts.unlimited) {
		bill.snapshot.includedTokens = 0;
		bill.snapshot.allowOverage = true;
		bill.plan.overageUnitPriceMicros = 0;
		bill.period!.meteredOverageTokens = 80000;
	}
	if (opts.overviewError) {
		const query = client
			.getQueryCache()
			.build(client, billingOverviewQueryOptions());
		query.setState({
			status: "error",
			error: new Error("Billing unavailable"),
		});
	} else client.setQueryData(billingOverviewQueryOptions().queryKey, bill);
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
	it("shows reviewed estimates as nonpayable and retains source-retired details", () => {
		const value = usage();
		value.totals.reviewedEstimateMicros = 33199;
		value.totals.reviewedEstimateRowCount = 1;
		value.totals.reviewedEstimateTokens = 12410;
		value.totals.sourceRetiredRowCount = 1;
		const html = render(value);
		expect(html).toContain("Reviewed provider estimates");
		expect(html).toContain("1 reviewed rows");
		expect(html).toContain("not payable");
		expect(html).toContain(
			"do not release held usage or change customer charges",
		);
		expect(html).toContain("Technical details");
		expect(html).toContain("original source is no longer present");
		expect(html).toContain("Metered usage charges");
	});
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
	expect(html).toContain("Estimated usage · unlimited token allowance");
	expect(html).toContain("billing snapshot");
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

it("leads monetary plans with available credits and exact wallet holds", () => {
	const html = render(usage(), { monetary: true });
	expect(html).toContain("8,300 credits");
	expect(html).toContain("€83 of usage value");
	expect(html).toContain("200 credits");
	expect(html).toContain("€2 · released or settled");
	expect(html).toContain("Ready to run");
	expect(html).toContain("Advanced usage and billing details");
	expect(html).toContain("Some usage is waiting for a price");
	expect(html).toContain("Spending by run");
	expect(html).toContain("Maximum per run:");
	expect(html).toContain("500 credits");
	expect(html).toContain("Included allowance remaining:");
	expect(html).toContain("Coverage forecast unavailable");
	expect(html).not.toContain("0 records have no confirmed price");
});
it("does not imply a funded wallet bypasses a canonical spending block", () => {
	const html = render(usage(), { monetary: true, paused: true });
	expect(html).toContain("8,300 credits");
	expect(html).toContain("Usage paused");
	expect(html).toContain(
		"This request exceeds a configured spending limit. (hard_spend_limit)",
	);
	expect(html).not.toContain("Ready to run");
});

it("keeps tiny settled model costs visible instead of displaying free zero", () => {
	expect(render(usage(), { tinyCost: true })).toContain("$0.000001");
});

it("preserves native legacy currency without inventing a credit conversion", () => {
	const html = render(usage(), { legacyCurrency: "usd" });
	expect(html).toContain("Balance shown in USD");
	expect(html).toContain("exchange rate is applied");
	expect(html).toContain("$0");
	expect(html).not.toContain("1 credit =");
});

it.each(["active", "trial", "past_due", "suspended"] as const)(
	"shows %s subscription recovery on the usage overview",
	(status) => {
		const html = render(usage(), { status, customer: true });
		expect(html).toContain("Subscription status and recovery");
		expect(html).toContain("Manage or upgrade plan");
		expect(html.indexOf("Current plan")).toBeLessThan(
			html.indexOf("Usage credits"),
		);
		if (status === "trial") expect(html).toContain("Trial ending");
		if (status === "past_due")
			expect(html).toContain("Payment needs attention");
		if (status === "suspended")
			expect(html).toContain("Subscription suspended");
	},
);

it("offers plan selection without a Stripe customer", () => {
	const html = render(usage(), { status: "suspended" });
	expect(html).toContain('href="/admin/billing?section=subscription"');
	expect(html).toContain("Choose a plan");
	expect(html).not.toContain("Manage or upgrade plan");
});

it("shows a failed billing read even when dependent usage has never loaded", () => {
	const html = render(usage(), { overviewError: true, pending: true });
	expect(html).toContain("Billing usage could not be read");
	expect(html).toContain("Billing unavailable");
	expect(html).not.toContain('aria-label="Loading usage"');
});

it("opens the tenant billing portal only on click and reports a failed handoff", async () => {
	createPortal.mockRejectedValueOnce(new Error("Portal unavailable"));
	const bill = overview();
	bill.snapshot.stripeCustomerId = "cus_fictional";
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(async () =>
			root.render(
				<QueryClientProvider client={client}>
					<BillingPlanStatus overview={bill} />
				</QueryClientProvider>,
			),
		);
		expect(createPortal).not.toHaveBeenCalled();
		await act(async () => {
			container.querySelector("button")!.click();
		});
		await vi.waitFor(() =>
			expect(container.textContent).toContain("Portal unavailable"),
		);
		expect(createPortal).toHaveBeenCalledExactlyOnceWith({
			returnUrl: `${window.location.origin}/admin/billing?section=usage`,
		});
	} finally {
		await act(async () => root.unmount());
		client.clear();
	}
});
