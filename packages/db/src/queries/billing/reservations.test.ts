import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	billingAccounts,
	billingCapacityAllocations,
	billingPlanVersions,
	billingUsageCharges,
	billingUsagePeriods,
	billingUsageReservations,
} from "../../schema/billing";
import { organizations } from "../../schema/organizations";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	getInferenceCapacityDailyOverview,
	transferSponsoredCapacity,
} from "./capacity-allocations";
import { billingBlockingReason, reserveBillingUsage } from "./reservations";

/** A healthy organization: active, in overage, internally billed, room to spare. */
function healthy(
	overrides: Partial<Parameters<typeof billingBlockingReason>[0]> = {},
) {
	return billingBlockingReason({
		status: "active",
		now: "2026-09-27T12:00:00.000Z",
		periodStart: "2026-09-01T00:00:00.000Z",
		periodEnd: "2026-10-01T00:00:00.000Z",
		allowOverage: true,
		remainingIncludedTokens: 0,
		billingMode: "internal",
		stripeCustomerId: null,
		availableCreditMicros: 0,
		hardSpendLimitMicros: null,
		customerChargeMicros: 0,
		reservedChargeMicros: 0,
		estimatedChargeMicros: 1,
		effectiveDailyTokens: 4_000_000,
		effectiveDailySpendMicros: 20_000_000,
		usedDailyTokens: 398_283,
		usedDailySpendMicros: 224_247,
		estimatedTokens: 20_000,
		...overrides,
	});
}

describe("billingBlockingReason", () => {
	it("names the daily ceiling for trial and unfunded accounts", () => {
		// 1,992,414 of 2,000,000 consumed, so 7,586 left.
		// The gate denied it with inference_capacity_exhausted because a real
		// turn does not fit in 7,586 tokens — the remaining headroom is not the
		// question, whether the request fits is.
		expect(
			healthy({
				status: "trial",
				effectiveDailyTokens: 2_000_000,
				usedDailyTokens: 1_992_414,
			}),
		).toBe("inference_capacity_exhausted");
		expect(
			healthy({
				status: "trial",
				effectiveDailySpendMicros: 1_000,
				usedDailySpendMicros: 1_000,
			}),
		).toBe("inference_capacity_exhausted");
		expect(
			healthy({
				status: "trial",
				effectiveDailySpendMicros: 1_000,
				usedDailySpendMicros: 999,
				estimatedChargeMicros: 1,
			}),
		).toBe(null);
		expect(
			healthy({
				status: "trial",
				effectiveDailySpendMicros: 1_000,
				usedDailySpendMicros: 999,
				estimatedChargeMicros: 2,
			}),
		).toBe("inference_capacity_exhausted");
	});

	it("uses monthly capacity for funded active overage accounts", () => {
		const spentDay = {
			effectiveDailyTokens: 1,
			effectiveDailySpendMicros: 1,
			usedDailyTokens: 1_000,
			usedDailySpendMicros: 1_000,
		};
		expect(healthy(spentDay)).toBe(null);
		expect(healthy({ ...spentDay, billingMode: "invoice" })).toBe(null);
		expect(
			healthy({
				...spentDay,
				billingMode: "stripe",
				stripeCustomerId: "cus_1",
			}),
		).toBe(null);
		expect(healthy({ ...spentDay, billingMode: "stripe" })).toBe(
			"payment_required",
		);
		expect(healthy({ ...spentDay, allowOverage: false })).toBe(
			"monthly_allowance_exhausted",
		);
	});

	it("names an inactive subscription before anything else", () => {
		expect(healthy({ status: "suspended" })).toBe("subscription_inactive");
		expect(healthy({ status: "cancelled" })).toBe("subscription_inactive");
		// A spent day on a suspended account still reports the account first: it
		// is the condition that will not clear on its own at UTC midnight.
		expect(
			healthy({
				status: "suspended",
				effectiveDailyTokens: 1,
				usedDailyTokens: 99,
			}),
		).toBe("subscription_inactive");
	});

	it("reports an inactive period and a reached hard spend limit", () => {
		expect(healthy({ now: "2026-10-01T00:00:00.000Z" })).toBe(
			"billing_period_inactive",
		);
		expect(
			healthy({ hardSpendLimitMicros: 10, customerChargeMicros: 10 }),
		).toBe("hard_spend_limit");
		expect(
			healthy({
				hardSpendLimitMicros: 10,
				customerChargeMicros: 10,
				estimatedChargeMicros: 0,
			}),
		).toBe(null);
	});

	it("checks whether a nominal turn fits the remaining monthly allowance", () => {
		expect(healthy({ allowOverage: false, remainingIncludedTokens: 100 })).toBe(
			"monthly_allowance_exhausted",
		);
		expect(
			healthy({ billingMode: "stripe", remainingIncludedTokens: 100 }),
		).toBe("payment_required");
	});

	it("separates an exhausted allowance from an unfundable overage", () => {
		// No overage allowed and nothing included left: the allowance is the wall.
		expect(healthy({ allowOverage: false })).toBe(
			"monthly_allowance_exhausted",
		);
		// Overage allowed, but a Stripe account with no customer and no credit
		// has nothing to charge it to.
		expect(healthy({ billingMode: "stripe" })).toBe("payment_required");
		// The same account with either funding source is fine.
		expect(healthy({ billingMode: "stripe", stripeCustomerId: "cus_1" })).toBe(
			null,
		);
		expect(healthy({ billingMode: "stripe", availableCreditMicros: 1 })).toBe(
			null,
		);
	});

	it("does NOT explain the 2026-09-14 production denial", () => {
		// This is the exact shape that was denied in production while the console
		// reported available. Every modeled rule passes, which is the point: the
		// gate refused on a condition none of these copies carry. Kept as a test
		// so that when the cause is found, this assertion has to change with it.
		expect(healthy()).toBe(null);
	});
});

describe("daily reservation expiry before the reaper", () => {
	const now = "2026-07-27T12:00:00.000Z";
	const expiresAt = "2026-07-27T12:10:00.000Z";

	function setup() {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF;");
		sqlite.exec(
			schemaDdl(
				organizations,
				billingPlanVersions,
				billingAccounts,
				billingUsageReservations,
				billingUsagePeriods,
				billingUsageCharges,
				billingCapacityAllocations,
			),
		);
		sqlite.exec(`
			INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org');
			INSERT INTO billing_plan_versions (
				id, plan_key, version, status, name, included_monthly_tokens,
				max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task,
				default_daily_token_limit, default_daily_message_limit,
				effective_at, created_at
			) VALUES ('starter-v1', 'starter', 1, 'active', 'Starter', 1000,
				1, 2, 8, 100, 100, '2026-07-01T00:00:00.000Z', '${now}');
			INSERT INTO billing_accounts (
				organization_id, plan_version_id, status, billing_mode,
				stripe_environment, period_start, period_end, created_at, updated_at
			) VALUES ('org-1', 'starter-v1', 'trial', 'trial', 'live',
				'2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '${now}', '${now}');
			INSERT INTO billing_usage_periods (
				id, organization_id, plan_version_id, period_start, period_end,
				included_tokens, created_at, updated_at
			) VALUES ('period-1', 'org-1', 'starter-v1',
				'2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
				1000, '${now}', '${now}');
		`);
		return { db: createDbClient(createD1Facade(sqlite)), sqlite };
	}

	function reservation(
		sqlite: DatabaseSync,
		id: string,
		status: "reserved" | "settled",
		tokens: number,
		expiry: string,
		chargeMicros = 0,
	) {
		sqlite
			.prepare(`
			INSERT INTO billing_usage_reservations (
				id, organization_id, plan_version_id, tedi_id, status, source,
				provider, model, estimated_input_tokens, estimated_output_tokens,
				estimated_charge_micros, period_start, period_end, idempotency_key,
				expires_at, created_at, updated_at
			) VALUES (?, 'org-1', 'starter-v1', 'tedi-1', ?, 'operator',
				'azure-openai', 'gpt-5.6-terra', ?, 0, ?,
				'2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
				?, ?, ?, ?)
		`)
			.run(id, status, tokens, chargeMicros, `test:${id}`, expiry, now, now);
	}

	it("admits against settled actuals and active holds while ignoring expired holds", async () => {
		const { db, sqlite } = setup();
		reservation(sqlite, "settled-actual", "settled", 80, expiresAt);
		sqlite.exec(`
			INSERT INTO billing_usage_charges (
				id, organization_id, reservation_id, usage_period_id,
				provider, model, source, input_tokens, output_tokens,
				occurred_at, created_at
			) VALUES ('charge-1', 'org-1', 'settled-actual', 'period-1',
				'azure-openai', 'gpt-5.6-terra', 'operator', 15, 5, '${now}', '${now}');
		`);
		reservation(sqlite, "active", "reserved", 20, expiresAt);
		reservation(
			sqlite,
			"expired",
			"reserved",
			200,
			"2026-07-27T11:59:59.000Z",
			100,
		);

		const attempt = (
			id: string,
			aiGatewayLimits: {
				organizationDailyTokenLimit?: number;
				organizationDailySpendLimitMicros?: number;
				tediDailyTokenLimit?: number;
				tediDailySpendLimitMicros?: number;
			},
		) =>
			reserveBillingUsage(db, {
				id,
				organizationId: "org-1",
				tediId: "tedi-1",
				source: "operator",
				provider: "azure-openai",
				model: "gpt-5.6-terra",
				estimatedInputTokens: id === "fits" ? 60 : 1,
				estimatedOutputTokens: 0,
				idempotencyKey: `test:${id}`,
				expiresAt,
				now,
				aiGatewayLimits,
			});

		expect(
			await attempt("fits", {
				organizationDailyTokenLimit: 100,
				organizationDailySpendLimitMicros: 0,
				tediDailyTokenLimit: 100,
				tediDailySpendLimitMicros: 0,
			}),
		).toMatchObject({ allowed: true });
		expect(
			sqlite
				.prepare(
					"SELECT status FROM billing_usage_reservations WHERE id='expired'",
				)
				.get(),
		).toMatchObject({ status: "reserved" });
		expect(
			await getInferenceCapacityDailyOverview(db, {
				organizationId: "org-1",
				stripeEnvironment: "live",
				now,
			}),
		).toMatchObject({ usedTokens: 100, usedSpendMicros: 0 });
		expect(
			await attempt("over-limit", { organizationDailyTokenLimit: 100 }),
		).toMatchObject({ allowed: false, code: "inference_capacity_exhausted" });
		expect(
			await attempt("spend-only", {
				organizationDailySpendLimitMicros: 0,
				tediDailySpendLimitMicros: 0,
			}),
		).toMatchObject({ allowed: true });
	});

	it("does not debit an expired sponsor hold when transferring capacity", async () => {
		const { db, sqlite } = setup();
		sqlite.exec(`
			UPDATE billing_accounts SET status='active' WHERE organization_id='org-1';
			INSERT INTO organizations (id, name, slug) VALUES ('org-2', 'Customer', 'customer');
			INSERT INTO billing_accounts (
				organization_id, plan_version_id, status, billing_mode,
				stripe_environment, period_start, period_end, created_at, updated_at
			) VALUES ('org-2', 'starter-v1', 'trial', 'trial', 'live',
				'2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z',
				'${now}', '${now}');
		`);
		reservation(
			sqlite,
			"expired-sponsor",
			"reserved",
			90,
			"2026-07-27T11:59:59.000Z",
			100,
		);
		const transfer = await transferSponsoredCapacity(db, {
			transferId: "first-transfer",
			sponsorOrganizationId: "org-1",
			customerOrganizationId: "org-2",
			providerInstallationId: "installation-1",
			budgetRevision: 1,
			budgetDay: "2026-07-27",
			tokenAmount: 50,
			spendAmountMicros: 10,
			customerLowWatermarkTokens: 1,
			customerLowWatermarkSpendMicros: 1,
			sponsorDailyTokenLimit: 100,
			sponsorDailySpendLimitMicros: 10,
			stripeEnvironment: "live",
			expiresAt: "2026-07-28T00:00:00.000Z",
			createdAt: now,
		});
		expect(transfer.sponsorAllocation.tokenAmount).toBe(-50);
		expect(transfer.customerAllocation.tokenAmount).toBe(50);
	});
});
