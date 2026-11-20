import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import {
	billingAccounts,
	billingCreditCaps,
	billingCreditConsumptions,
	billingCreditMeterOutbox,
	billingCreditNotices,
	billingCreditTopUps,
	billingCreditUsageTotals,
	billingPlanVersions,
	billingServiceCreditReservations,
	billingUsageCharges,
	billingUsagePeriods,
	billingUsageReservations,
} from "@tedix/db/schema/billing";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { tableDdl } from "@tedix/db/test/schema-ddl";
import type { VoiceBillingAttempt } from "@tedix/voice/billing";
import {
	createVoiceBilling,
	finishRuntimeVoiceUsage,
	reserveVoiceUsage,
	VoiceCreditRefusal,
} from "./voice-billing";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const SCOPE =
	'["azure-openai","acct","gw","https://fictional.openai.azure.com","gpt-transcribe"]';

const attempt: VoiceBillingAttempt = {
	provider: "azure-openai",
	model: "gpt-transcribe",
	deploymentScope: SCOPE,
	usageKind: "voice_stt",
	unit: "seconds",
	estimatedQuantity: 120,
};

/** `provider_model_rate_versions`; its schema module is not a package export. */
const RATE_TABLE_DDL = `CREATE TABLE provider_model_rate_versions (
	id TEXT PRIMARY KEY, provider TEXT NOT NULL, model_id TEXT NOT NULL,
	deployment_scope TEXT NOT NULL, input_token_min INTEGER NOT NULL DEFAULT 0,
	input_token_max INTEGER, effective_from TEXT NOT NULL,
	input_microusd_per_million INTEGER NOT NULL, output_microusd_per_million INTEGER NOT NULL,
	cache_read_microusd_per_million INTEGER NOT NULL,
	cache_write_microusd_per_million INTEGER NOT NULL, currency TEXT NOT NULL,
	evidence_uri TEXT NOT NULL, evidence_digest TEXT NOT NULL, verified_at TEXT NOT NULL,
	published_at TEXT NOT NULL, published_by TEXT NOT NULL, change_reason TEXT NOT NULL,
	supersedes_rate_version_id TEXT
);`;

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE organizations (id TEXT PRIMARY KEY, metadata TEXT NOT NULL DEFAULT '{}');
		CREATE TABLE tedis (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
		${RATE_TABLE_DDL}
	`);
	for (const table of [
		billingPlanVersions,
		billingAccounts,
		billingUsageReservations,
		billingUsagePeriods,
		billingUsageCharges,
		billingServiceCreditReservations,
		billingCreditTopUps,
		billingCreditConsumptions,
		billingCreditUsageTotals,
		billingCreditCaps,
		billingCreditNotices,
		billingCreditMeterOutbox,
	])
		for (const statement of tableDdl(table)) sqlite.exec(statement);
	const at = new Date(NOW).toISOString();
	sqlite.prepare(`INSERT INTO organizations (id) VALUES ('org-1')`).run();
	// 1 EUR = 1 USD: one credit is 5,000 USD micros of provider cost.
	sqlite
		.prepare(
			`INSERT INTO billing_plan_versions (
				id, plan_key, version, status, name, currency, monthly_price_micros,
				annual_price_micros, max_tedis, max_cron_jobs_per_tedi,
				max_iterations_per_task, allow_overage, included_monthly_credits,
				credit_fx, metadata, effective_at, created_at
			) VALUES ('plan-1','growth',1,'active','Growth','eur',0,0,1,10,16,0,100,?,'{}',
				'2026-01-01T00:00:00.000Z',?)`,
		)
		.run(
			JSON.stringify({
				microUsdPerEur: 1_000_000,
				source: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
				asOf: "2026-07-01",
			}),
			at,
		);
	sqlite
		.prepare(
			`INSERT INTO billing_accounts (
				organization_id, plan_version_id, status, billing_mode,
				stripe_environment, stripe_customer_id, overage_enabled,
				period_start, period_end, created_at, updated_at
			) VALUES ('org-1','plan-1','active','stripe','test','cus_1',0,
				'2026-07-01T00:00:00.000Z','2026-08-01T00:00:00.000Z',?,?)`,
		)
		.run(at, at);
	const env = {
		DB: createD1Facade(sqlite) as unknown as D1Database,
		TEDIX_BILLING_SETTLEMENT_MODE: "managed",
		TEDIX_STRIPE_MODE: "test",
	};
	const billing = createVoiceBilling({
		env,
		organizationId: "org-1",
		source: "kernel",
		nowMs: () => NOW,
	});
	return {
		sqlite,
		env,
		billing: billing!,
		publishRate(microsPerMillionUnits: number) {
			sqlite
				.prepare(
					`INSERT INTO provider_model_rate_versions (
						id, provider, model_id, deployment_scope, effective_from,
						input_microusd_per_million, output_microusd_per_million,
						cache_read_microusd_per_million, cache_write_microusd_per_million,
						currency, evidence_uri, evidence_digest, verified_at, published_at,
						published_by, change_reason
					) VALUES ('voice-rate','azure-openai','gpt-transcribe',?,
						'2026-01-01T00:00:00.000Z',?,0,0,0,'USD','https://example.test/voice',
						'digest','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
						'test','fixture')`,
				)
				.run(SCOPE, microsPerMillionUnits);
		},
	};
}

describe("voice credit admission", () => {
	it("reserves the size bound and settles the measured seconds at the governed rate", async () => {
		const { sqlite, billing, publishRate } = setup();
		// USD 0.27 per audio hour = 75 USD micros per second.
		publishRate(75_000_000);

		const hold = await billing.admit(attempt);
		const [reservation] = sqlite
			.prepare(
				`SELECT status, credits, provider, model, estimated_input_tokens AS units
				FROM billing_usage_reservations`,
			)
			.all();
		// 120 s x 75 = 9,000 micros, x2 = 1.8 credits, rounded up.
		expect(reservation).toEqual({
			status: "reserved",
			credits: 2,
			provider: "azure-openai",
			model: "gpt-transcribe",
			units: 120,
		});

		await hold.settle({ quantity: 60, measured: true });
		const [charge] = sqlite
			.prepare(
				`SELECT provider_cost_micros AS cost, credits, input_tokens AS tokens,
					usage_quality AS quality, rate_card_version AS rate, provider_usage_id AS usage
				FROM billing_usage_charges`,
			)
			.all() as Array<Record<string, unknown>>;
		expect(charge).toMatchObject({
			cost: 4_500,
			credits: 1,
			tokens: 0,
			quality: "provider_reported",
			rate: "voice-rate",
		});
		expect(String(charge!.usage)).toMatch(/^voice:/);
		expect(
			sqlite.prepare(`SELECT status FROM billing_usage_reservations`).get(),
		).toEqual({ status: "settled" });
		expect(
			sqlite
				.prepare(
					`SELECT SUM(credits) AS credits FROM billing_credit_consumptions`,
				)
				.get(),
		).toEqual({ credits: 1 });
	});

	it("releases the hold when the provider attempt fails", async () => {
		const { sqlite, billing, publishRate } = setup();
		publishRate(75_000_000);
		const hold = await billing.admit(attempt);
		await hold.release("provider_failed");
		expect(
			sqlite
				.prepare(
					`SELECT status, rejection_code AS reason FROM billing_usage_reservations`,
				)
				.get(),
		).toEqual({ status: "released", reason: "provider_failed" });
	});

	it("refuses only the attempt for a voice model without a governed rate", async () => {
		const { sqlite, billing } = setup();
		await expect(billing.admit(attempt)).rejects.toMatchObject({
			code: "pricing_unavailable",
			message: "Inference blocked by billing policy: pricing_unavailable",
			scope: "attempt",
		});
		expect(
			sqlite
				.prepare(`SELECT COUNT(*) AS n FROM billing_usage_reservations`)
				.get(),
		).toEqual({ n: 0 });
	});

	it("refuses with the standard credit code when the pool cannot cover the hold", async () => {
		const { billing, publishRate } = setup();
		publishRate(75_000_000);
		const refusal = await billing
			.admit({ ...attempt, estimatedQuantity: 1_000_000 })
			.catch((error: unknown) => error);
		expect(refusal).toBeInstanceOf(VoiceCreditRefusal);
		expect(refusal).toMatchObject({
			code: "monthly_credit_limit_reached",
			scope: "call",
		});
	});

	it("applies the acting member cap and settles a runtime receipt once", async () => {
		const { sqlite, env, publishRate } = setup();
		publishRate(75_000_000);
		const at = new Date(NOW).toISOString();
		sqlite
			.prepare(
				`INSERT INTO billing_credit_caps (
				organization_id, subject_kind, subject_key, monthly_cap_credits,
				updated_by, created_at, updated_at
			) VALUES ('org-1', 'member', 'member-1', 1, 'owner', ?, ?)`,
			)
			.run(at, at);
		const subject = {
			organizationId: "org-1",
			userId: "member-1",
			source: "operator" as const,
		};
		await expect(
			reserveVoiceUsage(env, subject, attempt, at),
		).rejects.toMatchObject({
			code: "member_monthly_credit_cap_reached",
		});
		const reservationId = await reserveVoiceUsage(
			env,
			subject,
			{ ...attempt, estimatedQuantity: 60 },
			at,
		);
		const receipt = { reservationId, usage: { quantity: 30, measured: true } };
		await expect(
			finishRuntimeVoiceUsage(env, {
				...receipt,
				organizationId: "org-2",
			}),
		).rejects.toThrow("Voice reservation not found");
		await finishRuntimeVoiceUsage(env, { ...receipt, organizationId: "org-1" });
		await finishRuntimeVoiceUsage(env, { ...receipt, organizationId: "org-1" });
		expect(
			sqlite
				.prepare(
					`SELECT status, user_id FROM billing_usage_reservations WHERE id = ?`,
				)
				.get(reservationId),
		).toEqual({ status: "settled", user_id: "member-1" });
		expect(
			sqlite
				.prepare(
					`SELECT COUNT(*) AS count, SUM(credits) AS credits FROM billing_usage_charges`,
				)
				.get(),
		).toEqual({ count: 1, credits: 1 });
	});

	it("does not admit when the deployment settles credits elsewhere", () => {
		for (const mode of ["external", "disabled"])
			expect(
				createVoiceBilling({
					env: {
						DB: {} as D1Database,
						TEDIX_BILLING_SETTLEMENT_MODE: mode,
					},
					organizationId: "org-1",
					source: "kernel",
				}),
			).toBeUndefined();
	});
});
