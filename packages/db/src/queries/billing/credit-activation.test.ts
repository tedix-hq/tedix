import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	billingAccounts,
	billingPlanVersions,
	billingUsageReservations,
	billingCreditEntries,
} from "../../schema/billing";
import { providerModelRateVersions } from "../../schema/provider-model-rates";
import { organizations } from "../../schema/organizations";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	configureCreditBilling,
	recordPaidCreditCoverage,
} from "./credit-activation";
import { buildIncludedCreditPeriodGrant } from "./credit-periods";
import {
	getActiveBillingPlanByKey,
	buildProvisionBillingAccountStatement,
	rollBillingPeriods,
	getBillingEntitlement,
	provisionBillingAccount,
} from "./plans";
const now = "2026-10-11T12:00:00.000Z";
const input = {
	organizationId: "org",
	expectedEntitlementVersion: 1,
	idempotencyKey: "activation-one",
	reason: "Opt-in test",
	includedMonthlyCreditMicros: 100_000_000,
	monthlyCapMicros: 100_000_000,
	perRunBudgetMicros: 1_000_000,
	rateBindings: [
		{
			rateVersionId: "receipt",
			inputConvention: "inclusive" as const,
			requestModelAliases: ["openai/fictional"],
		},
	],
};
function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF;");
	sqlite.exec(
		schemaDdl(
			providerModelRateVersions,
			organizations,
			billingPlanVersions,
			billingAccounts,
			billingUsageReservations,
			billingCreditEntries,
		),
	);
	sqlite.exec(`INSERT INTO organizations(id,name,slug) VALUES ('org','Fictional','fictional');
 INSERT INTO billing_plan_versions(id,plan_key,version,status,name,included_monthly_tokens,monthly_price_micros,max_tedis,max_cron_jobs_per_tedi,max_iterations_per_task,default_daily_token_limit,default_daily_message_limit,effective_at,created_at) VALUES ('plan','business',1,'active','Business',2000000,49000000,3,5,30,1,100,'2026-10-01T00:00:00.000Z','${now}');
 INSERT INTO billing_accounts(organization_id,plan_version_id,status,billing_mode,stripe_environment,stripe_customer_id,stripe_subscription_id,period_start,period_end,credit_balance_micros,created_at,updated_at) VALUES ('org','plan','active','stripe','test','cus-fixture','sub-fixture','2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',5000000,'${now}','${now}');
 INSERT INTO provider_model_rate_versions(id,provider,model_id,deployment_scope,effective_from,input_microusd_per_million,output_microusd_per_million,cache_read_microusd_per_million,cache_write_microusd_per_million,currency,evidence_uri,evidence_digest,verified_at,published_at,published_by,change_reason) VALUES ('receipt','fictional','fictional','fictional','2026-10-01T00:00:00.000Z',1000000,5000000,100000,2000000,'USD','receipt-url','digest','${now}','${now}','test','fixture');
 CREATE TRIGGER apply_credit AFTER INSERT ON billing_credit_entries BEGIN UPDATE billing_accounts SET credit_balance_micros=credit_balance_micros+NEW.amount_micros WHERE organization_id=NEW.organization_id; END;`);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}
describe("account-scoped credit billing activation", () => {
	it("a stale Stripe projection cannot overwrite a newly activated tariff", async () => {
		const { db } = setup();
		const projection = buildProvisionBillingAccountStatement(db, {
			organizationId: "org",
			planVersionId: "plan",
			status: "active",
			billingMode: "stripe",
			stripeEnvironment: "test",
			periodStart: "2026-10-01T00:00:00.000Z",
			periodEnd: "2026-11-01T00:00:00.000Z",
			now,
			metadata: { stripeStatus: "active" },
		});
		const activation = await configureCreditBilling(db, input, "owner", now);
		await projection;
		expect(
			(await getBillingEntitlement(db, "org"))?.account.planVersionId,
		).toBe(activation.planVersionId);
		expect(
			(await getBillingEntitlement(db, "org"))?.account.metadata
				.creditBillingActivation,
		).toBeTruthy();
	});
	it("preserves subscription and catalog, grants once without expiring purchased funds", async () => {
		const { db, sqlite } = setup();
		expect(await configureCreditBilling(db, input, "owner", now)).toMatchObject(
			{
				creditBalanceMicros: 105000000,
				entitlementVersion: 2,
				alreadyConfigured: false,
			},
		);
		expect(await configureCreditBilling(db, input, "owner", now)).toMatchObject(
			{ alreadyConfigured: true, creditBalanceMicros: 105000000 },
		);
		const current = await getBillingEntitlement(db, "org");
		expect(current?.account).toMatchObject({
			stripeCustomerId: "cus-fixture",
			stripeSubscriptionId: "sub-fixture",
			billingMode: "stripe",
			periodEnd: "2026-11-01T00:00:00.000Z",
		});
		expect(current?.plan).toMatchObject({
			status: "retired",
			monthlyPriceMicros: 49000000,
		});
		expect((await getActiveBillingPlanByKey(db, "business", now))?.id).toBe(
			"plan",
		);
		expect(
			sqlite
				.prepare("SELECT COUNT(*) n, expires_at FROM billing_credit_entries")
				.get(),
		).toMatchObject({ n: 1, expires_at: null });
		await expect(
			configureCreditBilling(
				db,
				{ ...input, includedMonthlyCreditMicros: 1 },
				"owner",
				now,
			),
		).rejects.toThrow("different input");
	});
	it("a lost CAS grants nothing and leaves no orphan opt-in plan", async () => {
		const { sqlite } = setup();
		let raced = false;
		const db = createDbClient(
			createD1Facade(sqlite, {
				onPrepare(query) {
					if (
						!raced &&
						query.startsWith('insert into "billing_plan_versions"')
					) {
						raced = true;
						sqlite.exec("UPDATE billing_accounts SET entitlement_version=2");
					}
				},
			}),
		);
		await expect(
			configureCreditBilling(db, input, "owner", now),
		).rejects.toThrow("fence");
		expect(
			sqlite.prepare("SELECT COUNT(*) n FROM billing_plan_versions").get(),
		).toMatchObject({ n: 1 });
		expect(
			sqlite.prepare("SELECT COUNT(*) n FROM billing_credit_entries").get(),
		).toMatchObject({ n: 0 });
		expect(
			sqlite
				.prepare("SELECT credit_balance_micros balance FROM billing_accounts")
				.get(),
		).toMatchObject({ balance: 5000000 });
		expect(
			await configureCreditBilling(
				db,
				{ ...input, expectedEntitlementVersion: 2 },
				"owner",
				now,
			),
		).toMatchObject({ creditBalanceMicros: 105000000 });
	});
	it("rejects stale entitlement and missing pricing before adding funds", async () => {
		const { db, sqlite } = setup();
		await expect(
			configureCreditBilling(
				db,
				{ ...input, expectedEntitlementVersion: 2 },
				"owner",
				now,
			),
		).rejects.toThrow("changed");
		await expect(
			configureCreditBilling(
				db,
				{
					...input,
					rateBindings: [
						{ ...input.rateBindings[0]!, rateVersionId: "missing" },
					],
				},
				"owner",
				now,
			),
		).rejects.toThrow("receipt");
		expect(
			sqlite
				.prepare("SELECT credit_balance_micros balance FROM billing_accounts")
				.get(),
		).toMatchObject({ balance: 5000000 });
	});
	it("retains the opt-in plan on renewal, deduplicates the paid period grant, and preserves audit evidence", async () => {
		const { db } = setup();
		await configureCreditBilling(db, input, "owner", now);
		const current = await getBillingEntitlement(db, "org");
		const renewal = {
			organizationId: "org",
			planKey: "business" as const,
			status: "active" as const,
			billingMode: "stripe" as const,
			stripeEnvironment: "test" as const,
			periodStart: "2026-11-01T00:00:00.000Z",
			periodEnd: "2026-12-01T00:00:00.000Z",
			now: "2026-11-01T00:00:00.000Z",
			metadata: { stripeStatus: "active" },
		};
		expect(await provisionBillingAccount(db, renewal)).toMatchObject({
			planVersionId: current!.plan.id,
			stripeCustomerId: "cus-fixture",
		});
		const grant = {
			organizationId: "org",
			planVersionId: current!.plan.id,
			periodStart: renewal.periodStart,
			periodEnd: renewal.periodEnd,
			amountMicros: 100000000,
			now: renewal.now,
		};
		await db.batch([buildIncludedCreditPeriodGrant(db, grant)]);
		await db.batch([buildIncludedCreditPeriodGrant(db, grant)]);
		expect(
			(await getBillingEntitlement(db, "org"))?.account.creditBalanceMicros,
		).toBe(205000000);
		// Same-key ordinary projection preserves the activation audit evidence.
		expect(
			(await getBillingEntitlement(db, "org"))?.account.metadata
				.creditBillingActivation,
		).toBeTruthy();
	});
	it("internal renewal carries forward purchased funds and grants the next allowance once", async () => {
		const { db, sqlite } = setup();
		sqlite.exec("UPDATE billing_accounts SET billing_mode='internal'");
		await configureCreditBilling(db, input, "owner", now);
		await rollBillingPeriods(db, "2026-11-01T00:00:00.000Z");
		await rollBillingPeriods(db, "2026-11-01T00:00:00.000Z");
		expect(
			(await getBillingEntitlement(db, "org"))?.account.creditBalanceMicros,
		).toBe(205000000);
		expect(
			sqlite.prepare("SELECT COUNT(*) n FROM billing_credit_entries").get(),
		).toMatchObject({ n: 2 });
	});
	it("late old invoices cannot fund a new window; annual paid coverage funds monthly renewals only once", async () => {
		const { db, sqlite } = setup();
		await configureCreditBilling(db, input, "owner", now);
		const old = {
			subscriptionId: "sub-fixture",
			invoiceId: "old",
			periodStart: "2026-09-01T00:00:00.000Z",
			periodEnd: "2026-10-01T00:00:00.000Z",
		};
		await recordPaidCreditCoverage(db, "org", old, now);
		await rollBillingPeriods(db, "2026-11-01T00:00:00.000Z");
		expect(
			(await getBillingEntitlement(db, "org"))?.account.creditBalanceMicros,
		).toBe(105000000);
		const annual = {
			subscriptionId: "sub-fixture",
			invoiceId: "annual",
			periodStart: "2026-10-01T00:00:00.000Z",
			periodEnd: "2027-10-01T00:00:00.000Z",
		};
		await recordPaidCreditCoverage(
			db,
			"org",
			annual,
			"2026-11-01T00:00:00.000Z",
		);
		await recordPaidCreditCoverage(
			db,
			"org",
			annual,
			"2026-11-01T00:00:00.000Z",
		);
		expect(
			(await getBillingEntitlement(db, "org"))?.account.creditBalanceMicros,
		).toBe(205000000);
		await rollBillingPeriods(db, "2026-12-01T00:00:00.000Z");
		await rollBillingPeriods(db, "2026-12-01T00:00:00.000Z");
		expect(
			(await getBillingEntitlement(db, "org"))?.account.creditBalanceMicros,
		).toBe(305000000);
		expect(
			sqlite.prepare("SELECT COUNT(*) n FROM billing_credit_entries").get(),
		).toMatchObject({ n: 3 });
	});
});
