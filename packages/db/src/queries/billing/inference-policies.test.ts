import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import {
	billingAccounts,
	billingInferencePolicies,
	billingPlanVersions,
	organizations,
	tedis,
} from "@tedix/db/schema";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { describe, expect, it } from "vite-plus/test";
import {
	getEffectiveInferencePolicies,
	upsertTediInferencePolicy,
} from "./inference-policies";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			organizations,
			tedis,
			billingPlanVersions,
			billingAccounts,
			billingInferencePolicies,
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
			'plan-1', 'growth', 1, 'active', 'Growth', 500000, 5, 5, 50,
			100000, 100, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
		);
		INSERT INTO billing_accounts (
			organization_id, plan_version_id, status, billing_mode, period_start,
			period_end, created_at, updated_at
		) VALUES (
			'org-1', 'plan-1', 'active', 'stripe', '2026-01-01T00:00:00.000Z',
			'2027-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
			'2026-01-01T00:00:00.000Z'
		);
		INSERT INTO tedis (id, organization_id, name, slug)
		VALUES ('tedi-1', 'org-1', 'Tedi', 'tedi');
	`);
	return {
		db: createDbClient(createD1Facade(sqlite)),
		sqlite,
	};
}

describe("effective inference policies", () => {
	it("creates and updates the canonical tedi admission policy", async () => {
		const { db } = setup();
		await upsertTediInferencePolicy(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			policy: { dailyTokenLimit: 50_000, dailySpendLimitMicros: 2_000_000 },
		});
		await expect(
			getEffectiveInferencePolicies(db, "org-1", "tedi-1"),
		).resolves.toMatchObject({
			tedi: { dailyTokenLimit: 50_000, dailySpendLimitMicros: 2_000_000 },
		});

		await upsertTediInferencePolicy(db, {
			organizationId: "org-1",
			tediId: "tedi-1",
			policy: { dailyTokenLimit: 75_000 },
		});
		await expect(
			getEffectiveInferencePolicies(db, "org-1", "tedi-1"),
		).resolves.toEqual({
			organization: { dailyTokenLimit: 100_000 },
			tedi: { dailyTokenLimit: 75_000 },
			tediFound: true,
		});
	});
	it("uses the pinned plan default when no override exists", async () => {
		const { db } = setup();
		await expect(getEffectiveInferencePolicies(db, "org-1")).resolves.toEqual({
			organization: { dailyTokenLimit: 100_000 },
			tediFound: true,
		});
	});

	it("composes explicit organization and tedi rows", async () => {
		const { db, sqlite } = setup();
		sqlite.exec(`
			INSERT INTO billing_inference_policies (
				id, organization_id, scope, subject_key, tedi_id,
				allowed_model_tiers, daily_spend_limit_micros, created_at, updated_at
			) VALUES
				('org-policy', 'org-1', 'organization', 'organization', NULL,
				 '["economy","balanced"]', 5000000,
				 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
				('tedi-policy', 'org-1', 'tedi', 'tedi-1', 'tedi-1',
				 '["economy"]', NULL,
				 '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
		`);
		await expect(
			getEffectiveInferencePolicies(db, "org-1", "tedi-1"),
		).resolves.toEqual({
			organization: {
				allowedModelTiers: ["economy", "balanced"],
				dailyTokenLimit: 100_000,
				dailySpendLimitMicros: 5_000_000,
			},
			tedi: { allowedModelTiers: ["economy"] },
			tediFound: true,
		});
	});
});
