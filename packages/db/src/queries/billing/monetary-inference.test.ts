import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	billingAccounts,
	billingPlanVersions,
	billingUsageReservations,
	billingUsagePeriods,
	billingUsageCharges,
	billingCapacityAllocations,
	billingCreditEntries,
	stripeMeterOutbox,
} from "../../schema/billing";
import { providerModelRateVersions } from "../../schema/provider-model-rates";
import { organizations } from "../../schema/organizations";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { reserveBillingUsage } from "./reservations";
import { settleBillingUsage } from "./settlement";
import { getBillingBalanceSnapshot } from "./credits";

const now = "2026-10-11T12:00:00.000Z";
const rate = {
	schemaVersion: 1,
	id: "fictional-price-1",
	version: 1,
	provider: "fictional",
	model: "fictional-model",
	deploymentScope: "fictional-scope",
	currency: "USD",
	funding: "managed",
	effectiveFrom: "2026-10-01T00:00:00.000Z",
	effectiveUntil: null,
	sourceReceipt: "fictional-receipt",
	creditValueMicros: 10_000,
	inputConvention: "inclusive",
	providerRates: {
		uncachedInput: 1_000_000,
		cacheRead: 100_000,
		cacheWrite: 2_000_000,
		output: 5_000_000,
	},
	customerRates: {
		uncachedInput: 1_000_000,
		cacheRead: 100_000,
		cacheWrite: 2_000_000,
		output: 5_000_000,
	},
};
function setup(balance = 10_000) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			providerModelRateVersions,
			organizations,
			billingPlanVersions,
			billingAccounts,
			billingUsageReservations,
			billingUsagePeriods,
			billingUsageCharges,
			billingCapacityAllocations,
			billingCreditEntries,
			stripeMeterOutbox,
		),
	);
	sqlite.exec(`INSERT INTO provider_model_rate_versions(id,provider,model_id,deployment_scope,effective_from,input_microusd_per_million,output_microusd_per_million,cache_read_microusd_per_million,cache_write_microusd_per_million,currency,evidence_uri,evidence_digest,verified_at,published_at,published_by,change_reason)
 VALUES ('fictional-price-1','fictional','fictional-model','fictional-scope','2026-10-01T00:00:00.000Z',1000000,5000000,100000,2000000,'USD','fictional-receipt','digest','${now}','${now}','test','fixture');
 INSERT INTO organizations(id,name,slug) VALUES ('org','Fictional','fictional');
	INSERT INTO billing_plan_versions(id,plan_key,version,status,name,included_monthly_tokens,max_tedis,max_cron_jobs_per_tedi,max_iterations_per_task,default_daily_token_limit,default_daily_message_limit,effective_at,created_at)
	VALUES ('plan','business',10,'active','Business',1,3,5,30,1,100,'2026-10-01T00:00:00.000Z','${now}');
	INSERT INTO billing_accounts(organization_id,plan_version_id,status,billing_mode,period_start,period_end,credit_balance_micros,created_at,updated_at)
	VALUES ('org','plan','active','internal','2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',${balance},'${now}','${now}');
	CREATE TRIGGER apply_credit AFTER INSERT ON billing_credit_entries BEGIN UPDATE billing_accounts SET credit_balance_micros=credit_balance_micros+NEW.amount_micros WHERE organization_id=NEW.organization_id; END;`);
	const config = {
		version: 1,
		currency: "USD",
		creditValueMicros: 10_000,
		pricing: "provider_pass_through",
		rates: [rate],
	};
	sqlite
		.prepare("UPDATE billing_plan_versions SET metadata=? WHERE id='plan'")
		.run(JSON.stringify({ monetaryInference: config }));
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}
function reservation(id: string) {
	return {
		id,
		organizationId: "org",
		source: "kernel" as const,
		provider: "fictional",
		model: "fictional-model",
		deploymentScope: "fictional-scope",
		estimatedInputTokens: 1_000,
		estimatedOutputTokens: 100,
		idempotencyKey: `key:${id}`,
		expiresAt: "2026-10-11T12:10:00.000Z",
		now,
		runId: "fictional-run",
		aiGatewayLimits: { organizationDailyTokenLimit: 1, tediDailyTokenLimit: 1 },
	};
}
function usage(reservationId: string, id = "charge") {
	return {
		id,
		reservationId,
		organizationId: "org",
		gatewayLogId: `gateway:${id}`,
		provider: "fictional",
		model: "fictional-model",
		source: "kernel" as const,
		inputTokens: 1_000,
		outputTokens: 50,
		providerCostMicros: 1_170,
		usageQuality: "provider_reported" as const,
		providerCostQuality: "estimated" as const,
		meteringReady: true,
		rateCardVersion: "fictional-price-1",
		occurredAt: now,
		now,
		metadata: { cacheReadTokens: 200, cacheWriteTokens: 100 },
	};
}
describe("opt-in monetary inference", () => {
	it("reserves monetary funds, ignoring token allowance gates only for opt-in plans", async () => {
		const { db } = setup();
		expect(await reserveBillingUsage(db, reservation("one"))).toMatchObject({
			allowed: true,
			reservation: { estimatedChargeMicros: 2_500 },
		});
		expect(await getBillingBalanceSnapshot(db, "org", now)).toMatchObject({
			creditBalanceMicros: 10_000,
			reservedChargeMicros: 2_500,
			availableCreditMicros: 7_500,
		});
	});
	it("concurrent reservations cannot spend the same wallet twice", async () => {
		const { db } = setup(4_000);
		const results = await Promise.all([
			reserveBillingUsage(db, reservation("one")),
			reserveBillingUsage(db, reservation("two")),
		]);
		expect(results.filter((r) => r.allowed)).toHaveLength(1);
		expect(results.find((r) => !r.allowed)).toMatchObject({
			code: "credit_allowance_exhausted",
		});
	});
	it("idempotent retries reuse the original hold", async () => {
		const { db, sqlite } = setup();
		await reserveBillingUsage(db, reservation("one"));
		await reserveBillingUsage(db, reservation("one"));
		expect(
			sqlite
				.prepare("SELECT COUNT(*) AS n FROM billing_usage_reservations")
				.get(),
		).toMatchObject({ n: 1 });
	});
	it("unknown model and invalid currency fail before provider execution", async () => {
		const { db, sqlite } = setup();
		expect(
			await reserveBillingUsage(db, {
				...reservation("one"),
				model: "unknown",
			}),
		).toMatchObject({ allowed: false, code: "pricing_unavailable" });
		sqlite.exec("UPDATE billing_plan_versions SET currency='eur'");
		expect(await reserveBillingUsage(db, reservation("two"))).toMatchObject({
			allowed: false,
			code: "pricing_unavailable",
		});
	});
	it("settles cached usage once, releases excess hold and preserves the price receipt", async () => {
		const { db, sqlite } = setup();
		await reserveBillingUsage(db, reservation("one"));
		const charge = await settleBillingUsage(db, usage("one"));
		expect(charge).toMatchObject({
			creditAppliedMicros: 1_170,
			customerChargeMicros: 0,
			meteredOverageTokens: 0,
		});
		await settleBillingUsage(db, usage("one"));
		expect(await getBillingBalanceSnapshot(db, "org", now)).toMatchObject({
			creditBalanceMicros: 8_830,
			reservedChargeMicros: 0,
		});
		expect(
			sqlite.prepare("SELECT COUNT(*) AS n FROM billing_credit_entries").get(),
		).toMatchObject({ n: 1 });
		expect(charge.metadata).toMatchObject({
			monetaryQuote: { rateSnapshot: { id: "fictional-price-1" } },
		});
	});
	it("malformed inclusive cache usage cannot be billed", async () => {
		const { db } = setup();
		await reserveBillingUsage(db, reservation("one"));
		await expect(
			settleBillingUsage(db, {
				...usage("one"),
				metadata: { cacheReadTokens: 1_001, cacheWriteTokens: 0 },
			}),
		).rejects.toThrow("tokens.uncachedInput");
	});
	it("expired holds stop blocking new admissions; late settlement cannot overdraw", async () => {
		const { db } = setup(2_500);
		await reserveBillingUsage(db, reservation("one"));
		const later = "2026-10-11T12:11:00.000Z";
		expect(
			await reserveBillingUsage(db, {
				...reservation("two"),
				now: later,
				expiresAt: "2026-10-11T12:20:00.000Z",
			}),
		).toMatchObject({ allowed: true });
		await settleBillingUsage(db, { ...usage("two", "new"), now: later });
		await settleBillingUsage(db, { ...usage("one", "late"), now: later });
		expect(
			(await getBillingBalanceSnapshot(db, "org", later))!.creditBalanceMicros,
		).toBeGreaterThanOrEqual(0);
	});
	it("late expired receipts cannot consume funds held by a newer call", async () => {
		const { db } = setup(2500);
		await reserveBillingUsage(db, reservation("old"));
		const later = "2026-10-11T12:11:00.000Z";
		await reserveBillingUsage(db, {
			...reservation("new"),
			now: later,
			expiresAt: "2026-10-11T12:20:00.000Z",
		});
		expect(
			await settleBillingUsage(db, { ...usage("old", "late-old"), now: later }),
		).toMatchObject({ creditAppliedMicros: 0 });
		expect(await getBillingBalanceSnapshot(db, "org", later)).toMatchObject({
			creditBalanceMicros: 2500,
			reservedChargeMicros: 2500,
		});
	});
	it("legacy plans retain token allowance denials", async () => {
		const { db, sqlite } = setup();
		sqlite.exec("UPDATE billing_plan_versions SET metadata='{}'");
		expect(await reserveBillingUsage(db, reservation("one"))).toMatchObject({
			allowed: false,
			code: "monthly_allowance_exhausted",
		});
	});
	it("legacy period cash spending does not consume the new monetary cap", async () => {
		const { db, sqlite } = setup();
		sqlite.exec(
			`UPDATE billing_accounts SET hard_spend_limit_micros=10000; INSERT INTO billing_usage_periods(id,organization_id,plan_version_id,period_start,period_end,included_tokens,customer_charge_micros,created_at,updated_at) VALUES('org:2026-10-01T00:00:00.000Z','org','plan','2026-10-01T00:00:00.000Z','2026-11-01T00:00:00.000Z',1,337100000,'${now}','${now}');`,
		);
		expect(await reserveBillingUsage(db, reservation("one"))).toMatchObject({
			allowed: true,
		});
		expect(await getBillingBalanceSnapshot(db, "org", now)).toMatchObject({
			customerChargeMicros: 337100000,
			monetarySpentMicros: 0,
		});
	});
	it("missing or mismatched scope and counterfeit rates are denied", async () => {
		const { db, sqlite } = setup();
		expect(
			await reserveBillingUsage(db, {
				...reservation("none"),
				deploymentScope: undefined,
			}),
		).toMatchObject({ allowed: false, code: "pricing_unavailable" });
		expect(
			await reserveBillingUsage(db, {
				...reservation("wrong"),
				deploymentScope: "wrong",
			}),
		).toMatchObject({ allowed: false, code: "pricing_unavailable" });
		sqlite.exec(
			"UPDATE provider_model_rate_versions SET input_microusd_per_million=999999",
		);
		expect(await reserveBillingUsage(db, reservation("fake"))).toMatchObject({
			allowed: false,
			code: "pricing_unavailable",
		});
	});
	it("an expired reservation retry cannot grant execution", async () => {
		const { db } = setup();
		await reserveBillingUsage(db, reservation("one"));
		expect(
			await reserveBillingUsage(db, {
				...reservation("one"),
				now: "2026-10-11T12:11:00.000Z",
			}),
		).toMatchObject({ allowed: false });
	});
	it("a run budget counts holds across successive calls", async () => {
		const { db, sqlite } = setup();
		sqlite.exec(
			"UPDATE billing_plan_versions SET metadata=json_set(metadata,'$.monetaryInference.perRunBudgetMicros',4000)",
		);
		expect(await reserveBillingUsage(db, reservation("one"))).toMatchObject({
			allowed: true,
		});
		expect(await reserveBillingUsage(db, reservation("two"))).toMatchObject({
			allowed: false,
		});
	});
	it("a mismatched actual price receipt cannot debit the wallet", async () => {
		const { db } = setup();
		await reserveBillingUsage(db, reservation("one"));
		await expect(
			settleBillingUsage(db, { ...usage("one"), rateCardVersion: "wrong" }),
		).rejects.toThrow("reserved monetary price");
		expect(await getBillingBalanceSnapshot(db, "org", now)).toMatchObject({
			creditBalanceMicros: 10000,
		});
	});
	it("concurrent distinct usage events cannot debit the same hold twice", async () => {
		const { db, sqlite } = setup();
		await reserveBillingUsage(db, reservation("one"));
		const results = await Promise.allSettled([
			settleBillingUsage(db, usage("one", "a")),
			settleBillingUsage(db, usage("one", "b")),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			sqlite.prepare("SELECT COUNT(*) AS n FROM billing_credit_entries").get(),
		).toMatchObject({ n: 1 });
		expect(await getBillingBalanceSnapshot(db, "org", now)).toMatchObject({
			creditBalanceMicros: 8830,
		});
	});
	it("already settled reservation cannot accept a different usage event", async () => {
		const { db } = setup();
		await reserveBillingUsage(db, reservation("one"));
		await settleBillingUsage(db, usage("one"));
		await expect(
			settleBillingUsage(db, usage("one", "different")),
		).rejects.toThrow("cannot settle");
	});
});
