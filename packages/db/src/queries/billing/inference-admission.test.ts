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
import { getEffectiveInferencePolicies } from "./inference-policies";
import { getInferenceAdmissionReads } from "./inference-admission";

/**
 * The facade is the point of this file: it rejects both D1 idioms that pass
 * locally and fail in production — `BEGIN` and duplicate output column names in
 * a batch — so a green run here is the evidence that the batch is D1-safe.
 */
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
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

describe("batched inference admission reads", () => {
	it("returns the entitlement and the policies from one batch", async () => {
		const { db } = setup();
		const reads = await getInferenceAdmissionReads(db, "org-1", "tedi-1");
		expect(reads.entitlement).toMatchObject({
			organizationId: "org-1",
			status: "active",
			profile: { key: "growth" },
		});
		expect(reads.policies).toEqual({
			organization: { dailyTokenLimit: 100_000 },
			tedi: undefined,
			tediFound: true,
		});
	});

	it("agrees with the serial resolver it replaced", async () => {
		const { db, sqlite } = setup();
		sqlite.exec(`
			INSERT INTO billing_inference_policies (
				id, organization_id, scope, subject_key, daily_token_limit,
				created_at, updated_at
			) VALUES (
				'pol-org', 'org-1', 'organization', 'organization', 80000,
				'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
			);
			INSERT INTO billing_inference_policies (
				id, organization_id, scope, subject_key, tedi_id, daily_token_limit,
				created_at, updated_at
			) VALUES (
				'pol-tedi', 'org-1', 'tedi', 'tedi-1', 'tedi-1', 40000,
				'2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
			);
		`);
		for (const tediId of ["tedi-1", null, "missing"]) {
			const batched = await getInferenceAdmissionReads(db, "org-1", tediId);
			const serial = await getEffectiveInferencePolicies(db, "org-1", tediId);
			expect(batched.policies).toEqual(serial);
		}
	});

	it("reports an organization with no billing account as unentitled", async () => {
		const { db } = setup();
		// The caller denies on `entitlement` before it looks at `policies`; this
		// only pins that both are null rather than the policies being a throw.
		await expect(
			getInferenceAdmissionReads(db, "org-missing", "tedi-1"),
		).resolves.toEqual({ entitlement: null, policies: null });
	});

	it("drops the plan read the entitlement already covers", async () => {
		const { db, sqlite } = setup();
		const statements: string[] = [];
		const original = sqlite.prepare.bind(sqlite);
		// @ts-expect-error -- test double over the node:sqlite handle
		sqlite.prepare = (sql: string) => {
			statements.push(sql);
			return original(sql);
		};
		await getInferenceAdmissionReads(db, "org-1", "tedi-1");
		const planReads = statements.filter((sql) =>
			sql.includes("billing_plan_versions"),
		);
		// One join for the entitlement, and no second read of the same rows just
		// to recover `default_daily_token_limit`.
		expect(planReads).toHaveLength(1);
	});
});
