import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import {
	billingAccounts,
	billingPlanVersions,
	billingUsageReservations,
	organizations,
} from "@tedix/db/schema";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import { correctBillingAccountPeriod } from "./plans";

const NOW = "2026-09-15T12:00:00.000Z";

function setup(
	periodStart: string,
	periodEnd: string,
	reservations: {
		input: number;
		output: number;
		chargeMicros: number;
	}[] = [],
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			organizations,
			billingPlanVersions,
			billingAccounts,
			billingUsageReservations,
		),
	);
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug) VALUES ('org-1', 'Org', 'org');
		INSERT INTO billing_plan_versions (
			id, plan_key, version, status, name, included_monthly_tokens,
			max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task,
			default_daily_token_limit, default_daily_message_limit, effective_at,
			created_at
		) VALUES (
			'plan-1', 'business', 3, 'active', 'Business', 2000000, 5, 5, 50,
			5000000, 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
		);
		INSERT INTO billing_accounts (
			organization_id, plan_version_id, status, billing_mode, period_start,
			period_end, entitlement_version, created_at, updated_at
		) VALUES (
			'org-1', 'plan-1', 'active', 'internal', '${periodStart}',
			'${periodEnd}', 7, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
		);
	`);
	reservations.forEach((r, index) => {
		sqlite.exec(`
			INSERT INTO billing_usage_reservations (
				id, organization_id, plan_version_id, status, source, provider,
				model, estimated_input_tokens, estimated_output_tokens,
				estimated_charge_micros, period_start, period_end,
				idempotency_key, expires_at, created_at, updated_at
			) VALUES (
				'res-${index}', 'org-1', 'plan-1', 'settled', 'operator',
				'azure-openai', 'gpt-5.6-terra', ${r.input}, ${r.output},
				${r.chargeMicros}, '${periodStart}', '${periodEnd}',
				'key-${index}', '2027-01-01T00:00:00.000Z',
				'2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'
			);
		`);
	});
	return createDbClient(createD1Facade(sqlite));
}

describe("correctBillingAccountPeriod", () => {
	it("puts a year-long window back onto a month", async () => {
		// One monthly allowance stretched over a year, which rollBillingPeriods
		// could not reach until 2027.
		const db = setup("2026-08-29T00:00:00.000Z", "2027-08-29T08:36:00.000Z");
		const updated = await correctBillingAccountPeriod(db, {
			organizationId: "org-1",
			periodStart: "2026-08-29T00:00:00.000Z",
			periodEnd: "2026-09-29T00:00:00.000Z",
			now: NOW,
			reason: "Annual window carried a monthly allowance",
		});
		expect(updated.periodEnd).toBe("2026-09-29T00:00:00.000Z");
		// The version bump is what makes downstream entitlement caches re-read,
		// and what fences a concurrent write. Seeded at 7, so it must be 8.
		expect(updated.entitlementVersion).toBe(8);
		const correction = (
			updated.metadata as { lastPeriodCorrection?: { reason?: string } }
		).lastPeriodCorrection;
		expect(correction?.reason).toBe(
			"Annual window carried a monthly allowance",
		);
	});

	it("refuses to re-open a window that usage was already metered against", async () => {
		const db = setup("2026-08-29T00:00:00.000Z", "2027-08-29T00:00:00.000Z");
		await expect(
			correctBillingAccountPeriod(db, {
				organizationId: "org-1",
				periodStart: "2026-07-01T00:00:00.000Z",
				periodEnd: "2026-08-01T00:00:00.000Z",
				now: NOW,
				reason: "backdate",
			}),
		).rejects.toThrow(/may not move periodStart earlier/);
	});

	it("records the allowance usage the reset detaches", async () => {
		// The reset is the point of a correction, but it must be reconstructable:
		// 3.88M of metered usage vanished from the allowance with nothing
		// written down until this.
		const db = setup("2026-08-29T00:00:00.000Z", "2027-08-29T00:00:00.000Z", [
			// Two settled turns against the window about to be replaced.
			{ input: 3_653_877, output: 230_490, chargeMicros: 139_250_000 },
			{ input: 1_000, output: 500, chargeMicros: 75_000 },
		]);
		const updated = await correctBillingAccountPeriod(db, {
			organizationId: "org-1",
			periodStart: "2026-08-29T00:00:00.000Z",
			periodEnd: "2026-09-29T00:00:00.000Z",
			now: NOW,
			reason: "Annual window carried a monthly allowance",
		});
		const reset = (
			updated.metadata as {
				lastPeriodCorrection?: {
					allowanceReset?: {
						orphanedTokens: number;
						orphanedChargeMicros: number;
					};
				};
			}
		).lastPeriodCorrection?.allowanceReset;
		// 3,653,877 in + 230,490 out = 3,884,367 tokens
		// detached from the allowance, plus the smaller turn.
		expect(reset).toEqual({
			orphanedTokens: 3_885_867,
			orphanedChargeMicros: 139_325_000,
		});
	});

	it("refuses an inverted window and an unexplained correction", async () => {
		const db = setup("2026-08-29T00:00:00.000Z", "2027-08-29T00:00:00.000Z");
		await expect(
			correctBillingAccountPeriod(db, {
				organizationId: "org-1",
				periodStart: "2026-10-01T00:00:00.000Z",
				periodEnd: "2026-09-01T00:00:00.000Z",
				now: NOW,
				reason: "inverted",
			}),
		).rejects.toThrow(/must end after it starts/);
		await expect(
			correctBillingAccountPeriod(db, {
				organizationId: "org-1",
				periodStart: "2026-08-29T00:00:00.000Z",
				periodEnd: "2026-09-29T00:00:00.000Z",
				now: NOW,
				reason: "   ",
			}),
		).rejects.toThrow(/must record a reason/);
	});
});
