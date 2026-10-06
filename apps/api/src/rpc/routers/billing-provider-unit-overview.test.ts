import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BillingOverviewSchema } from "@tedix/api-contract/schemas/billing";
import type { BaseContext } from "../orpc";
const storage = vi.hoisted(() => ({
	coverage: vi.fn(),
	snapshot: vi.fn(),
	entitlement: vi.fn(),
}));
vi.mock("@tedix/db/queries/billing/provider-usage", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/billing/provider-usage")
	>()),
	getWorkstationCostCoverage: storage.coverage,
}));
vi.mock("@tedix/db/queries/billing/credits", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/billing/credits")>()),
	getBillingBalanceSnapshot: storage.snapshot,
}));
vi.mock("@tedix/db/queries/billing/plans", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/billing/plans")>()),
	getBillingEntitlement: storage.entitlement,
}));
vi.mock("@tedix/db/queries/billing-service-credits", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/billing-service-credits")
	>()),
	getBillingServiceCreditSnapshot: async () => null,
}));
vi.mock("@tedix/db/queries/billing/inference-policies", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/billing/inference-policies")
	>()),
	getEffectiveInferencePolicies: async () => ({
		organization: { dailyTokenLimit: 1000000, dailySpendLimitMicros: null },
	}),
}));
vi.mock("@tedix/db/queries/billing/capacity-allocations", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/billing/capacity-allocations")
	>()),
	getInferenceCapacityDailyOverview: async () => ({
		budgetDay: "2026-09-20",
		allocatedTokens: 0,
		allocatedSpendMicros: 0,
		sponsoredTokens: 0,
		sponsoredSpendMicros: 0,
		usedTokens: 0,
		usedSpendMicros: 0,
		earliestExpiryAt: null,
	}),
	getInferenceCapacityLedger: async () => ({
		allocations: [],
		tediOverflow: [],
	}),
}));
vi.mock("@tedix/db/queries/billing/capacity-packs", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/billing/capacity-packs")
	>()),
	listActiveInferenceCapacityPacks: async () => [],
}));
vi.mock("@tedix/db/queries/billing/health", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/billing/health")>()),
	getBillingUsagePeriod: async () => null,
}));
import { billingContractRouter } from "./billing";
const org = "5eed0033-0000-4000-8000-000000000033";
const coverage = {
	periodStart: "2026-09-01T00:00:00.000Z",
	periodEnd: "2026-10-01T00:00:00.000Z",
	observedAt: "2026-09-20T00:00:00.000Z",
	unit: "compute_seconds",
	basis: "recorded_lease_end_wall_clock",
	status: "none",
	knownAttributedCostMicros: null,
	total: { rowCount: 0, leaseSeconds: 0 },
	reconciled: { rowCount: 0, leaseSeconds: 0 },
	pending: { rowCount: 0, leaseSeconds: 0 },
	unproven: { rowCount: 0, leaseSeconds: 0 },
};
function context(scopes = ["billing:read"]): BaseContext {
	return {
		authType: "apikey",
		organizationId: org,
		userRole: "owner",
		apiKey: { id: "key", name: "fictional", organizationId: org, scopes },
		db: {},
		env: {
			ENVIRONMENT: "test",
			TEDIX_STRIPE_MODE: "test",
			TEDIX_BILLING_SETTLEMENT_MODE: "managed",
			TEDIX_FLEET_AUTHORITY_MODE: "co-located",
			DB: {},
		},
		headers: new Headers(),
		url: new URL("https://api.example.test/rpc/billing"),
	} as BaseContext;
}
describe("workstation coverage in existing canonical billing overview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		storage.coverage.mockResolvedValue(coverage);
		storage.snapshot.mockResolvedValue({
			status: "active",
			billingMode: "trial",
			planKey: "growth",
			planVersion: 1,
			periodStart: coverage.periodStart,
			periodEnd: coverage.periodEnd,
			includedTokens: 1000000,
			usedTokens: 0,
			reservedTokens: 0,
			remainingIncludedTokens: 1000000,
			creditBalanceMicros: 0,
			reservedChargeMicros: 0,
			availableCreditMicros: 0,
			customerChargeMicros: 0,
			hardSpendLimitMicros: null,
			allowOverage: false,
			stripeCustomerId: null,
		});
		storage.entitlement.mockResolvedValue({
			account: { stripeEnvironment: "test" },
			plan: {
				name: "Growth",
				currency: "usd",
				monthlyPriceMicros: 0,
				annualPriceMicros: 0,
				includedMonthlyCreditMicros: 0,
				overageUnitTokens: 1000000,
				overageUnitPriceMicros: 0,
				maxTedis: 1,
				maxCronJobsPerTedi: 1,
				maxIterationsPerTask: 10,
				defaultDailyTokenLimit: 1000000,
				defaultDailyMessageLimit: 100,
			},
		});
	});
	it("uses canonical org and snapshot window and publishes required coverage separately", async () => {
		const ctx = context();
		const client = createRouterClient(billingContractRouter, { context: ctx });
		const result = await client.getOverview();
		expect(storage.coverage).toHaveBeenCalledExactlyOnceWith(ctx.db, {
			organizationId: org,
			periodStart: coverage.periodStart,
			periodEnd: coverage.periodEnd,
		});
		expect(BillingOverviewSchema.parse(result).workstationCostCoverage).toEqual(
			coverage,
		);
		expect(result.period).toBeNull();
		expect(result.snapshot.customerChargeMicros).toBe(0);
	});
	it("cannot publish a fresh zero when coverage query rejects", async () => {
		storage.coverage.mockRejectedValue(new Error("coverage read failed"));
		await expect(
			createRouterClient(billingContractRouter, {
				context: context(),
			}).getOverview(),
		).rejects.toThrow("coverage read failed");
	});
	it("requires billing read permission before accessing coverage", async () => {
		await expect(
			createRouterClient(billingContractRouter, {
				context: context([]),
			}).getOverview(),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(storage.coverage).not.toHaveBeenCalled();
	});
	it("retains managed settlement boundary", async () => {
		const ctx = context();
		ctx.env.TEDIX_BILLING_SETTLEMENT_MODE = "self-managed";
		await expect(
			createRouterClient(billingContractRouter, { context: ctx }).getOverview(),
		).rejects.toThrow();
		expect(storage.coverage).not.toHaveBeenCalled();
	});
	it("does not alias missing org to account-wide rows", async () => {
		const ctx = context();
		ctx.organizationId = undefined;
		await expect(
			createRouterClient(billingContractRouter, { context: ctx }).getOverview(),
		).rejects.toThrow();
		expect(storage.coverage).not.toHaveBeenCalled();
	});
});
