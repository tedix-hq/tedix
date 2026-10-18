import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { auditEvents } from "../../schema/audit-events";
import {
	billingAccounts,
	billingPlanVersions,
	billingUsageReservations,
} from "../../schema/billing";
import { organizations } from "../../schema/organizations";
import { organizationMembers } from "../../schema/organization-members";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { getOrganizationFeatures } from "../organizations";
import {
	getRuntimeEntitlement,
	runtimeEntitlementIsActive,
} from "../runtime-entitlements";
import { assignInternalPlan } from "./internal-plan";
import { getBillingEntitlement, rollBillingPeriods } from "./plans";
import { billingBlockingReason } from "./reservations";

const actor = { id: "operator", type: "user" };
const now = "2026-10-18T12:00:00.000Z";
const input = {
	organizationId: "org-1",
	planKey: "enterprise" as const,
	idempotencyKey: "complimentary-v1",
	reason: "Owner authorized internal workspace",
};

function setup(account = true) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			organizations,
			billingAccounts,
			billingPlanVersions,
			billingUsageReservations,
			auditEvents,
			organizationMembers,
		),
	);
	sqlite.exec(`
		INSERT INTO organizations (id, name, slug, features) VALUES ('org-1', 'Example', 'example', '{"os":true,"maxTeamMembers":2}');
		INSERT INTO billing_plan_versions (id, plan_key, version, status, name, included_monthly_tokens, max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task, default_daily_token_limit, default_daily_message_limit, allow_overage, effective_at, created_at)
		VALUES ('enterprise-1', 'enterprise', 1, 'active', 'Enterprise', 0, -1, -1, 64, -1, -1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
		INSERT INTO organization_members (id, organization_id, descope_user_id, email, role, status) VALUES ('invite-1', 'org-1', 'pending:invite-1', 'admin@example.test', 'admin', 'invited');
	`);
	if (account)
		sqlite.exec(
			`INSERT INTO billing_accounts (organization_id, plan_version_id, status, billing_mode, period_start, period_end, entitlement_version, created_at, updated_at) VALUES ('org-1', 'enterprise-1', 'trial', 'trial', '2026-10-18T11:00:00.000Z', '2026-11-18T11:00:00.000Z', 4, '${now}', '${now}');`,
		);
	return {
		sqlite,
		db: createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 })),
	};
}

describe("complimentary internal plan assignment", () => {
	it.each([true, false])(
		"updates both entitlement layers and keeps invitations (account=%s)",
		async (account) => {
			const { db, sqlite } = setup(account);
			await assignInternalPlan(db, input, actor, now);
			expect(
				await getOrganizationFeatures(db, input.organizationId),
			).toMatchObject({
				maxTeamMembers: -1,
				maxApps: -1,
				maxCmsSites: -1,
				maxTedis: -1,
				maxTokensPerMonth: -1,
				os: true,
			});
			const entitlement = (await getBillingEntitlement(
				db,
				input.organizationId,
			))!;
			expect(entitlement.account).toMatchObject({
				billingMode: "internal",
				status: "active",
				stripeCustomerId: null,
				stripeSubscriptionId: null,
				hardSpendLimitMicros: null,
			});
			const runtime = (await getRuntimeEntitlement(db, input.organizationId))!;
			expect(runtime.profile.key).toBe("enterprise");
			expect(runtimeEntitlementIsActive(runtime, Date.parse(now))).toBe(true);
			expect(
				billingBlockingReason({
					status: runtime.status,
					now,
					periodStart: runtime.effectivePeriod.startsAt,
					periodEnd: runtime.effectivePeriod.endsAt,
					allowOverage: true,
					remainingIncludedTokens: 0,
					billingMode: "internal",
					stripeCustomerId: null,
					availableCreditMicros: 0,
					hardSpendLimitMicros: null,
					customerChargeMicros: 0,
					reservedChargeMicros: 0,
					estimatedChargeMicros: 0,
					effectiveDailyTokens: -1,
					effectiveDailySpendMicros: null,
					usedDailyTokens: 0,
					usedDailySpendMicros: 0,
					estimatedTokens: 10000000,
				}),
			).toBeNull();
			expect(
				sqlite
					.prepare("SELECT email, role, status FROM organization_members")
					.get(),
			).toMatchObject({
				email: "admin@example.test",
				role: "admin",
				status: "invited",
			});
			expect(
				sqlite.prepare("SELECT actor_id, action FROM audit_events").get(),
			).toMatchObject({
				actor_id: "operator",
				action: "billing.internal_plan_assigned",
			});
			await rollBillingPeriods(db, "2026-11-18T12:00:01.000Z");
			expect(
				runtimeEntitlementIsActive(
					(await getRuntimeEntitlement(db, input.organizationId))!,
					Date.parse("2026-11-18T12:00:01.000Z"),
				),
			).toBe(true);
		},
	);

	it("replays without renewing periods or duplicating audit; rejects changed input", async () => {
		const { db, sqlite } = setup();
		await assignInternalPlan(db, input, actor, now);
		const before = await getBillingEntitlement(db, input.organizationId);
		expect(
			await assignInternalPlan(db, input, actor, "2026-10-19T12:00:00.000Z"),
		).toEqual({ alreadyAssigned: true });
		expect(await getBillingEntitlement(db, input.organizationId)).toEqual(
			before,
		);
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM audit_events").get(),
		).toMatchObject({ n: 1 });
		await expect(
			assignInternalPlan(db, { ...input, reason: "changed" }, actor, now),
		).rejects.toThrow(/different input/);
	});

	it.each(["stripe", "invoice", "customer", "subscription"])(
		"refuses externally billed account: %s",
		async (kind) => {
			const { db, sqlite } = setup();
			if (kind === "customer")
				sqlite.exec(
					"UPDATE billing_accounts SET stripe_customer_id = 'customer'",
				);
			else if (kind === "subscription")
				sqlite.exec(
					"UPDATE billing_accounts SET stripe_subscription_id = 'subscription'",
				);
			else
				sqlite
					.prepare("UPDATE billing_accounts SET billing_mode = ?")
					.run(kind);
			await expect(assignInternalPlan(db, input, actor, now)).rejects.toThrow(
				/externally billed/,
			);
			expect(
				await getOrganizationFeatures(db, input.organizationId),
			).toMatchObject({ maxTeamMembers: 2 });
		},
	);

	it("rolls back account and features if audit persistence fails", async () => {
		const { db, sqlite } = setup();
		sqlite.exec(
			"CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;",
		);
		await expect(assignInternalPlan(db, input, actor, now)).rejects.toThrow();
		expect(
			(await getBillingEntitlement(db, input.organizationId))!.account
				.billingMode,
		).toBe("trial");
		expect(
			await getOrganizationFeatures(db, input.organizationId),
		).toMatchObject({ maxTeamMembers: 2 });
	});

	it("refuses a plan change while inference reservations are live", async () => {
		const { db, sqlite } = setup();
		sqlite.exec(
			`INSERT INTO billing_usage_reservations (id, organization_id, plan_version_id, status, source, provider, model, estimated_input_tokens, estimated_output_tokens, estimated_charge_micros, period_start, period_end, idempotency_key, expires_at, created_at, updated_at) VALUES ('reservation', 'org-1', 'enterprise-1', 'reserved', 'operator', 'provider', 'model', 100, 10, 0, '${now}', '2026-11-18T12:00:00.000Z', 'reservation-key', '2026-10-18T12:05:00.000Z', '${now}', '${now}');`,
		);
		await expect(assignInternalPlan(db, input, actor, now)).rejects.toThrow(
			/in-flight reservations/,
		);
		expect(
			(await getBillingEntitlement(db, input.organizationId))!.account
				.billingMode,
		).toBe("trial");
		expect(
			await getOrganizationFeatures(db, input.organizationId),
		).toMatchObject({ maxTeamMembers: 2 });
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM audit_events").get(),
		).toMatchObject({ n: 0 });
	});

	it("does not alter features when account CAS loses a race", async () => {
		const { db, sqlite } = setup();
		const originalBatch = db.batch.bind(db);
		db.batch = (async (statements: Parameters<typeof db.batch>[0]) => {
			sqlite.exec(
				"UPDATE billing_accounts SET entitlement_version = entitlement_version + 1",
			);
			return originalBatch(statements);
		}) as typeof db.batch;
		await expect(assignInternalPlan(db, input, actor, now)).rejects.toThrow(
			/changed/,
		);
		expect(
			await getOrganizationFeatures(db, input.organizationId),
		).toMatchObject({ maxTeamMembers: 2 });
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM audit_events").get(),
		).toMatchObject({ n: 0 });
	});
});
