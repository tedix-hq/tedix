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
import { getBillingBalanceSnapshot } from "./credits";
import { effectiveAllowOverage, setBillingOverageSettings } from "./overage";
import { reserveBillingUsage } from "./reservations";

const now = "2026-11-10T12:00:00.000Z";
const expiresAt = "2026-11-10T12:10:00.000Z";
const UNIT_PRICE_MICROS = 1_000_000;

/** A paid Stripe account on a plan that sells overage, allowance fully used. */
function setup(
	plan: { priceMicros: number } = { priceMicros: UNIT_PRICE_MICROS },
) {
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
			id, plan_key, version, status, name, currency, included_monthly_tokens,
			overage_unit_tokens, overage_unit_price_micros, allow_overage,
			max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task,
			default_daily_token_limit, default_daily_message_limit,
			effective_at, created_at
		) VALUES ('growth-v5', 'growth', 5, 'active', 'Growth', 'eur', 1000,
			1000, ${plan.priceMicros}, 1,
			4, 3, 10, 1000000, 100, '2026-11-01T00:00:00.000Z', '${now}');
		INSERT INTO billing_accounts (
			organization_id, plan_version_id, status, billing_mode,
			stripe_environment, stripe_customer_id, period_start, period_end,
			created_at, updated_at
		) VALUES ('org-1', 'growth-v5', 'active', 'stripe', 'live', 'cus_1',
			'2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z', '${now}', '${now}');
		INSERT INTO billing_usage_periods (
			id, organization_id, plan_version_id, period_start, period_end,
			included_tokens, used_input_tokens, created_at, updated_at
		) VALUES ('period-1', 'org-1', 'growth-v5',
			'2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z',
			1000, 1000, '${now}', '${now}');
	`);
	const db = createDbClient(createD1Facade(sqlite));
	const attempt = (id: string) =>
		reserveBillingUsage(db, {
			id,
			organizationId: "org-1",
			tediId: "tedi-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 1000,
			estimatedOutputTokens: 0,
			idempotencyKey: `test:${id}`,
			expiresAt,
			now,
		});
	return { db, sqlite, attempt };
}

describe("admin overage opt-in", () => {
	it("stops at the included allowance until an admin enables overage", async () => {
		const { db, attempt } = setup();
		const snapshot = await getBillingBalanceSnapshot(db, "org-1", now);
		expect(snapshot).toMatchObject({
			allowOverage: false,
			overageEnabled: false,
			hardSpendLimitMicros: null,
		});
		expect(await attempt("blocked")).toMatchObject({
			allowed: false,
			code: "monthly_allowance_exhausted",
		});
	});

	it("meters overage up to the monthly cap, then hard-stops", async () => {
		const { db, attempt } = setup();
		expect(
			await setBillingOverageSettings(db, {
				organizationId: "org-1",
				enabled: true,
				monthlyCapMicros: 2_500_000,
				now,
			}),
		).toBe(true);
		expect(await getBillingBalanceSnapshot(db, "org-1", now)).toMatchObject({
			allowOverage: true,
			overageEnabled: true,
			hardSpendLimitMicros: 2_500_000,
		});

		expect(await attempt("first")).toMatchObject({
			allowed: true,
			reservation: { estimatedChargeMicros: UNIT_PRICE_MICROS },
		});
		expect(await attempt("second")).toMatchObject({ allowed: true });
		// 2,000,000 held + 1,000,000 more would exceed the 2,500,000 cap.
		expect(await attempt("over-cap")).toMatchObject({
			allowed: false,
			code: "hard_spend_limit",
		});
	});

	it("disabling overage blocks again even with a cap left in place", async () => {
		const { db, attempt } = setup();
		await setBillingOverageSettings(db, {
			organizationId: "org-1",
			enabled: true,
			monthlyCapMicros: 10_000_000,
			now,
		});
		expect(await attempt("while-on")).toMatchObject({ allowed: true });
		await setBillingOverageSettings(db, {
			organizationId: "org-1",
			enabled: false,
			monthlyCapMicros: null,
			now,
		});
		expect(await attempt("after-off")).toMatchObject({
			allowed: false,
			code: "monthly_allowance_exhausted",
		});
	});

	it("needs no opt-in for zero-priced overage", async () => {
		const { db, attempt } = setup({ priceMicros: 0 });
		expect(await getBillingBalanceSnapshot(db, "org-1", now)).toMatchObject({
			allowOverage: true,
			overageEnabled: false,
		});
		expect(await attempt("internal")).toMatchObject({ allowed: true });
	});

	it("reports a missing billing account instead of inventing one", async () => {
		const { db } = setup();
		expect(
			await setBillingOverageSettings(db, {
				organizationId: "org-missing",
				enabled: true,
				monthlyCapMicros: 1,
				now,
			}),
		).toBe(false);
	});

	it("mirrors the SQL rule in TypeScript", () => {
		const priced = { allowOverage: true, overageUnitPriceMicros: 1 };
		expect(effectiveAllowOverage(priced, { overageEnabled: false })).toBe(
			false,
		);
		expect(effectiveAllowOverage(priced, { overageEnabled: true })).toBe(true);
		expect(
			effectiveAllowOverage(
				{ allowOverage: true, overageUnitPriceMicros: 0 },
				{ overageEnabled: false },
			),
		).toBe(true);
		expect(
			effectiveAllowOverage(
				{ allowOverage: false, overageUnitPriceMicros: 1 },
				{ overageEnabled: true },
			),
		).toBe(false);
	});
});
