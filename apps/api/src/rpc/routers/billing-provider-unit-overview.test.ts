import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { BillingOverviewSchema } from "@tedix/api-contract/schemas/billing";
import type { BaseContext } from "../orpc";
const storage = vi.hoisted(() => ({
	coverage: vi.fn(),
	daily: vi.fn(),
	snapshot: vi.fn(),
	tedis: vi.fn(),
	members: vi.fn(),
}));
vi.mock("@tedix/db/queries/billing/dashboard", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/billing/dashboard")>()),
	listDailyCreditUsage: storage.daily,
}));
vi.mock("@tedix/db/queries/billing/provider-usage", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/billing/provider-usage")
	>()),
	getWorkstationCostCoverage: storage.coverage,
}));
vi.mock("@tedix/db/queries/billing/credit-pool", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/billing/credit-pool")>()),
	getCreditPoolSnapshot: storage.snapshot,
	listCreditNotices: async () => [
		{ threshold: 80, reachedAt: "2026-09-18T00:00:00.000Z" },
	],
	listCreditSubjectUsage: async (
		_db: unknown,
		input: { subjectKind: "tedi" | "member" },
	) =>
		input.subjectKind === "tedi"
			? [
					{
						subjectKey: "tedi-1",
						usedCredits: 9_000,
						monthlyCapCredits: 10_000,
					},
				]
			: [
					{
						subjectKey: "member-sub",
						usedCredits: 3_000,
						monthlyCapCredits: null,
					},
				],
}));
vi.mock("@tedix/db/queries/tedis", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/tedis")>()),
	getTedisByOrganization: storage.tedis,
}));
vi.mock("@tedix/db/queries/organization-members", async (original) => ({
	...(await original<
		typeof import("@tedix/db/queries/organization-members")
	>()),
	getMembersByOrganization: storage.members,
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
describe("credits and workstation coverage in the billing overview", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		storage.coverage.mockResolvedValue(coverage);
		storage.snapshot.mockResolvedValue({
			organizationId: org,
			planVersionId: "growth-credits-v1",
			planKey: "growth",
			planName: "Growth",
			planPriceMicros: 200_000_000,
			status: "active",
			billingMode: "trial",
			stripeEnvironment: null,
			stripeCustomerId: null,
			periodStart: coverage.periodStart,
			periodEnd: coverage.periodEnd,
			planIncludedCredits: 15_000,
			includedCreditsOverride: null,
			includedCredits: 15_000,
			usedCredits: 12_000,
			includedUsedCredits: 12_000,
			remainingIncludedCredits: 3_000,
			topUpUsedCredits: 0,
			topUpCredits: 1_000,
			breakdown: { ai: 11_000, codeRuns: 500, services: 500 },
			heldCredits: 0,
			availableCredits: 4_000,
			payAsYouGo: {
				allowed: true,
				enabled: false,
				monthlyCapMicros: null,
				spentMicros: 0,
				usedCredits: 0,
			},
			creditFx: null,
			tediCap: null,
			tediUsedCredits: 0,
			memberCap: null,
			memberUsedCredits: 0,
		});
		storage.tedis.mockResolvedValue([{ id: "tedi-1", name: "Research" }]);
		storage.members.mockResolvedValue([
			{
				descopeUserId: "member-sub",
				name: "Admin",
				email: "admin@example.test",
			},
		]);
	});
	it("reports each activity's daily share of monthly credits", async () => {
		storage.daily.mockResolvedValue([
			{ day: "2026-09-01", kind: "ai", credits: 11_000 },
			{ day: "2026-09-18", kind: "code_run", credits: 500 },
			{ day: "2026-09-18", kind: "service", credits: 500 },
		]);
		const ctx = context();
		const client = createRouterClient(billingContractRouter, { context: ctx });
		const days = await client.getDailyUsage({ window: "month" });
		expect(days[0]).toMatchObject({ day: "2026-09-01", aiPercent: 68.75 });
		expect(days[17]).toMatchObject({
			codeRunPercent: 3.125,
			toolPercent: 3.125,
		});
		expect(
			days.reduce(
				(sum, day) =>
					sum + day.aiPercent + day.codeRunPercent + day.toolPercent,
				0,
			),
		).toBe(75);
		expect(storage.daily).toHaveBeenCalledWith(
			ctx.db,
			expect.objectContaining({
				organizationId: org,
				periodStart: coverage.periodStart,
			}),
		);
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
		expect(result.plan).toEqual({
			key: "growth",
			name: "Growth",
			priceMicros: 200_000_000,
			currency: "eur",
			includedCredits: 15_000,
		});
		expect(result.credits).toMatchObject({
			includedCredits: 15_000,
			usedCredits: 12_000,
			remainingIncludedCredits: 3_000,
			topUpCredits: 1_000,
			breakdown: { ai: 11_000, codeRuns: 500, services: 500 },
			notices: [{ threshold: 80, reachedAt: "2026-09-18T00:00:00.000Z" }],
			tedis: [
				{
					tediId: "tedi-1",
					name: "Research",
					usedCredits: 9_000,
					monthlyCapCredits: 10_000,
				},
			],
			members: [
				{
					userId: "member-sub",
					name: "Admin",
					usedCredits: 3_000,
					monthlyCapCredits: null,
				},
			],
		});
		// The fixture's September period is over, so the overview says so.
		expect(result.admission).toEqual({
			available: false,
			blockingReason: "billing_period_inactive",
			unblockAction: "none",
		});
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
