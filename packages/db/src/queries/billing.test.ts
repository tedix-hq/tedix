import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	billingAccounts,
	billingCreditCaps,
	billingCreditConsumptions,
	billingCreditMeterOutbox,
	billingCreditNotices,
	billingCreditTopUps,
	billingCreditUsageTotals,
	billingPlanVersions,
	billingProviderReconciliations,
	billingProviderUsage,
	billingServiceCreditReservations,
	billingTopUpPackVersions,
	billingUsageCharges,
	billingUsagePeriods,
	billingUsageQuarantines,
	billingUsageReservations,
	stripeWebhookEvents,
} from "../schema/billing";
import type { NewProviderExecutionAttemptRow } from "../schema/provider-executions";
import { createD1Facade } from "../test/d1-facade";
import { tableDdl } from "../test/schema-ddl";
import {
	admitCodeRun,
	getCreditPoolSnapshot,
	grantTopUpCredits,
	listActiveTopUpPacks,
	listCreditNotices,
	listCreditSubjectUsage,
	setAccountCredits,
	setCreditCaps,
	setPayAsYouGo,
} from "./billing/credit-pool";
import { listDailyCreditUsage } from "./billing/dashboard";
import { recordBillingProviderReconciliation } from "./billing/health";
import {
	claimStripeMeterOutbox,
	markStripeMeterOutboxFailed,
	STRIPE_METER_OUTBOX_MAX_ATTEMPTS,
} from "./billing/meter-outbox";
import {
	activateProviderCustomerBilling,
	getBillingEntitlement,
	getBillingEntitlementByStripeCustomerId,
	linkBillingAccountStripeCustomerIfUnbound,
} from "./billing/plans";
import { recordBillingProviderUsage } from "./billing/provider-usage";
import {
	estimateAiCredits,
	expireBillingReservations,
	reserveBillingUsage,
	UNPRICED_WORKERS_AI_HOLD_CREDITS,
} from "./billing/reservations";
import { settleBillingUsage } from "./billing/settlement";
import {
	applyStripeBillingWebhook,
	claimStripeWebhookEvent,
	hasNewerProcessedStripeWebhookEvent,
	markStripeWebhookEventFailed,
	markStripeWebhookEventProcessed,
} from "./billing/stripe-webhooks";

const PERIOD_START = "2026-07-01T00:00:00.000Z";
const PERIOD_END = "2026-08-01T00:00:00.000Z";
/** 1 EUR = 1 USD keeps the arithmetic readable: 1 credit = 5,000 USD micros of provider cost. */
const PARITY_FX = JSON.stringify({
	microUsdPerEur: 1_000_000,
	source: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
	asOf: "2026-07-01",
});
const DEPLOYMENT_SCOPE = '["azure-openai","test"]';

function setup(onPrepare?: (query: string) => void) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (
			id TEXT PRIMARY KEY,
			metadata TEXT NOT NULL DEFAULT '{}',
			features TEXT NOT NULL DEFAULT '{"os":false}',
			updated_at TEXT
		);
		CREATE TABLE tedis (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL
		);
		CREATE TABLE audit_events (
			id TEXT PRIMARY KEY,
			organization_id TEXT,
			actor_id TEXT,
			actor_type TEXT,
			action TEXT,
			resource_type TEXT,
			resource_id TEXT,
			metadata TEXT,
			ip_address TEXT,
			user_agent TEXT,
			timestamp INTEGER
		);
		CREATE TABLE provider_model_rate_versions (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			model_id TEXT NOT NULL,
			deployment_scope TEXT NOT NULL,
			input_token_min INTEGER NOT NULL DEFAULT 0,
			input_token_max INTEGER,
			effective_from TEXT NOT NULL,
			input_microusd_per_million INTEGER NOT NULL,
			output_microusd_per_million INTEGER NOT NULL,
			cache_read_microusd_per_million INTEGER NOT NULL,
			cache_write_microusd_per_million INTEGER NOT NULL,
			currency TEXT NOT NULL,
			evidence_uri TEXT NOT NULL,
			evidence_digest TEXT NOT NULL,
			verified_at TEXT NOT NULL,
			published_at TEXT NOT NULL,
			published_by TEXT NOT NULL,
			change_reason TEXT NOT NULL,
			supersedes_rate_version_id TEXT
		);
	`);
	for (const table of [
		billingPlanVersions,
		billingAccounts,
		billingUsageReservations,
		billingUsagePeriods,
		billingUsageCharges,
		billingUsageQuarantines,
		billingProviderUsage,
		billingServiceCreditReservations,
		billingTopUpPackVersions,
		billingCreditTopUps,
		billingCreditConsumptions,
		billingCreditUsageTotals,
		billingCreditCaps,
		billingCreditNotices,
		billingCreditMeterOutbox,
		stripeWebhookEvents,
		billingProviderReconciliations,
	]) {
		for (const statement of tableDdl(table)) sqlite.exec(statement);
	}
	const now = "2026-07-27T12:00:00.000Z";
	sqlite.prepare(`INSERT INTO organizations (id) VALUES (?)`).run("org-1");
	sqlite
		.prepare(`INSERT INTO tedis (id, organization_id) VALUES (?, ?)`)
		.run("tedi-1", "org-1");
	sqlite
		.prepare(
			`INSERT INTO billing_plan_versions (
				id, plan_key, version, status, name, currency, monthly_price_micros,
				annual_price_micros, max_tedis, max_cron_jobs_per_tedi,
				max_iterations_per_task, allow_overage, included_monthly_credits,
				credit_fx, metadata, effective_at, created_at
			) VALUES ('growth-v1','growth',1,'active','Growth','eur',
				200000000,2000000000,1,10,16,1,100,?,'{}','2026-01-01T00:00:00.000Z',?)`,
		)
		.run(PARITY_FX, now);
	sqlite
		.prepare(
			`INSERT INTO billing_accounts (
				organization_id, plan_version_id, status, billing_mode,
				stripe_environment, stripe_customer_id, overage_enabled,
				period_start, period_end, created_at, updated_at
			) VALUES ('org-1','growth-v1','active','stripe','live','cus_1',0,?,?,?,?)`,
		)
		.run(PERIOD_START, PERIOD_END, now, now);
	// 1M input or output tokens cost 1,000,000 USD micros: 1 token = 1 micro.
	sqlite
		.prepare(
			`INSERT INTO provider_model_rate_versions (
				id, provider, model_id, deployment_scope, effective_from,
				input_microusd_per_million, output_microusd_per_million,
				cache_read_microusd_per_million, cache_write_microusd_per_million,
				currency, evidence_uri, evidence_digest, verified_at, published_at,
				published_by, change_reason
			) VALUES ('rate-1','azure-openai','gpt-5.6-terra',?,'2026-01-01T00:00:00.000Z',
				1000000,1000000,100000,1000000,'USD','https://example.test/rates',
				'digest','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
				'test','fixture')`,
		)
		.run(DEPLOYMENT_SCOPE);
	return {
		db: createDbClient(createD1Facade(sqlite, { onPrepare })),
		sqlite,
		now,
	};
}

function insertReservation(
	sqlite: DatabaseSync,
	input: {
		id: string;
		status?: "reserved" | "expired" | "settled";
		tediId?: string;
		credits?: number;
		now: string;
	},
) {
	sqlite
		.prepare(
			`INSERT INTO billing_usage_reservations (
				id, organization_id, plan_version_id, tedi_id, status, source,
				provider, model, estimated_input_tokens, estimated_output_tokens,
				estimated_charge_micros, credits, period_start, period_end,
				idempotency_key, expires_at, created_at, updated_at
			) VALUES (?, 'org-1', 'growth-v1', ?, ?, 'operator', 'azure-openai',
				'gpt-5.6-terra', 0, 0, 0, ?, ?, ?, ?, '2026-07-27T12:10:00.000Z', ?, ?)`,
		)
		.run(
			input.id,
			input.tediId ?? null,
			input.status ?? "reserved",
			input.credits ?? 0,
			PERIOD_START,
			PERIOD_END,
			`test:${input.id}`,
			input.now,
			input.now,
		);
}

/** Reserve one AI call through the real admission path. */
function reserve(
	db: ReturnType<typeof setup>["db"],
	input: {
		id: string;
		now: string;
		inputTokens?: number;
		outputTokens?: number;
		tediId?: string | null;
		userId?: string | null;
	},
) {
	return reserveBillingUsage(db, {
		id: input.id,
		organizationId: "org-1",
		tediId: input.tediId ?? null,
		userId: input.userId ?? null,
		source: "operator",
		provider: "azure-openai",
		model: "gpt-5.6-terra",
		deploymentScope: DEPLOYMENT_SCOPE,
		estimatedInputTokens: input.inputTokens ?? 10_000,
		estimatedOutputTokens: input.outputTokens ?? 0,
		idempotencyKey: `reserve:${input.id}`,
		expiresAt: "2026-07-27T12:10:00.000Z",
		now: input.now,
	});
}

/** Settle a reservation at an actual USD provider cost. */
function settle(
	db: ReturnType<typeof setup>["db"],
	input: { id: string; reservationId: string; costMicros: number; now: string },
) {
	return settleBillingUsage(db, {
		id: input.id,
		organizationId: "org-1",
		reservationId: input.reservationId,
		gatewayLogId: `gateway:${input.id}`,
		provider: "azure-openai",
		model: "gpt-5.6-terra",
		source: "operator",
		inputTokens: input.costMicros,
		outputTokens: 0,
		providerCostMicros: input.costMicros,
		usageQuality: "gateway_reported",
		providerCostQuality: "estimated",
		meteringReady: true,
		occurredAt: input.now,
		now: input.now,
	});
}

it("groups recorded credits by UTC day and kind within the tenant and the requested window", async () => {
	const { db, sqlite } = setup();
	try {
		sqlite
			.prepare("INSERT INTO organizations (id) VALUES (?)")
			.run("other-org");
		const insert = sqlite.prepare(`
			INSERT INTO billing_credit_consumptions
				(id, organization_id, kind, source_ref, period_start, period_end, credits,
				 included_credits, top_up_credits, payg_credits, payg_charge_micros, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?)
		`);
		const rows = [
			["org-1", "ai", 2, "2026-07-27T00:00:00.000Z"],
			["org-1", "ai", 3, "2026-07-27T23:59:59.999Z"],
			["org-1", "service", 1, "2026-07-27T14:00:00.000Z"],
			["org-1", "code_run", 1, "2026-07-28T08:00:00.000Z"],
			["org-1", "ai", 7, "2026-07-26T23:59:59.999Z"],
			["org-1", "ai", 7, "2026-07-29T00:00:00.000Z"],
			["other-org", "ai", 7, "2026-07-27T12:00:00.000Z"],
		] as const;
		for (const [index, [org, kind, credits, createdAt]] of rows.entries()) {
			insert.run(
				String(index),
				org,
				kind,
				String(index),
				PERIOD_START,
				PERIOD_END,
				credits,
				credits,
				createdAt,
			);
		}
		expect(
			await listDailyCreditUsage(db, {
				organizationId: "org-1",
				from: "2026-07-27T00:00:00.000Z",
				to: "2026-07-29T00:00:00.000Z",
			}),
		).toEqual([
			{ day: "2026-07-27", kind: "ai", credits: 5 },
			{ day: "2026-07-27", kind: "service", credits: 1 },
			{ day: "2026-07-28", kind: "code_run", credits: 1 },
		]);
	} finally {
		sqlite.close();
	}
});

describe("organization credit pool", () => {
	it("reserves ceil(cost in EUR x 2 / EUR 0.01) credits and settles on the actual cost", async () => {
		const { db, sqlite, now } = setup();
		// 10,000 input tokens = 10,000 USD micros = EUR 0.01 -> x2 = 2 credits.
		const decision = await reserve(db, { id: "r1", now });
		expect(decision).toMatchObject({
			allowed: true,
			reservation: { id: "r1", credits: 2 },
		});
		expect(
			(await getCreditPoolSnapshot(db, { organizationId: "org-1", now }))
				?.heldCredits,
		).toBe(2);
		// Actual cost 25,001 USD micros -> ceil(50,002 / 10,000) = 6 credits.
		await settle(db, {
			id: "c1",
			reservationId: "r1",
			costMicros: 25_001,
			now,
		});
		const snapshot = await getCreditPoolSnapshot(db, {
			organizationId: "org-1",
			now,
		});
		expect(snapshot).toMatchObject({
			includedCredits: 100,
			usedCredits: 6,
			includedUsedCredits: 6,
			heldCredits: 0,
			breakdown: { ai: 6, codeRuns: 0, services: 0 },
			availableCredits: 94,
		});
		expect(
			sqlite
				.prepare("SELECT credits FROM billing_usage_charges WHERE id='c1'")
				.get(),
		).toEqual({ credits: 6 });
		// A replayed settlement draws nothing twice.
		await settle(db, {
			id: "c1",
			reservationId: "r1",
			costMicros: 25_001,
			now,
		});
		expect(
			(await getCreditPoolSnapshot(db, { organizationId: "org-1", now }))
				?.usedCredits,
		).toBe(6);
		sqlite.close();
	});

	it("refuses with monthly_credit_limit_reached when included credits are spent", async () => {
		const { db, sqlite, now } = setup();
		// 50,000 tokens -> 10 credits each; 100 included credits allow ten holds.
		for (let index = 0; index < 10; index++) {
			expect(
				await reserve(db, { id: `r${index}`, now, inputTokens: 50_000 }),
			).toMatchObject({ allowed: true });
		}
		expect(
			await reserve(db, { id: "r-over", now, inputTokens: 50_000 }),
		).toMatchObject({ allowed: false, code: "monthly_credit_limit_reached" });
		sqlite.close();
	});

	it("spends included credits first, then the soonest-expiring top-up, then pay-as-you-go", async () => {
		const { db, sqlite, now } = setup();
		await grantTopUpCredits(db, {
			id: "late",
			organizationId: "org-1",
			credits: 30,
			sourceType: "operator_grant",
			idempotencyKey: "late",
			expiresAt: "2027-07-01T00:00:00.000Z",
			now,
		});
		await grantTopUpCredits(db, {
			id: "early",
			organizationId: "org-1",
			credits: 20,
			sourceType: "operator_grant",
			idempotencyKey: "early",
			expiresAt: "2027-01-01T00:00:00.000Z",
			now,
		});
		await setPayAsYouGo(db, {
			organizationId: "org-1",
			enabled: true,
			monthlyCapMicros: 1_000_000,
			now,
		});
		expect(
			(await getCreditPoolSnapshot(db, { organizationId: "org-1", now }))
				?.availableCredits,
		).toBe(100 + 50 + 100);
		// 140 credits: 100 included, 20 early top-up, 20 of the late top-up.
		insertReservation(sqlite, { id: "r1", credits: 0, now });
		await settle(db, {
			id: "c1",
			reservationId: "r1",
			costMicros: 700_000,
			now,
		});
		expect(
			sqlite
				.prepare(
					"SELECT id, consumed_credits AS used FROM billing_credit_top_ups ORDER BY id",
				)
				.all(),
		).toEqual([
			{ id: "early", used: 20 },
			{ id: "late", used: 20 },
		]);
		// 20 more: 10 late top-up, 10 pay-as-you-go at EUR 0.01.
		insertReservation(sqlite, { id: "r2", credits: 0, now });
		await settle(db, {
			id: "c2",
			reservationId: "r2",
			costMicros: 100_000,
			now,
		});
		const snapshot = await getCreditPoolSnapshot(db, {
			organizationId: "org-1",
			now,
		});
		expect(snapshot).toMatchObject({
			usedCredits: 160,
			includedUsedCredits: 100,
			topUpUsedCredits: 50,
			topUpCredits: 0,
			payAsYouGo: { enabled: true, spentMicros: 100_000, usedCredits: 10 },
			availableCredits: 90,
		});
		// The Stripe account meters exactly the pay-as-you-go credits.
		expect(
			sqlite
				.prepare("SELECT quantity, event_name FROM billing_credit_meter_outbox")
				.all(),
		).toEqual([{ quantity: 10, event_name: "tedix_credits" }]);
		sqlite.close();
	});

	it("raises the 80% and 100% notices once per period", async () => {
		const { db, sqlite, now } = setup();
		insertReservation(sqlite, { id: "r1", now });
		await settle(db, {
			id: "c1",
			reservationId: "r1",
			costMicros: 400_000,
			now,
		});
		expect(
			await listCreditNotices(db, {
				organizationId: "org-1",
				periodStart: PERIOD_START,
			}),
		).toEqual([{ threshold: 80, reachedAt: now }]);
		insertReservation(sqlite, { id: "r2", now });
		await settle(db, {
			id: "c2",
			reservationId: "r2",
			costMicros: 100_000,
			now,
		});
		insertReservation(sqlite, { id: "r3", now });
		await settle(db, {
			id: "c3",
			reservationId: "r3",
			costMicros: 5_000,
			now: "2026-07-28T00:00:00.000Z",
		});
		expect(
			await listCreditNotices(db, {
				organizationId: "org-1",
				periodStart: PERIOD_START,
			}),
		).toEqual([
			{ threshold: 80, reachedAt: now },
			{ threshold: 100, reachedAt: now },
		]);
		sqlite.close();
	});

	it("enforces tedi and member monthly caps and reports their use", async () => {
		const { db, sqlite, now } = setup();
		await setCreditCaps(db, {
			organizationId: "org-1",
			caps: [
				{ subjectKind: "tedi", subjectKey: "tedi-1", monthlyCapCredits: 3 },
				{ subjectKind: "member", subjectKey: "user-1", monthlyCapCredits: 2 },
			],
			updatedBy: "admin",
			now,
		});
		expect(
			await reserve(db, { id: "t1", now, tediId: "tedi-1" }),
		).toMatchObject({ allowed: true });
		expect(
			await reserve(db, { id: "t2", now, tediId: "tedi-1" }),
		).toMatchObject({
			allowed: false,
			code: "tedi_monthly_credit_cap_reached",
		});
		expect(
			await admitCodeRun(db, {
				organizationId: "org-1",
				executionId: "run-1",
				userId: "user-1",
				credits: 1,
				now,
			}),
		).toMatchObject({ allowed: true, replayed: false });
		expect(
			await admitCodeRun(db, {
				organizationId: "org-1",
				executionId: "run-1",
				userId: "user-1",
				credits: 1,
				now,
			}),
		).toMatchObject({ allowed: true, replayed: true });
		await admitCodeRun(db, {
			organizationId: "org-1",
			executionId: "run-2",
			userId: "user-1",
			credits: 1,
			now,
		});
		expect(
			await admitCodeRun(db, {
				organizationId: "org-1",
				executionId: "run-3",
				userId: "user-1",
				credits: 1,
				now,
			}),
		).toEqual({ allowed: false, code: "member_monthly_credit_cap_reached" });
		expect(
			await listCreditSubjectUsage(db, {
				organizationId: "org-1",
				periodStart: PERIOD_START,
				subjectKind: "member",
			}),
		).toEqual([{ subjectKey: "user-1", usedCredits: 2, monthlyCapCredits: 2 }]);
		expect(
			(await getCreditPoolSnapshot(db, { organizationId: "org-1", now }))
				?.breakdown,
		).toEqual({ ai: 0, codeRuns: 2, services: 0 });
		sqlite.close();
	});

	it("applies the member cap to AI calls a member starts, and only org and tedi limits without one", async () => {
		const { db, sqlite, now } = setup();
		await setCreditCaps(db, {
			organizationId: "org-1",
			caps: [
				{ subjectKind: "member", subjectKey: "user-1", monthlyCapCredits: 3 },
			],
			updatedBy: "admin",
			now,
		});
		// 2 credits held for user-1; another 2 would pass the member's cap of 3.
		expect(
			await reserve(db, { id: "m1", now, tediId: "tedi-1", userId: "user-1" }),
		).toMatchObject({ allowed: true, reservation: { credits: 2 } });
		expect(
			await reserve(db, { id: "m2", now, tediId: "tedi-1", userId: "user-1" }),
		).toMatchObject({
			allowed: false,
			code: "member_monthly_credit_cap_reached",
		});
		// Scheduled work has no member: only the pool and tedi limits apply.
		expect(
			await reserve(db, { id: "s1", now, tediId: "tedi-1" }),
		).toMatchObject({ allowed: true });
		// Another member is not held to user-1's cap.
		expect(
			await reserve(db, { id: "o1", now, userId: "user-2" }),
		).toMatchObject({ allowed: true });
		// Settlement adds the actual cost to the member's running total.
		await settle(db, {
			id: "mc1",
			reservationId: "m1",
			costMicros: 10_000,
			now,
		});
		await settle(db, {
			id: "sc1",
			reservationId: "s1",
			costMicros: 10_000,
			now,
		});
		expect(
			await listCreditSubjectUsage(db, {
				organizationId: "org-1",
				periodStart: PERIOD_START,
				subjectKind: "member",
			}),
		).toEqual([{ subjectKey: "user-1", usedCredits: 2, monthlyCapCredits: 3 }]);
		expect(
			(
				await getCreditPoolSnapshot(db, {
					organizationId: "org-1",
					now,
					subject: { userId: "user-1" },
				})
			)?.memberUsedCredits,
		).toBe(2);
		sqlite.close();
	});

	it("lets an operator override included credits with an audited entitlement bump", async () => {
		const { db, sqlite, now } = setup();
		const result = await setAccountCredits(db, {
			organizationId: "org-1",
			includedCreditsOverride: 1_000_000,
			reason: "contract",
			actor: { id: "operator-1", type: "user" },
			now,
		});
		expect(result).toEqual({ entitlementVersion: 2, previous: null });
		expect(
			(await getCreditPoolSnapshot(db, { organizationId: "org-1", now }))
				?.includedCredits,
		).toBe(1_000_000);
		expect(
			sqlite
				.prepare("SELECT action, resource_id AS resourceId FROM audit_events")
				.all(),
		).toEqual([
			{ action: "billing.included_credits_set", resourceId: "org-1" },
		]);
		sqlite.close();
	});

	it("refuses pricing when no governed rate resolves", async () => {
		const { db, sqlite, now } = setup();
		const decision = await reserveBillingUsage(db, {
			id: "unpriced",
			organizationId: "org-1",
			source: "operator",
			provider: "azure-openai",
			model: "unknown-model",
			deploymentScope: DEPLOYMENT_SCOPE,
			estimatedInputTokens: 1,
			estimatedOutputTokens: 1,
			idempotencyKey: "reserve:unpriced",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
		});
		expect(decision).toMatchObject({
			allowed: false,
			code: "pricing_unavailable",
		});
		sqlite.close();
	});

	describe("Workers AI calls without a governed rate", () => {
		const WORKERS_AI_SCOPE = '["workers-ai","account-1"]';
		function publishWorkersAiRate(
			sqlite: DatabaseSync,
			input: {
				id: string;
				modelId: string;
				effectiveFrom: string;
				microUsdPerMillion: number;
			},
		) {
			sqlite
				.prepare(
					`INSERT INTO provider_model_rate_versions (
						id, provider, model_id, deployment_scope, effective_from,
						input_microusd_per_million, output_microusd_per_million,
						cache_read_microusd_per_million, cache_write_microusd_per_million,
						currency, evidence_uri, evidence_digest, verified_at, published_at,
						published_by, change_reason
					) VALUES (?, 'workers-ai', ?, ?, ?, ?, ?, ?, ?, 'USD',
						'https://example.test/rates', 'digest', '2026-01-01T00:00:00.000Z',
						'2026-01-01T00:00:00.000Z', 'test', 'fixture')`,
				)
				.run(
					input.id,
					input.modelId,
					WORKERS_AI_SCOPE,
					input.effectiveFrom,
					input.microUsdPerMillion,
					input.microUsdPerMillion,
					input.microUsdPerMillion,
					input.microUsdPerMillion,
				);
		}
		function reserveWorkersAi(
			db: ReturnType<typeof setup>["db"],
			input: { id: string; model: string; now: string },
		) {
			return reserveBillingUsage(db, {
				id: input.id,
				organizationId: "org-1",
				source: "operator",
				provider: "workers-ai",
				model: input.model,
				deploymentScope: WORKERS_AI_SCOPE,
				estimatedInputTokens: 10_000,
				estimatedOutputTokens: 0,
				idempotencyKey: `reserve:${input.id}`,
				expiresAt: new Date(Date.parse(input.now) + 600_000).toISOString(),
				now: input.now,
			});
		}
		function autoExecution(allowedModels: string[]) {
			return {
				provider: "workers-ai",
				requestModel: "cloudflare/auto",
				autoRouting: {
					version: 1,
					modality: "text",
					mode: "restricted",
					allowedProviders: ["workers-ai"],
					allowedModels,
				},
				gatewayAccountId: "account-1",
				gatewayId: "gateway-1",
				transportKind: "gateway-https",
				apiKind: "workers-ai-chat",
			} as unknown as NewProviderExecutionAttemptRow;
		}

		// clef-flash has no rate and the Gateway reports 0 tokens for it: a
		// token rate cannot price it, but the Gateway-reported cost settles it.
		it("admits a model with no rate on a small hold instead of refusing it", async () => {
			const { db, sqlite, now } = setup();
			const decision = await reserveWorkersAi(db, {
				id: "clef-flash",
				model: "@cf/cloudflare/clef-flash",
				now,
			});
			expect(decision).toMatchObject({
				allowed: true,
				reservation: { credits: UNPRICED_WORKERS_AI_HOLD_CREDITS },
			});
			sqlite.close();
		});

		// A rate published for a future date does not apply yet: until then the
		// call is held like an unpriced one, afterwards the rate prices it.
		it("holds a model whose rate takes effect later, then prices it once it applies", async () => {
			const { db, sqlite, now } = setup();
			publishWorkersAiRate(sqlite, {
				id: "llama-future",
				modelId: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
				effectiveFrom: "2026-07-28T00:00:00.000Z",
				microUsdPerMillion: 10_000_000,
			});
			expect(
				await reserveWorkersAi(db, {
					id: "llama-before",
					model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
					now,
				}),
			).toMatchObject({
				allowed: true,
				reservation: { credits: UNPRICED_WORKERS_AI_HOLD_CREDITS },
			});
			// 10,000 tokens x 10 USD micros = 100,000 USD micros = EUR 0.10 -> x2 = 20.
			expect(
				await reserveWorkersAi(db, {
					id: "llama-after",
					model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
					now: "2026-07-28T12:00:00.000Z",
				}),
			).toMatchObject({ allowed: true, reservation: { credits: 20 } });
			sqlite.close();
		});

		it("still refuses another provider's model that has no rate", async () => {
			const { db, sqlite, now } = setup();
			expect(
				await estimateAiCredits(db, {
					creditFx: PARITY_FX,
					provider: "azure-openai",
					model: "unknown-model",
					deploymentScope: DEPLOYMENT_SCOPE,
					estimatedInputTokens: 10_000,
					estimatedOutputTokens: 0,
					now,
				}),
			).toBeNull();
			sqlite.close();
		});

		// Auto Router admission happens before it picks a model, so the hold
		// covers the dearest model the admitted routing allows.
		it("prices the Auto Router at its most expensive allowed model", async () => {
			const { db, sqlite, now } = setup();
			publishWorkersAiRate(sqlite, {
				id: "kimi",
				modelId: "@cf/moonshotai/kimi-k2.7-code",
				effectiveFrom: "2026-01-01T00:00:00.000Z",
				microUsdPerMillion: 4_000_000,
			});
			publishWorkersAiRate(sqlite, {
				id: "llama-small",
				modelId: "@cf/meta/llama-3.1-8b-instruct-fast",
				effectiveFrom: "2026-01-01T00:00:00.000Z",
				microUsdPerMillion: 500_000,
			});
			const estimate = (allowedModels: string[]) =>
				estimateAiCredits(db, {
					creditFx: PARITY_FX,
					provider: "workers-ai",
					model: "cloudflare/auto",
					execution: autoExecution(allowedModels),
					estimatedInputTokens: 10_000,
					estimatedOutputTokens: 0,
					now,
				});
			// kimi: 40,000 USD micros = EUR 0.04 -> 8 credits; llama: 1 credit.
			expect(await estimate(["@cf/moonshotai/kimi-k2.7-code"])).toBe(8);
			expect(
				await estimate([
					"@cf/meta/llama-3.1-8b-instruct-fast",
					"@cf/moonshotai/kimi-k2.7-code",
				]),
			).toBe(8);
			// An allowed model with no rate counts at the unpriced hold.
			expect(
				await estimate([
					"@cf/meta/llama-3.1-8b-instruct-fast",
					"@cf/cloudflare/clef-flash",
				]),
			).toBe(UNPRICED_WORKERS_AI_HOLD_CREDITS);
			// No routing evidence: still admitted on the unpriced hold.
			expect(
				await estimateAiCredits(db, {
					creditFx: PARITY_FX,
					provider: "workers-ai",
					model: "cloudflare/auto",
					estimatedInputTokens: 10_000,
					estimatedOutputTokens: 0,
					now,
				}),
			).toBe(UNPRICED_WORKERS_AI_HOLD_CREDITS);
			sqlite.close();
		});
	});

	it("lists active top-up packs smallest first", async () => {
		const { db, sqlite, now } = setup();
		for (const [credits, version] of [
			[5000, 1],
			[1000, 1],
			[1000, 2],
		] as const)
			sqlite
				.prepare(
					`INSERT INTO billing_top_up_pack_versions (
						id, pack_key, version, status, name, currency, price_micros,
						credits, valid_months, stripe_environment, stripe_lookup_key,
						effective_at, created_at
					) VALUES (?, ?, ?, 'active', ?, 'eur', ?, ?, 12, 'live', ?, ?, ?)`,
				)
				.run(
					`pack-${credits}-${version}`,
					`credits-${credits}`,
					version,
					`${credits} credits`,
					credits * 10_000,
					credits,
					`tedix_credits_${credits}_eur_v${version}`,
					"2026-01-01T00:00:00.000Z",
					"2026-01-01T00:00:00.000Z",
				);
		expect(
			(await listActiveTopUpPacks(db, { stripeEnvironment: "live", now })).map(
				(pack) => pack.id,
			),
		).toEqual(["pack-1000-2", "pack-5000-1"]);
		sqlite.close();
	});
});

describe("billing admission and settlement", () => {
	it("loads the entitlement through declared billing relations", async () => {
		const { db } = setup();
		await expect(getBillingEntitlement(db, "org-1")).resolves.toMatchObject({
			account: {
				organizationId: "org-1",
				status: "active",
				stripeCustomerId: "cus_1",
			},
			plan: { id: "growth-v1", planKey: "growth" },
		});
		await expect(getBillingEntitlement(db, "missing-org")).resolves.toBeNull();
		await expect(
			getBillingEntitlementByStripeCustomerId(db, "cus_1", "live"),
		).resolves.toMatchObject({
			account: { organizationId: "org-1", stripeCustomerId: "cus_1" },
			plan: { planKey: "growth" },
		});
		await expect(
			getBillingEntitlementByStripeCustomerId(db, "cus_1", "test"),
		).resolves.toBeNull();
		await expect(
			linkBillingAccountStripeCustomerIfUnbound(db, {
				organizationId: "org-1",
				stripeCustomerId: "cus_1",
				stripeEnvironment: "live",
				now: "2026-07-27T12:01:00.000Z",
			}),
		).resolves.toBe(true);
		await expect(
			linkBillingAccountStripeCustomerIfUnbound(db, {
				organizationId: "org-1",
				stripeCustomerId: "cus_other",
				stripeEnvironment: "live",
				now: "2026-07-27T12:02:00.000Z",
			}),
		).resolves.toBe(false);
	});

	it("records provider-authoritative variance without relabeling estimated rows", async () => {
		const { db, sqlite, now } = setup();
		insertReservation(sqlite, { id: "reservation-reconcile", now });
		await settleBillingUsage(db, {
			id: "charge-reconcile",
			organizationId: "org-1",
			reservationId: "reservation-reconcile",
			gatewayLogId: "gateway-reconcile",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			source: "operator",
			inputTokens: 100,
			outputTokens: 10,
			providerCostMicros: 2_000,
			usageQuality: "gateway_reported",
			providerCostQuality: "estimated",
			meteringReady: true,
			occurredAt: now,
			metadata: { providerResource: "tedix-resource" },
			now,
		});
		const reconciliation = await recordBillingProviderReconciliation(db, {
			id: "reconciliation-1",
			provider: "azure-openai",
			providerResource: "tedix-resource",
			periodStart: "2026-07-27T00:00:00.000Z",
			periodEnd: "2026-07-28T00:00:00.000Z",
			providerCostMicros: 8_000,
			evidenceRef: "azure-export:test",
			reconciledBy: "operator-1",
			now,
		});
		expect(reconciliation).toMatchObject({
			status: "variance",
			ledgerCostMicros: 2_000,
			providerCostMicros: 8_000,
			varianceMicros: 6_000,
			usageRowCount: 1,
		});
		expect(
			sqlite
				.prepare(
					"SELECT provider_cost_quality AS quality, provider_reconciled_at AS reconciledAt FROM billing_usage_charges WHERE id='charge-reconcile'",
				)
				.get(),
		).toEqual({ quality: "estimated", reconciledAt: now });
	});

	it.each([
		[-10, 20],
		[20, -10],
		[0.5, 0.5],
		[Number.MAX_SAFE_INTEGER, 1],
	])(
		"rejects invalid token partitions %s/%s before financial writes",
		async (inputTokens, outputTokens) => {
			const { db, sqlite, now } = setup();
			insertReservation(sqlite, { id: "reservation-invalid-tokens", now });
			await expect(
				settleBillingUsage(db, {
					id: "charge-invalid-tokens",
					organizationId: "org-1",
					reservationId: "reservation-invalid-tokens",
					gatewayLogId: "gateway-invalid-tokens",
					provider: "workers-ai",
					model: "@cf/test",
					source: "operator",
					inputTokens,
					outputTokens,
					providerCostMicros: 0,
					usageQuality: "gateway_reported",
					providerCostQuality: "gateway_reported",
					meteringReady: true,
					occurredAt: now,
					now,
				}),
			).rejects.toThrow("Settled usage requires non-negative safe integers");
			expect(
				sqlite
					.prepare(
						"SELECT status FROM billing_usage_reservations WHERE id='reservation-invalid-tokens'",
					)
					.get(),
			).toEqual({ status: "reserved" });
			for (const table of [
				"billing_usage_periods",
				"billing_usage_charges",
				"billing_credit_consumptions",
				"billing_credit_meter_outbox",
			]) {
				expect(
					sqlite.prepare(`SELECT count(*) AS count FROM ${table}`).get(),
				).toEqual({ count: 0 });
			}
		},
	);
	it("fails closed when customer settlement has no admission reservation", async () => {
		const { db, now } = setup();
		await expect(
			settleBillingUsage(db, {
				id: "charge-unreserved",
				organizationId: "org-1",
				gatewayLogId: "gateway-unreserved",
				provider: "azure-openai",
				model: "gpt-5.6-terra",
				source: "system",
				inputTokens: 1,
				outputTokens: 1,
				providerCostMicros: 1,
				usageQuality: "gateway_reported",
				providerCostQuality: "estimated",
				meteringReady: true,
				occurredAt: now,
				now,
			}),
		).rejects.toThrow(
			"billingReservationId is required for customer usage settlement",
		);
	});

	it("records provider-specific units without enabling customer metering", async () => {
		const { db, now } = setup();
		const usage = await recordBillingProviderUsage(db, {
			id: "provider-usage-1",
			organizationId: "org-1",
			gatewayLogId: "voice-gateway-1",
			provider: "workers-ai",
			model: "@cf/deepgram/aura-1",
			usageKind: "voice_tts",
			unit: "characters",
			quantity: 42,
			providerCostMicros: 0,
			providerCostQuality: "gateway_reported",
			occurredAt: now,
			now,
		});
		expect(usage).toMatchObject({
			quantity: 42,
			customerMeteringReady: false,
		});
		const duplicate = await recordBillingProviderUsage(db, {
			id: "provider-usage-duplicate",
			organizationId: "org-1",
			gatewayLogId: "voice-gateway-1",
			provider: "workers-ai",
			model: "@cf/deepgram/aura-1",
			usageKind: "voice_tts",
			unit: "characters",
			quantity: 42,
			providerCostMicros: 0,
			providerCostQuality: "gateway_reported",
			occurredAt: now,
			now,
		});
		expect(duplicate.id).toBe("provider-usage-1");
	});

	it("leases, retries, deduplicates, and orders Stripe webhook receipts", async () => {
		const { db, now } = setup();
		const lease = new Date(Date.now() + 60_000).toISOString();
		const first = await claimStripeWebhookEvent(db, {
			eventId: "evt-old",
			eventType: "customer.subscription.updated",
			entityKey: "sub-1",
			eventCreatedAt: 100,
			now,
			leaseExpiresAt: lease,
		});
		expect(first.claimed).toBe(true);
		const duplicate = await claimStripeWebhookEvent(db, {
			eventId: "evt-old",
			eventType: "customer.subscription.updated",
			entityKey: "sub-1",
			eventCreatedAt: 100,
			now,
			leaseExpiresAt: lease,
		});
		expect(duplicate.claimed).toBe(false);

		await markStripeWebhookEventFailed(db, {
			...first.event,
			error: "temporary Stripe read failure",
			now,
		});
		const retry = await claimStripeWebhookEvent(db, {
			eventId: "evt-old",
			eventType: "customer.subscription.updated",
			entityKey: "sub-1",
			eventCreatedAt: 100,
			now,
			leaseExpiresAt: lease,
		});
		expect(retry).toMatchObject({
			claimed: true,
			event: { attemptCount: 2, status: "processing" },
		});
		expect(
			await markStripeWebhookEventProcessed(db, {
				...first.event,
				outcome: "applied",
				now,
			}),
		).toBe(false);
		expect(
			await markStripeWebhookEventProcessed(db, {
				...retry.event,
				outcome: "applied",
				now,
			}),
		).toBe(true);

		const newer = await claimStripeWebhookEvent(db, {
			eventId: "evt-new",
			eventType: "customer.subscription.deleted",
			entityKey: "sub-1",
			eventCreatedAt: 200,
			now,
			leaseExpiresAt: lease,
		});
		await markStripeWebhookEventProcessed(db, {
			...newer.event,
			outcome: "applied",
			now,
		});
		expect(
			await hasNewerProcessedStripeWebhookEvent(db, {
				entityKey: "sub-1",
				eventCreatedAt: 100,
				eventId: "evt-old",
			}),
		).toBe(true);
	});

	it("fences customer billing and feature writes against newer events and expired leases", async () => {
		const { db, now, sqlite } = setup();
		const entitlement = await getBillingEntitlement(db, "org-1");
		if (!entitlement) throw new Error("Missing billing fixture");
		const input = {
			account: entitlement.account,
			applyPlanFeatures: true,
			planKey: "growth",
			status: "cancelled",
			stripeEnvironment: "live",
			stripeCustomerId: "cus_1",
			periodStart: PERIOD_START,
			periodEnd: PERIOD_END,
			now,
		} as const;
		const leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
		const older = await claimStripeWebhookEvent(db, {
			eventId: "evt-old",
			eventType: "invoice.paid",
			entityKey: "invoice:in_1",
			eventCreatedAt: 100,
			now,
			leaseExpiresAt,
		});
		const newer = await claimStripeWebhookEvent(db, {
			eventId: "evt-new",
			eventType: "customer.subscription.deleted",
			entityKey: "sub:sub_1",
			eventCreatedAt: 200,
			now,
			leaseExpiresAt,
		});
		expect(await applyStripeBillingWebhook(db, newer.event, input)).toBe(
			"applied",
		);
		const features = () =>
			sqlite
				.prepare(
					"SELECT features, updated_at FROM organizations WHERE id = 'org-1'",
				)
				.get();
		const appliedFeatures = features();
		expect(appliedFeatures).toMatchObject({ updated_at: now });
		expect(JSON.parse(String(appliedFeatures?.features))).toMatchObject({
			os: false,
		});
		const outdatedInput = {
			...input,
			status: "active",
			now: "2026-07-28T00:00:00.000Z",
		} as const;
		expect(
			await applyStripeBillingWebhook(db, older.event, outdatedInput),
		).toBe("skipped_stale");

		const expired = await claimStripeWebhookEvent(db, {
			eventId: "evt-expired",
			eventType: "customer.subscription.updated",
			entityKey: "sub:sub_1",
			eventCreatedAt: 300,
			now,
			leaseExpiresAt: "2000-01-01T00:00:00.000Z",
		});
		const current = await getBillingEntitlement(db, "org-1");
		if (!current) throw new Error("Missing billing fixture");
		expect(
			await markStripeWebhookEventProcessed(db, {
				...expired.event,
				outcome: "applied",
				now,
			}),
		).toBe(false);
		await expect(
			applyStripeBillingWebhook(db, expired.event, {
				...outdatedInput,
				account: current.account,
			}),
		).rejects.toThrow("Stripe webhook lease or billing account changed");
		const retry = await claimStripeWebhookEvent(db, {
			...expired.event,
			now,
			leaseExpiresAt,
		});
		sqlite.exec(`CREATE TRIGGER reject_billing_projection BEFORE UPDATE ON billing_accounts
			BEGIN SELECT RAISE(ABORT, 'billing projection failed'); END`);
		await expect(
			applyStripeBillingWebhook(db, retry.event, {
				...outdatedInput,
				account: current.account,
			}),
		).rejects.toThrow("billing projection failed");
		expect(
			sqlite
				.prepare(
					"SELECT status, outcome FROM stripe_webhook_events WHERE event_id = ?",
				)
				.get(retry.event.eventId),
		).toMatchObject({ status: "processing", outcome: null });
		expect(await getBillingEntitlement(db, "org-1")).toEqual(current);
		expect(current.account).toMatchObject({
			status: "cancelled",
			entitlementVersion: entitlement.account.entitlementVersion + 1,
			stripeWebhookEventCreatedAt: 200,
		});
		expect(features()).toEqual(appliedFeatures);
	});
});

describe("stripe meter outbox dead-letter", () => {
	function seedOutboxRow(
		sqlite: DatabaseSync,
		now: string,
		attemptCount: number,
		stripeEnvironment: "test" | "live" = "live",
	) {
		sqlite
			.prepare(
				`INSERT INTO billing_credit_consumptions (
					id, organization_id, kind, source_ref, period_start, period_end,
					credits, included_credits, top_up_credits, payg_credits,
					payg_charge_micros, created_at
				) VALUES ('consumption-x', 'org-1', 'code_run', 'run-x', ?, ?,
					10, 0, 0, 10, 100000, ?)`,
			)
			.run(PERIOD_START, PERIOD_END, now);
		sqlite
			.prepare(
				`INSERT INTO billing_credit_meter_outbox (
					id, organization_id, consumption_id, stripe_customer_id,
					stripe_environment, event_name,
					quantity, idempotency_key, status, attempt_count, next_attempt_at,
					created_at, updated_at
				) VALUES ('outbox-1', 'org-1', 'consumption-x', 'cus_1', ?, 'tedix_credits',
					10, 'credit-meter:consumption-x', 'pending', ?, ?, ?, ?)`,
			)
			.run(stripeEnvironment, attemptCount, now, now, now);
	}

	function outboxRow(sqlite: DatabaseSync) {
		return sqlite
			.prepare(
				"SELECT status, attempt_count AS attempts FROM billing_credit_meter_outbox WHERE id = 'outbox-1'",
			)
			.get() as { status: string; attempts: number };
	}

	it("keeps a row below the ceiling retryable as failed", async () => {
		const { db, sqlite, now } = setup();
		seedOutboxRow(sqlite, now, 3);
		const later = "2999-01-01T00:00:00.000Z";
		const claimed = await claimStripeMeterOutbox(db, {
			now,
			leaseExpiresAt: later,
			limit: 10,
		});
		expect(claimed).toHaveLength(1);
		await markStripeMeterOutboxFailed(db, {
			id: "outbox-1",
			error: "stripe 500",
			nextAttemptAt: now,
			now,
		});
		expect(outboxRow(sqlite)).toEqual({ status: "failed", attempts: 4 });
		// Still claimable on the next drain.
		const reclaimed = await claimStripeMeterOutbox(db, {
			now,
			leaseExpiresAt: later,
			limit: 10,
		});
		expect(reclaimed).toHaveLength(1);
	});

	it("never claims a row from the other Stripe environment", async () => {
		const { db, sqlite, now } = setup();
		seedOutboxRow(sqlite, now, 0, "test");
		const liveClaim = await claimStripeMeterOutbox(db, {
			now,
			leaseExpiresAt: "2999-01-01T00:00:00.000Z",
			limit: 10,
			stripeEnvironment: "live",
		});
		expect(liveClaim).toHaveLength(0);
		const testClaim = await claimStripeMeterOutbox(db, {
			now,
			leaseExpiresAt: "2999-01-01T00:00:00.000Z",
			limit: 10,
			stripeEnvironment: "test",
		});
		expect(testClaim).toHaveLength(1);
	});

	it("dead-letters a row at the attempt ceiling and never re-claims it", async () => {
		const { db, sqlite, now } = setup();
		seedOutboxRow(sqlite, now, STRIPE_METER_OUTBOX_MAX_ATTEMPTS - 1);
		const later = "2999-01-01T00:00:00.000Z";
		const claimed = await claimStripeMeterOutbox(db, {
			now,
			leaseExpiresAt: later,
			limit: 10,
		});
		expect(claimed).toHaveLength(1);
		await markStripeMeterOutboxFailed(db, {
			id: "outbox-1",
			error: "customer deleted",
			nextAttemptAt: now,
			now,
		});
		expect(outboxRow(sqlite)).toEqual({
			status: "dead",
			attempts: STRIPE_METER_OUTBOX_MAX_ATTEMPTS,
		});
		const reclaimed = await claimStripeMeterOutbox(db, {
			now,
			leaseExpiresAt: later,
			limit: 10,
		});
		expect(reclaimed).toHaveLength(0);
	});
});

it("automatic customer billing activation is fenced and preserves period and usage", async () => {
	const { db, sqlite, now } = setup();
	sqlite.exec(
		"UPDATE billing_accounts SET status='trial', billing_mode='trial', stripe_customer_id=NULL",
	);
	const input = {
		organizationId: "org-1",
		entitlementVersion: 1,
		planVersionId: "growth-v1",
		metadata: { providerCustomerKey: "key" },
		now,
	};
	await activateProviderCustomerBilling(db, input);
	let account = (await getBillingEntitlement(db, "org-1"))!.account;
	expect(account).toMatchObject({
		status: "active",
		billingMode: "internal",
		entitlementVersion: 2,
		periodStart: "2026-07-01T00:00:00.000Z",
		periodEnd: "2026-08-01T00:00:00.000Z",
	});
	sqlite.exec("UPDATE billing_accounts SET status='suspended'");
	await activateProviderCustomerBilling(db, input);
	account = (await getBillingEntitlement(db, "org-1"))!.account;
	expect(account.status).toBe("suspended");
	expect(account.entitlementVersion).toBe(2);
});

describe("billing reservation query budgets", () => {
	it.each([
		"2026-07-01T00:00:00.000Z",
		"2026-08-01T00:00:00.123Z",
		"2026-08-01T02:00:00.123+02:00",
	])("preserves expiry and period totals at %s", async (at) => {
		const { db, sqlite, now } = setup();
		const second = Math.floor(Date.parse(at) / 1000) * 1000;
		for (const [id, expiry, status, start, end] of [
			["expired", second - 1, "reserved", "2026-07-01", "2026-08-01"],
			["same-second", second + 500, "reserved", "2026-07-01", "2026-08-01"],
			["live", second + 1000, "reserved", "2026-07-01", "2026-08-01"],
			["live-2", second + 2000, "reserved", "2026-07-01", "2026-08-01"],
			["settled", second + 1000, "settled", "2026-07-01", "2026-08-01"],
			["prior-period", second + 1000, "reserved", "2026-06-01", "2026-08-01"],
			["next-period", second + 1000, "reserved", "2026-07-01", "2026-09-01"],
		] as const) {
			insertReservation(sqlite, { id, now, credits: 25 });
			sqlite
				.prepare(`UPDATE billing_usage_reservations SET expires_at=?, status=?,
				period_start=?, period_end=? WHERE id=?`)
				.run(
					new Date(expiry).toISOString(),
					status,
					`${start}T00:00:00.000Z`,
					`${end}T00:00:00.000Z`,
					id,
				);
		}
		const legacy = sqlite
			.prepare(`SELECT SUM(credits) AS credits
			FROM billing_usage_reservations WHERE organization_id='org-1' AND status='reserved'
			AND datetime(expires_at)>datetime(?)
			AND period_start='2026-07-01T00:00:00.000Z' AND period_end='2026-08-01T00:00:00.000Z'`)
			.get(at)!;
		expect(legacy).toMatchObject({ credits: 50 });
		expect(
			await getCreditPoolSnapshot(db, { organizationId: "org-1", now: at }),
		).toMatchObject({ heldCredits: 50, availableCredits: 50 });
		sqlite.close();
	});

	it("aggregates reservations once through the org/status/expiry index range", async () => {
		let query = "";
		const { db, sqlite, now } = setup((sql) => {
			query = sql;
		});
		await getCreditPoolSnapshot(db, { organizationId: "org-1", now });
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
			.map((row) => String(row.detail));
		const searches = plan.filter((line) =>
			/SEARCH (?:held_ai|billing_usage_reservations) USING INDEX idx_billing_reservation_org_status/.test(
				line,
			),
		);
		// The pool hold, plus the tedi and member holds read only under a cap.
		expect(searches.length).toBeGreaterThanOrEqual(1);
		for (const search of searches)
			expect(search).toMatch(
				/organization_id=\? AND status=\? AND expires_at>\?/,
			);
		expect(
			plan.some((line) =>
				/SCAN (?:held_ai\b|billing_usage_reservations\b)/.test(line),
			),
		).toBe(false);
		sqlite.close();
	});

	it("expires at most 500 reservations per tick and converges without touching live or settled rows", async () => {
		let query = "";
		const { db, sqlite, now } = setup((sql) => {
			query = sql;
		});
		for (let index = 0; index < 503; index++) {
			insertReservation(sqlite, { id: `expired-${index}`, now });
		}
		sqlite
			.prepare("UPDATE billing_usage_reservations SET expires_at=?")
			.run(now);
		insertReservation(sqlite, { id: "live", now });
		insertReservation(sqlite, { id: "settled", now, status: "settled" });
		expect(await expireBillingReservations(db, now)).toBe(500);
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
			.map((row) => String(row.detail));
		expect(
			plan.some((line) =>
				/SEARCH billing_usage_reservations USING INDEX idx_billing_reservation_status_expiry \(status=\? AND expires_at<\?\)/.test(
					line,
				),
			),
		).toBe(true);
		expect(
			plan.some((line) => /SCAN billing_usage_reservations/.test(line)),
		).toBe(false);
		expect(await expireBillingReservations(db, now)).toBe(3);
		expect(await expireBillingReservations(db, now)).toBe(0);
		expect(
			sqlite
				.prepare(
					"SELECT id, status FROM billing_usage_reservations WHERE status!='expired' ORDER BY id",
				)
				.all(),
		).toEqual([
			{ id: "live", status: "reserved" },
			{ id: "settled", status: "settled" },
		]);
		sqlite.close();
	});
});

it("reserves and settles non-token Worker cost once as code credits, preserving tenant scope", async () => {
	const { db, sqlite, now } = setup();
	try {
		const decision = await reserveBillingUsage(db, {
			id: "worker-reservation",
			organizationId: "org-1",
			source: "system",
			provider: "cloudflare-dynamic-workers",
			model: "dynamic-worker",
			estimatedInputTokens: 0,
			estimatedOutputTokens: 0,
			credits: 1,
			idempotencyKey: "worker-1",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
		});
		expect(decision.allowed).toBe(true);
		const charge = {
			id: "worker-charge",
			organizationId: "org-1",
			reservationId: "worker-reservation",
			providerUsageId: "worker-1",
			source: "system" as const,
			provider: "cloudflare-dynamic-workers",
			model: "dynamic-worker",
			inputTokens: 0,
			outputTokens: 0,
			providerCostMicros: 2000,
			usageQuality: "gateway_reported" as const,
			providerCostQuality: "estimated" as const,
			meteringReady: true,
			occurredAt: now,
			now,
		};
		await expect(
			settleBillingUsage(db, { ...charge, organizationId: "other-org" }),
		).rejects.toThrow();
		await settleBillingUsage(db, charge);
		await settleBillingUsage(db, charge);
		expect(
			sqlite
				.prepare("SELECT kind, credits FROM billing_credit_consumptions")
				.all(),
		).toEqual([{ kind: "code_run", credits: 1 }]);
		expect(
			sqlite
				.prepare(
					"SELECT status FROM billing_usage_reservations WHERE id='worker-reservation'",
				)
				.get(),
		).toEqual({ status: "settled" });
		expect(
			sqlite
				.prepare(
					"SELECT used_input_tokens, used_output_tokens, provider_cost_micros FROM billing_usage_periods",
				)
				.get(),
		).toEqual({
			used_input_tokens: 0,
			used_output_tokens: 0,
			provider_cost_micros: 2000,
		});
	} finally {
		sqlite.close();
	}
});
