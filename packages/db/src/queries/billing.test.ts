import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	expireBillingCredits,
	getBillingBalanceSnapshot,
	grantBillingCredit,
} from "./billing/credits";
import {
	getInferenceCapacityDailyOverview,
	recordCapacityAllocation,
	transferSponsoredCapacity,
} from "./billing/capacity-allocations";
import {
	getActiveInferenceCapacityPackByKey,
	listActiveInferenceCapacityPacks,
} from "./billing/capacity-packs";
import { recordBillingProviderReconciliation } from "./billing/health";
import {
	claimStripeMeterOutbox,
	markStripeMeterOutboxFailed,
	STRIPE_METER_OUTBOX_MAX_ATTEMPTS,
} from "./billing/meter-outbox";
import {
	getBillingEntitlement,
	activateProviderCustomerBilling,
	getBillingEntitlementByStripeCustomerId,
	linkBillingAccountStripeCustomerIfUnbound,
} from "./billing/plans";
import { recordBillingProviderUsage } from "./billing/provider-usage";
import { reserveBillingUsage } from "./billing/reservations";
import { settleBillingUsage } from "./billing/settlement";
import {
	claimStripeWebhookEvent,
	hasNewerProcessedStripeWebhookEvent,
	markStripeWebhookEventFailed,
	markStripeWebhookEventProcessed,
} from "./billing/stripe-webhooks";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (
			id TEXT PRIMARY KEY,
			metadata TEXT NOT NULL DEFAULT '{}'
		);
		CREATE TABLE tedis (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL
		);
		CREATE TABLE provider_installations (
			customer_organization_id TEXT NOT NULL
		);
		CREATE TABLE billing_plan_versions (
			id TEXT PRIMARY KEY,
			plan_key TEXT NOT NULL,
			version INTEGER NOT NULL,
			status TEXT NOT NULL,
			name TEXT NOT NULL,
			currency TEXT NOT NULL,
			monthly_price_micros INTEGER NOT NULL,
			annual_price_micros INTEGER NOT NULL,
			included_monthly_tokens INTEGER NOT NULL,
			included_monthly_credit_micros INTEGER NOT NULL,
			overage_unit_tokens INTEGER NOT NULL,
			overage_unit_price_micros INTEGER NOT NULL,
			max_tedis INTEGER NOT NULL,
			max_cron_jobs_per_tedi INTEGER NOT NULL,
			max_iterations_per_task INTEGER NOT NULL,
			default_daily_token_limit INTEGER NOT NULL,
			default_daily_message_limit INTEGER NOT NULL,
			allow_overage INTEGER NOT NULL,
			metadata TEXT NOT NULL DEFAULT '{}',
			effective_at TEXT NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE billing_accounts (
			organization_id TEXT PRIMARY KEY,
			plan_version_id TEXT NOT NULL,
			status TEXT NOT NULL,
			billing_mode TEXT NOT NULL,
			stripe_environment TEXT DEFAULT 'live',
			stripe_customer_id TEXT,
			stripe_subscription_id TEXT,
			stripe_cancel_at_period_end INTEGER,
			period_start TEXT NOT NULL,
			period_end TEXT NOT NULL,
			hard_spend_limit_micros INTEGER,
			credit_balance_micros INTEGER NOT NULL DEFAULT 0,
			grace_ends_at TEXT,
			entitlement_version INTEGER NOT NULL DEFAULT 1,
			metadata TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE billing_credit_entries (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			amount_micros INTEGER NOT NULL,
			source_type TEXT NOT NULL,
			source_ref TEXT,
			usage_charge_id TEXT,
			idempotency_key TEXT NOT NULL UNIQUE,
			expires_at TEXT,
			description TEXT,
			metadata TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		);
		CREATE TABLE billing_inference_capacity_pack_versions (
			id TEXT PRIMARY KEY,
			pack_key TEXT NOT NULL,
			version INTEGER NOT NULL,
			status TEXT NOT NULL,
			name TEXT NOT NULL,
			currency TEXT NOT NULL,
			price_micros INTEGER NOT NULL,
			token_amount INTEGER NOT NULL,
			spend_amount_micros INTEGER NOT NULL,
			stripe_environment TEXT NOT NULL,
			stripe_lookup_key TEXT NOT NULL,
			metadata TEXT NOT NULL DEFAULT '{}',
			effective_at TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE(pack_key, version, stripe_environment),
			UNIQUE(stripe_environment, stripe_lookup_key)
		);
		CREATE TABLE billing_capacity_allocations (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			pack_version_id TEXT,
			budget_day TEXT NOT NULL,
			token_amount INTEGER NOT NULL,
			spend_amount_micros INTEGER NOT NULL,
			source_type TEXT NOT NULL,
			source_ref TEXT,
			idempotency_key TEXT NOT NULL UNIQUE,
			stripe_environment TEXT NOT NULL,
			expires_at TEXT NOT NULL,
			metadata TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		);
		CREATE TRIGGER billing_credit_entries_apply_insert
		AFTER INSERT ON billing_credit_entries BEGIN
			UPDATE billing_accounts
			SET credit_balance_micros = credit_balance_micros + NEW.amount_micros
			WHERE organization_id = NEW.organization_id;
		END;
		CREATE TABLE billing_usage_reservations (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			plan_version_id TEXT NOT NULL,
			tedi_id TEXT,
			status TEXT NOT NULL,
			source TEXT NOT NULL,
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			estimated_input_tokens INTEGER NOT NULL,
			estimated_output_tokens INTEGER NOT NULL,
			estimated_charge_micros INTEGER NOT NULL,
			period_start TEXT NOT NULL,
			period_end TEXT NOT NULL,
			run_id TEXT,
			trace_id TEXT,
			idempotency_key TEXT NOT NULL UNIQUE,
			rejection_code TEXT,
			expires_at TEXT NOT NULL,
			settled_at TEXT,
			released_at TEXT,
			metadata TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE billing_usage_periods (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			plan_version_id TEXT NOT NULL,
			period_start TEXT NOT NULL,
			period_end TEXT NOT NULL,
			included_tokens INTEGER NOT NULL,
			used_input_tokens INTEGER NOT NULL DEFAULT 0,
			used_output_tokens INTEGER NOT NULL DEFAULT 0,
			metered_overage_tokens INTEGER NOT NULL DEFAULT 0,
			provider_cost_micros INTEGER NOT NULL DEFAULT 0,
			customer_charge_micros INTEGER NOT NULL DEFAULT 0,
			credit_applied_micros INTEGER NOT NULL DEFAULT 0,
			settlement_version INTEGER NOT NULL DEFAULT 0,
			last_settlement_id TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(organization_id, period_start, period_end)
		);
		CREATE TABLE billing_usage_charges (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			tedi_id TEXT,
			reservation_id TEXT,
			usage_period_id TEXT NOT NULL,
			gateway_log_id TEXT UNIQUE,
			provider_usage_id TEXT UNIQUE,
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			source TEXT NOT NULL,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			included_tokens_applied INTEGER NOT NULL,
			metered_overage_tokens INTEGER NOT NULL,
			provider_cost_micros INTEGER NOT NULL,
			customer_charge_micros INTEGER NOT NULL,
			credit_applied_micros INTEGER NOT NULL,
			usage_quality TEXT NOT NULL,
			provider_cost_quality TEXT NOT NULL,
			metering_ready INTEGER NOT NULL,
			provider_reconciled_at TEXT,
			rate_card_version TEXT,
			occurred_at TEXT NOT NULL,
			metadata TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		);
		CREATE TABLE stripe_meter_outbox (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL,
			usage_charge_id TEXT NOT NULL UNIQUE,
			stripe_customer_id TEXT NOT NULL,
			stripe_environment TEXT NOT NULL DEFAULT 'live',
			event_name TEXT NOT NULL,
			quantity INTEGER NOT NULL,
			idempotency_key TEXT NOT NULL UNIQUE,
			status TEXT NOT NULL,
			attempt_count INTEGER NOT NULL DEFAULT 0,
			next_attempt_at TEXT NOT NULL,
			lease_expires_at TEXT,
			stripe_event_id TEXT,
			last_error TEXT,
			sent_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE billing_usage_quarantines (
			id TEXT PRIMARY KEY,
			gateway_log_id TEXT NOT NULL UNIQUE,
			organization_id TEXT,
			reason TEXT NOT NULL,
			source_snapshot_at TEXT NOT NULL,
			metadata TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		);
		CREATE TABLE billing_provider_usage (
			id TEXT PRIMARY KEY,
			organization_id TEXT,
			tedi_id TEXT,
			reservation_id TEXT,
			gateway_log_id TEXT UNIQUE,
			provider_usage_id TEXT UNIQUE,
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			usage_kind TEXT NOT NULL,
			unit TEXT NOT NULL,
			quantity INTEGER NOT NULL,
			provider_cost_micros INTEGER NOT NULL DEFAULT 0,
			provider_cost_quality TEXT NOT NULL,
			customer_metering_ready INTEGER NOT NULL DEFAULT 0,
			occurred_at TEXT NOT NULL,
			metadata TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL
		);
		CREATE TABLE stripe_webhook_events (
			event_id TEXT PRIMARY KEY,
			event_type TEXT NOT NULL,
			entity_key TEXT NOT NULL,
			event_created_at INTEGER NOT NULL,
			status TEXT NOT NULL,
			attempt_count INTEGER NOT NULL DEFAULT 1,
			lease_expires_at TEXT,
			outcome TEXT,
			last_error TEXT,
			processed_at TEXT,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);
		CREATE TABLE billing_provider_reconciliations (
			id TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			provider_resource TEXT NOT NULL DEFAULT '',
			period_start TEXT NOT NULL,
			period_end TEXT NOT NULL,
			ledger_cost_micros INTEGER NOT NULL,
			provider_cost_micros INTEGER NOT NULL,
			variance_micros INTEGER NOT NULL,
			usage_row_count INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL,
			evidence_ref TEXT,
			reconciled_by TEXT,
			reconciled_at TEXT,
			metadata TEXT NOT NULL DEFAULT '{}',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			UNIQUE(provider, provider_resource, period_start, period_end)
		);
	`);
	sqlite
		.prepare(`
		INSERT INTO billing_inference_capacity_pack_versions (
			id, pack_key, version, status, name, currency, price_micros,
			token_amount, spend_amount_micros, stripe_environment,
			stripe_lookup_key, effective_at, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`)
		.run(
			"capacity-pack-daily-5m-test-v1",
			"daily_5m",
			1,
			"active",
			"5M daily boost",
			"usd",
			25_000_000,
			5_000_000,
			25_000_000,
			"test",
			"tedix_inference_capacity_daily_5m_v1",
			"2026-07-01T00:00:00.000Z",
			"2026-07-01T00:00:00.000Z",
		);
	const now = "2026-07-27T12:00:00.000Z";
	sqlite.prepare(`INSERT INTO organizations (id) VALUES (?)`).run("org-1");
	sqlite
		.prepare(
			`INSERT INTO billing_plan_versions VALUES (
				'growth-v1','growth',1,'active','Growth','usd',
				249000000,2399000000,1000,0,1000,50000,
				1,10,16,1000,200,1,
				'{}','2026-01-01T00:00:00.000Z',?
			)`,
		)
		.run(now);
	sqlite
		.prepare(
			`INSERT INTO billing_accounts (
				organization_id, plan_version_id, status, billing_mode,
				stripe_environment, stripe_customer_id,
				period_start, period_end, created_at, updated_at
			) VALUES ('org-1','growth-v1','active','stripe','live','cus_1',?,?,?,?)`,
		)
		.run("2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", now, now);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite, now };
}

function insertReservation(
	sqlite: DatabaseSync,
	input: {
		id: string;
		status?: "reserved" | "expired" | "settled";
		tediId?: string;
		estimatedInputTokens?: number;
		estimatedOutputTokens?: number;
		now: string;
	},
) {
	sqlite
		.prepare(
			`INSERT INTO billing_usage_reservations (
				id, organization_id, plan_version_id, tedi_id, status, source,
				provider, model, estimated_input_tokens, estimated_output_tokens,
				estimated_charge_micros, period_start, period_end,
				idempotency_key, expires_at, created_at, updated_at
			) VALUES (?, 'org-1', 'growth-v1', ?, ?, 'operator', 'azure-openai',
				'gpt-5.6-terra', ?, ?, 0, '2026-07-01T00:00:00.000Z',
				'2026-08-01T00:00:00.000Z', ?, '2026-07-27T12:10:00.000Z', ?, ?)`,
		)
		.run(
			input.id,
			input.tediId ?? null,
			input.status ?? "reserved",
			input.estimatedInputTokens ?? 0,
			input.estimatedOutputTokens ?? 0,
			`test:${input.id}`,
			input.now,
			input.now,
		);
}

function insertCharge(
	sqlite: DatabaseSync,
	input: {
		id: string;
		reservationId: string;
		inputTokens: number;
		outputTokens: number;
		now: string;
	},
) {
	sqlite
		.prepare(
			`INSERT OR IGNORE INTO billing_usage_periods (
				id, organization_id, plan_version_id, period_start, period_end,
				included_tokens, created_at, updated_at
			) VALUES ('org-1:2026-07-01T00:00:00.000Z', 'org-1', 'growth-v1',
				'2026-07-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 1000, ?, ?)`,
		)
		.run(input.now, input.now);
	sqlite
		.prepare(
			`INSERT INTO billing_usage_charges (
				id, organization_id, reservation_id, usage_period_id,
				gateway_log_id, provider, model, source, input_tokens,
				output_tokens, included_tokens_applied, metered_overage_tokens,
				provider_cost_micros, customer_charge_micros, credit_applied_micros,
				usage_quality, provider_cost_quality, metering_ready,
				occurred_at, created_at
			) VALUES (?, 'org-1', ?, 'org-1:2026-07-01T00:00:00.000Z', ?,
				'azure-openai', 'gpt-5.6-terra', 'operator', ?, ?, 0, 0, 0, 0, 0,
				'gateway_reported', 'gateway_reported', 0, ?, ?)`,
		)
		.run(
			input.id,
			input.reservationId,
			`gateway:${input.id}`,
			input.inputTokens,
			input.outputTokens,
			input.now,
			input.now,
		);
}

describe("inference capacity daily overview used tokens", () => {
	it("counts settled reservations by their charge, not the 16k estimate", async () => {
		const { db, sqlite, now } = setup();
		// (1) settled WITH a charge: the actual tokens win over the estimate.
		insertReservation(sqlite, {
			id: "settled-charged",
			status: "settled",
			estimatedInputTokens: 10_000,
			estimatedOutputTokens: 16_000,
			now,
		});
		insertCharge(sqlite, {
			id: "charge-settled-charged",
			reservationId: "settled-charged",
			inputTokens: 8_500,
			outputTokens: 377,
			now,
		});
		expect(
			await getInferenceCapacityDailyOverview(db, {
				organizationId: "org-1",
				stripeEnvironment: "live",
				now,
			}),
		).toMatchObject({ usedTokens: 8_877 });

		// (2) settled WITHOUT a charge yet: never under-count, keep the estimate.
		insertReservation(sqlite, {
			id: "settled-unreconciled",
			status: "settled",
			estimatedInputTokens: 2_000,
			estimatedOutputTokens: 16_000,
			now,
		});
		expect(
			await getInferenceCapacityDailyOverview(db, {
				organizationId: "org-1",
				stripeEnvironment: "live",
				now,
			}),
		).toMatchObject({ usedTokens: 8_877 + 18_000 });

		// (3) reserved (in-flight) rows still count their estimate.
		insertReservation(sqlite, {
			id: "in-flight",
			status: "reserved",
			estimatedInputTokens: 3_000,
			estimatedOutputTokens: 16_000,
			now,
		});
		// Expired rows and other days are excluded, as before.
		insertReservation(sqlite, {
			id: "expired-row",
			status: "expired",
			estimatedInputTokens: 50_000,
			estimatedOutputTokens: 50_000,
			now,
		});
		insertReservation(sqlite, {
			id: "yesterday-settled",
			status: "settled",
			estimatedInputTokens: 50_000,
			estimatedOutputTokens: 50_000,
			now: "2026-07-26T12:00:00.000Z",
		});

		// (4) the mixed day is the sum of actuals, fallbacks, and estimates.
		expect(
			await getInferenceCapacityDailyOverview(db, {
				organizationId: "org-1",
				stripeEnvironment: "live",
				now,
			}),
		).toMatchObject({ usedTokens: 8_877 + 18_000 + 19_000 });
	});
});

describe("inference admission counts settled reservations by actual tokens", () => {
	function attempt(
		id: string,
		aiGatewayLimits: NonNullable<
			Parameters<typeof reserveBillingUsage>[1]["aiGatewayLimits"]
		>,
	) {
		return {
			id,
			organizationId: "org-1",
			tediId: "tedi-1",
			source: "operator" as const,
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 500,
			estimatedOutputTokens: 500,
			idempotencyKey: `reserve:${id}`,
			expiresAt: "2026-07-27T12:10:00.000Z",
			now: "2026-07-27T12:00:00.000Z",
			stripeEnvironment: "live" as const,
			aiGatewayLimits,
		};
	}

	it("admits under actuals what the estimate alone would deny", async () => {
		const { db, sqlite, now } = setup();
		sqlite.exec("UPDATE billing_accounts SET status='trial'");
		// One settled turn estimated at 16k output but actually ~377.
		insertReservation(sqlite, {
			id: "settled-turn",
			status: "settled",
			tediId: "tedi-1",
			estimatedInputTokens: 4_000,
			estimatedOutputTokens: 16_000,
			now,
		});
		insertCharge(sqlite, {
			id: "charge-settled-turn",
			reservationId: "settled-turn",
			inputTokens: 4_000,
			outputTokens: 377,
			now,
		});
		// Estimate: 20_000 + 1_000 > 10_000 -> would be denied.
		// Actual:   4_377 + 1_000 <= 10_000 -> admitted.
		const orgDay = await reserveBillingUsage(
			db,
			attempt("org-day-actuals", { organizationDailyTokenLimit: 10_000 }),
		);
		expect(orgDay).toMatchObject({ allowed: true });
		const tediDay = await reserveBillingUsage(
			db,
			attempt("tedi-day-actuals", { tediDailyTokenLimit: 10_000 }),
		);
		expect(tediDay).toMatchObject({ allowed: true });

		// Day usage is now 4_377 (actual) + 1_000 + 1_000 (in flight, estimates).
		// A limit the actuals genuinely exceed still denies on both scopes.
		const orgDenied = await reserveBillingUsage(
			db,
			attempt("org-day-exceeded", { organizationDailyTokenLimit: 7_000 }),
		);
		expect(orgDenied).toMatchObject({
			allowed: false,
			code: "inference_capacity_exhausted",
		});
		const tediDenied = await reserveBillingUsage(
			db,
			attempt("tedi-day-exceeded", { tediDailyTokenLimit: 7_000 }),
		);
		expect(tediDenied).toMatchObject({
			allowed: false,
			code: "inference_capacity_exhausted",
		});
		// The boundary is exact: 6_377 + 1_000 = 7_377 fits a 7_377 limit.
		expect(
			await reserveBillingUsage(
				db,
				attempt("org-day-boundary", { organizationDailyTokenLimit: 7_377 }),
			),
		).toMatchObject({ allowed: true });
	});

	it("keeps the estimate for a settled reservation with no charge yet", async () => {
		const { db, sqlite, now } = setup();
		sqlite.exec("UPDATE billing_accounts SET status='trial'");
		insertReservation(sqlite, {
			id: "settled-unreconciled",
			status: "settled",
			tediId: "tedi-1",
			estimatedInputTokens: 4_000,
			estimatedOutputTokens: 16_000,
			now,
		});
		expect(
			await reserveBillingUsage(
				db,
				attempt("org-day-unreconciled", {
					organizationDailyTokenLimit: 10_000,
				}),
			),
		).toMatchObject({ allowed: false, code: "inference_capacity_exhausted" });
	});
});

describe("billing admission and settlement", () => {
	it("uses monthly metering for active funded overage despite an explicit organization day ceiling", async () => {
		const { db, sqlite, now } = setup();
		const request = (id: string, tediDailyTokenLimit?: number) =>
			reserveBillingUsage(db, {
				id,
				organizationId: "org-1",
				tediId: "tedi-1",
				source: "operator",
				provider: "azure-openai",
				model: "gpt-5.6-terra",
				estimatedInputTokens: 1_001,
				estimatedOutputTokens: 0,
				idempotencyKey: `reserve:${id}`,
				expiresAt: "2026-07-27T12:10:00.000Z",
				now,
				stripeEnvironment: "live",
				aiGatewayLimits: {
					organizationDailyTokenLimit: 0,
					organizationDailySpendLimitMicros: 0,
					...(tediDailyTokenLimit === undefined ? {} : { tediDailyTokenLimit }),
				},
			});
		expect(await request("monthly-first")).toMatchObject({ allowed: true });
		expect(await request("tedi-policy-still-applies", 900)).toMatchObject({
			allowed: false,
			code: "inference_capacity_exhausted",
		});
		sqlite.exec("UPDATE billing_accounts SET hard_spend_limit_micros=0");
		expect(await request("hard-spend-still-applies")).toMatchObject({
			allowed: false,
			code: "hard_spend_limit",
		});
	});

	it("monthly-meters an existing internal customer linked to a provider installation", async () => {
		const { db, sqlite, now } = setup();
		sqlite.exec(
			"UPDATE billing_accounts SET billing_mode='internal', stripe_customer_id=NULL",
		);
		sqlite.exec(
			"INSERT INTO provider_installations (customer_organization_id) VALUES ('org-1')",
		);
		expect(await getBillingBalanceSnapshot(db, "org-1", now)).toMatchObject({
			isSponsoredCustomer: false,
		});
		const decision = await reserveBillingUsage(db, {
			id: "linked-existing-customer",
			organizationId: "org-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 1_001,
			estimatedOutputTokens: 0,
			idempotencyKey: "reserve:linked-existing-customer",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
			stripeEnvironment: "live",
			aiGatewayLimits: { organizationDailyTokenLimit: 0 },
		});
		expect(decision).toMatchObject({ allowed: true });
	});

	it("keeps a provider-provisioned internal customer within its sponsored daily grant", async () => {
		const { db, sqlite, now } = setup();
		sqlite.exec(
			"UPDATE billing_accounts SET billing_mode='internal', stripe_customer_id=NULL",
		);
		sqlite
			.prepare("UPDATE organizations SET metadata=? WHERE id='org-1'")
			.run(JSON.stringify({ providerCustomerKey: "provider-key" }));
		expect(await getBillingBalanceSnapshot(db, "org-1", now)).toMatchObject({
			isSponsoredCustomer: true,
		});
		expect(
			await reserveBillingUsage(db, {
				id: "provider-provisioned-exhausted",
				organizationId: "org-1",
				source: "operator",
				provider: "azure-openai",
				model: "gpt-5.6-terra",
				estimatedInputTokens: 1_001,
				estimatedOutputTokens: 0,
				idempotencyKey: "reserve:provider-provisioned-exhausted",
				expiresAt: "2026-07-27T12:10:00.000Z",
				now,
				stripeEnvironment: "live",
				aiGatewayLimits: { organizationDailyTokenLimit: 0 },
			}),
		).toMatchObject({ allowed: false, code: "inference_capacity_exhausted" });
	});

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

	it("atomically reserves included allowance and priced overage", async () => {
		const { db, now } = setup();
		const first = await reserveBillingUsage(db, {
			id: "reservation-1",
			organizationId: "org-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 500,
			estimatedOutputTokens: 400,
			idempotencyKey: "reserve:first",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
		});
		expect(first.allowed).toBe(true);

		const second = await reserveBillingUsage(db, {
			id: "reservation-2",
			organizationId: "org-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 500,
			estimatedOutputTokens: 500,
			idempotencyKey: "reserve:second",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
		});
		// Stripe-backed Growth may reserve paid overage.
		expect(second.allowed).toBe(true);
		const snapshot = await getBillingBalanceSnapshot(db, "org-1", now);
		expect(snapshot?.reservedTokens).toBe(1_900);
		expect(snapshot?.reservedChargeMicros).toBe(50_000);
	});

	it("honors an active account pinned to a retired plan version", async () => {
		const { db, sqlite, now } = setup();
		sqlite
			.prepare(
				"UPDATE billing_plan_versions SET status='retired' WHERE id='growth-v1'",
			)
			.run();
		sqlite
			.prepare(
				`INSERT INTO billing_plan_versions VALUES (
					'growth-v2','growth',2,'active','Growth','usd',
					249000000,2399000000,2000,0,1000,50000,
					1,10,16,2000,200,1,
					'{}','2026-07-27T00:00:00.000Z',?
				)`,
			)
			.run(now);

		const decision = await reserveBillingUsage(db, {
			id: "reservation-retired-plan",
			organizationId: "org-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 500,
			estimatedOutputTokens: 400,
			idempotencyKey: "reserve:retired-plan",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
		});

		expect(decision.allowed).toBe(true);
		if (!decision.allowed) {
			throw new Error(`Expected admission, received ${decision.code}`);
		}
		expect(decision.reservation).toEqual({
			id: "reservation-retired-plan",
			planVersionId: "growth-v1",
			expiresAt: "2026-07-27T12:10:00.000Z",
			estimatedChargeMicros: 0,
		});

		sqlite
			.prepare(
				"UPDATE billing_plan_versions SET status='draft' WHERE id='growth-v1'",
			)
			.run();
		const draftDecision = await reserveBillingUsage(db, {
			id: "reservation-draft-plan",
			organizationId: "org-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 1,
			estimatedOutputTokens: 1,
			idempotencyKey: "reserve:draft-plan",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
		});
		expect(draftDecision.allowed).toBe(false);
	});

	it("applies credits before emitting idempotent Stripe overage", async () => {
		const { db, sqlite, now } = setup();
		insertReservation(sqlite, { id: "reservation-credit", now });
		await grantBillingCredit(db, {
			id: "credit-1",
			organizationId: "org-1",
			amountMicros: 50_000,
			sourceType: "promotion",
			idempotencyKey: "promo:1",
			createdAt: now,
		});
		const charge = await settleBillingUsage(db, {
			id: "charge-1",
			organizationId: "org-1",
			reservationId: "reservation-credit",
			gatewayLogId: "gateway-1",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			source: "operator",
			inputTokens: 1_500,
			outputTokens: 500,
			providerCostMicros: 2_000,
			usageQuality: "gateway_reported",
			providerCostQuality: "estimated",
			meteringReady: true,
			occurredAt: now,
			now,
		});
		expect(charge.includedTokensApplied).toBe(1_000);
		expect(charge.creditAppliedMicros).toBe(50_000);
		expect(charge.meteredOverageTokens).toBe(0);

		const repeated = await settleBillingUsage(db, {
			id: "charge-duplicate",
			organizationId: "org-1",
			reservationId: "reservation-credit",
			gatewayLogId: "gateway-1",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			source: "operator",
			inputTokens: 1_500,
			outputTokens: 500,
			providerCostMicros: 2_000,
			usageQuality: "gateway_reported",
			providerCostQuality: "estimated",
			meteringReady: true,
			occurredAt: now,
			now,
		});
		expect(repeated.id).toBe("charge-1");
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM stripe_meter_outbox").get(),
		).toEqual({
			count: 0,
		});
		expect(
			sqlite
				.prepare(
					"SELECT credit_balance_micros AS balance FROM billing_accounts WHERE organization_id='org-1'",
				)
				.get(),
		).toEqual({ balance: 0 });
	});

	it("fails closed for suspended accounts and unpaid overage", async () => {
		const suspended = setup();
		suspended.sqlite
			.prepare(
				"UPDATE billing_accounts SET status='suspended' WHERE organization_id='org-1'",
			)
			.run();
		const suspendedDecision = await reserveBillingUsage(suspended.db, {
			id: "reservation-suspended",
			organizationId: "org-1",
			source: "automation",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 1,
			estimatedOutputTokens: 1,
			idempotencyKey: "reserve:suspended",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now: suspended.now,
		});
		expect(suspendedDecision).toMatchObject({
			allowed: false,
			code: "subscription_inactive",
		});

		const unpaid = setup();
		unpaid.sqlite
			.prepare(
				"UPDATE billing_accounts SET billing_mode='trial' WHERE organization_id='org-1'",
			)
			.run();
		unpaid.sqlite
			.prepare(
				"UPDATE billing_accounts SET stripe_customer_id=NULL WHERE organization_id='org-1'",
			)
			.run();
		const unpaidDecision = await reserveBillingUsage(unpaid.db, {
			id: "reservation-unpaid",
			organizationId: "org-1",
			source: "automation",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 1_001,
			estimatedOutputTokens: 1,
			idempotencyKey: "reserve:unpaid",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now: unpaid.now,
		});
		expect(unpaidDecision).toMatchObject({
			allowed: false,
			code: "payment_required",
		});
	});

	it("keeps an internal metered account independent of Stripe environment", async () => {
		const { db, sqlite, now } = setup();
		sqlite
			.prepare(
				"UPDATE billing_accounts SET billing_mode='internal', stripe_environment='test' WHERE organization_id='org-1'",
			)
			.run();

		const decision = await reserveBillingUsage(db, {
			id: "reservation-internal-cross-environment",
			organizationId: "org-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 1_001,
			estimatedOutputTokens: 1,
			idempotencyKey: "reserve:internal-cross-environment",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
			stripeEnvironment: "live",
		});

		expect(decision).toMatchObject({ allowed: true });
		expect(
			sqlite
				.prepare(
					"SELECT stripe_environment AS environment, stripe_customer_id AS customer FROM billing_accounts WHERE organization_id='org-1'",
				)
				.get(),
		).toEqual({ environment: "test", customer: "cus_1" });
	});

	it("enforces a hard customer-spend ceiling before provider inference", async () => {
		const { db, sqlite, now } = setup();
		sqlite
			.prepare(
				"UPDATE billing_accounts SET hard_spend_limit_micros=50000 WHERE organization_id='org-1'",
			)
			.run();
		const first = await reserveBillingUsage(db, {
			id: "reservation-cap-1",
			organizationId: "org-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 1_001,
			estimatedOutputTokens: 0,
			idempotencyKey: "reserve:cap:1",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
		});
		expect(first.allowed).toBe(true);
		const second = await reserveBillingUsage(db, {
			id: "reservation-cap-2",
			organizationId: "org-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 1,
			estimatedOutputTokens: 1_000,
			idempotencyKey: "reserve:cap:2",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
		});
		expect(second).toMatchObject({
			allowed: false,
			code: "hard_spend_limit",
		});
	});

	it("enforces D1 daily AI Gateway limits without masking unrelated billing denials", async () => {
		const limited = setup();
		const limitedDecision = await reserveBillingUsage(limited.db, {
			id: "reservation-ai-limit",
			organizationId: "org-1",
			tediId: "tedi-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 600,
			estimatedOutputTokens: 400,
			idempotencyKey: "reserve:ai-limit",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now: limited.now,
			aiGatewayLimits: { tediDailyTokenLimit: 900 },
		});
		expect(limitedDecision).toMatchObject({
			allowed: false,
			code: "inference_capacity_exhausted",
		});

		const unpaid = setup();
		unpaid.sqlite
			.prepare(
				"UPDATE billing_accounts SET billing_mode='trial' WHERE organization_id='org-1'",
			)
			.run();
		unpaid.sqlite
			.prepare(
				"UPDATE billing_accounts SET stripe_customer_id=NULL WHERE organization_id='org-1'",
			)
			.run();
		const paymentDecision = await reserveBillingUsage(unpaid.db, {
			id: "reservation-payment-with-ai-policy",
			organizationId: "org-1",
			tediId: "tedi-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 1_001,
			estimatedOutputTokens: 1,
			idempotencyKey: "reserve:payment-with-ai-policy",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now: unpaid.now,
			aiGatewayLimits: { tediDailyTokenLimit: 100_000 },
		});
		expect(paymentDecision).toMatchObject({
			allowed: false,
			code: "payment_required",
		});
	});

	it("resolves the environment-scoped inference capacity pack catalog", async () => {
		const { db, now } = setup();
		const packs = await listActiveInferenceCapacityPacks(db, {
			stripeEnvironment: "test",
			now,
		});
		expect(packs).toHaveLength(1);
		expect(packs[0]).toMatchObject({
			packKey: "daily_5m",
			tokenAmount: 5_000_000,
			spendAmountMicros: 25_000_000,
		});
		expect(
			await getActiveInferenceCapacityPackByKey(db, {
				packKey: "daily_5m",
				stripeEnvironment: "live",
				now,
			}),
		).toBeNull();
	});

	it("unblocks exhausted inference only after an idempotent same-day Stripe allocation", async () => {
		const { db, sqlite, now } = setup();
		// Trial accounts retain finite daily capacity and pack history.
		sqlite.exec("UPDATE billing_accounts SET status='trial'");
		sqlite
			.prepare(`
			INSERT INTO billing_inference_capacity_pack_versions (
				id, pack_key, version, status, name, currency, price_micros,
				token_amount, spend_amount_micros, stripe_environment,
				stripe_lookup_key, effective_at, created_at
			) VALUES (?, ?, 1, 'active', ?, 'usd', ?, ?, ?, 'live', ?, ?, ?)
		`)
			.run(
				"capacity-pack-daily-5m-live-v1",
				"daily_5m",
				"5M daily boost",
				25_000_000,
				5_000_000,
				25_000_000,
				"tedix_inference_capacity_daily_5m_v1",
				now,
				now,
			);
		const exhausted = await reserveBillingUsage(db, {
			id: "reservation-before-capacity-grant",
			organizationId: "org-1",
			tediId: "tedi-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 600,
			estimatedOutputTokens: 400,
			idempotencyKey: "reserve:before-capacity-grant",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
			stripeEnvironment: "live",
			aiGatewayLimits: {
				organizationDailyTokenLimit: 900,
				organizationDailySpendLimitMicros: 0,
				tediDailyTokenLimit: 1_000,
			},
		});
		expect(exhausted).toMatchObject({
			allowed: false,
			code: "inference_capacity_exhausted",
		});

		const grant = await recordCapacityAllocation(db, {
			id: "capacity-grant-1",
			organizationId: "org-1",
			packVersionId: "capacity-pack-daily-5m-live-v1",
			budgetDay: "2026-07-27",
			tokenAmount: 5_000_000,
			spendAmountMicros: 25_000_000,
			sourceType: "stripe_checkout",
			sourceRef: "cs_capacity_1",
			idempotencyKey: "stripe-capacity:live:cs_capacity_1",
			stripeEnvironment: "live",
			expiresAt: "2026-07-28T00:00:00.000Z",
			createdAt: now,
		});
		expect(grant.tokenAmount).toBe(5_000_000);
		const duplicate = await recordCapacityAllocation(db, {
			...grant,
			id: "capacity-grant-racing-duplicate",
			createdAt: now,
		});
		expect(duplicate.id).toBe("capacity-grant-1");

		const admitted = await reserveBillingUsage(db, {
			id: "reservation-capacity-grant",
			organizationId: "org-1",
			tediId: "tedi-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 600,
			estimatedOutputTokens: 400,
			idempotencyKey: "reserve:capacity-grant",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
			stripeEnvironment: "live",
			aiGatewayLimits: {
				organizationDailyTokenLimit: 900,
				organizationDailySpendLimitMicros: 0,
				tediDailyTokenLimit: 1_000,
			},
		});
		expect(admitted.allowed).toBe(true);
		await settleBillingUsage(db, {
			id: "charge-capacity-grant",
			organizationId: "org-1",
			tediId: "tedi-1",
			reservationId: "reservation-capacity-grant",
			gatewayLogId: "gateway-capacity-grant",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			source: "operator",
			inputTokens: 600,
			outputTokens: 400,
			providerCostMicros: 1_234,
			usageQuality: "gateway_reported",
			providerCostQuality: "gateway_reported",
			meteringReady: false,
			occurredAt: now,
			now,
		});
		const overview = await getInferenceCapacityDailyOverview(db, {
			organizationId: "org-1",
			stripeEnvironment: "live",
			now,
		});
		expect(overview).toEqual({
			budgetDay: "2026-07-27",
			usedTokens: 1_000,
			usedSpendMicros: 1_234,
			allocatedTokens: 5_000_000,
			allocatedSpendMicros: 25_000_000,
			// A Stripe capacity purchase, not a sponsorship transfer.
			sponsoredTokens: 0,
			sponsoredSpendMicros: 0,
			earliestExpiryAt: "2026-07-28T00:00:00.000Z",
		});
		const providerSpendLimited = await reserveBillingUsage(db, {
			id: "reservation-provider-spend-limit",
			organizationId: "org-1",
			tediId: "tedi-2",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 1,
			estimatedOutputTokens: 1,
			idempotencyKey: "reserve:provider-spend-limit",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
			stripeEnvironment: "test",
			aiGatewayLimits: {
				organizationDailyTokenLimit: 10_000,
				organizationDailySpendLimitMicros: 1_000,
			},
		});
		expect(providerSpendLimited).toMatchObject({
			allowed: false,
			code: "inference_capacity_exhausted",
		});

		const tediCapacityOverflow = await reserveBillingUsage(db, {
			id: "reservation-capacity-tedi-limit",
			organizationId: "org-1",
			tediId: "tedi-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 1,
			estimatedOutputTokens: 1,
			idempotencyKey: "reserve:capacity-tedi-limit",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
			stripeEnvironment: "live",
			aiGatewayLimits: {
				organizationDailyTokenLimit: 900,
				tediDailyTokenLimit: 1_000,
			},
		});
		expect(tediCapacityOverflow).toMatchObject({ allowed: true });

		const afterExpiry = "2026-07-28T00:00:00.000Z";
		await expect(
			getInferenceCapacityDailyOverview(db, {
				organizationId: "org-1",
				stripeEnvironment: "live",
				now: afterExpiry,
			}),
		).resolves.toMatchObject({
			budgetDay: "2026-07-28",
			allocatedTokens: 0,
			allocatedSpendMicros: 0,
			earliestExpiryAt: null,
		});
		const expiredCapacity = await reserveBillingUsage(db, {
			id: "reservation-expired-capacity",
			organizationId: "org-1",
			tediId: "tedi-2",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 1,
			estimatedOutputTokens: 0,
			idempotencyKey: "reserve:expired-capacity",
			expiresAt: "2026-07-28T00:10:00.000Z",
			now: afterExpiry,
			stripeEnvironment: "live",
			aiGatewayLimits: {
				organizationDailyTokenLimit: 0,
				organizationDailySpendLimitMicros: 0,
			},
		});
		expect(expiredCapacity).toMatchObject({
			allowed: false,
			code: "inference_capacity_exhausted",
		});
	});

	it("atomically transfers recurring sponsored capacity and refuses an overdraw", async () => {
		const { db, sqlite, now } = setup();
		insertReservation(sqlite, { id: "provider-base-usage", now });
		sqlite
			.prepare(
				`UPDATE billing_usage_reservations
				 SET estimated_input_tokens = 2500, estimated_output_tokens = 2500
				 WHERE id = 'provider-base-usage'`,
			)
			.run();
		sqlite.prepare(`INSERT INTO organizations (id) VALUES (?)`).run("org-2");
		sqlite
			.prepare(
				`INSERT INTO billing_accounts (
					organization_id, plan_version_id, status, billing_mode,
					stripe_environment, period_start, period_end, created_at, updated_at
				) VALUES ('org-2','growth-v1','active','manual','live',?,?,?,?)`,
			)
			.run("2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z", now, now);
		const input = {
			transferId: "installation-1:2026-07-27",
			sponsorOrganizationId: "org-1",
			customerOrganizationId: "org-2",
			providerInstallationId: "installation-1",
			budgetRevision: 1,
			budgetDay: "2026-07-27",
			tokenAmount: 4_000,
			spendAmountMicros: 20_000,
			customerLowWatermarkTokens: 1_000,
			customerLowWatermarkSpendMicros: 5_000,
			sponsorDailyTokenLimit: 10_000,
			sponsorDailySpendLimitMicros: 50_000,
			stripeEnvironment: "live" as const,
			expiresAt: "2026-07-28T00:00:00.000Z",
			createdAt: now,
		};
		const first = await transferSponsoredCapacity(db, input);
		const retry = await transferSponsoredCapacity(db, input);
		expect(retry.sponsorAllocation.id).toBe(first.sponsorAllocation.id);
		expect(retry.customerAllocation.id).toBe(first.customerAllocation.id);
		const providerAfterTransfer = await reserveBillingUsage(db, {
			id: "provider-after-sponsored-transfer",
			organizationId: "org-1",
			source: "operator",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			estimatedInputTokens: 1_001,
			estimatedOutputTokens: 0,
			idempotencyKey: "reserve:provider-after-sponsored-transfer",
			expiresAt: "2026-07-27T12:10:00.000Z",
			now,
			stripeEnvironment: "live",
			aiGatewayLimits: { organizationDailyTokenLimit: 10_000 },
		});
		// The funded provider's own inference is monthly-metered; the next
		// sponsorship transfer is still bounded by its finite daily grant.
		expect(providerAfterTransfer).toMatchObject({ allowed: true });
		expect(
			await getInferenceCapacityDailyOverview(db, {
				organizationId: "org-1",
				stripeEnvironment: "live",
				now,
			}),
		).toMatchObject({
			allocatedTokens: -4_000,
			allocatedSpendMicros: -20_000,
		});
		expect(
			await getInferenceCapacityDailyOverview(db, {
				organizationId: "org-2",
				stripeEnvironment: "live",
				now,
			}),
		).toMatchObject({ allocatedTokens: 4_000, allocatedSpendMicros: 20_000 });
		await expect(
			transferSponsoredCapacity(db, {
				...input,
				transferId: "installation-concurrent:2026-07-27",
			}),
		).rejects.toThrow(/insufficient active inference capacity/);
		await expect(
			transferSponsoredCapacity(db, {
				...input,
				transferId: "installation-2:2026-07-27",
				tokenAmount: 7_000,
				customerLowWatermarkTokens: 10_000,
			}),
		).rejects.toThrow(/insufficient active inference capacity/);
		const partial = sqlite
			.prepare(
				`SELECT COUNT(*) AS count FROM billing_capacity_allocations WHERE source_ref = ?`,
			)
			.get("installation-2:2026-07-27") as { count: number };
		expect(partial.count).toBe(0);
	});

	it("creates exactly one durable Stripe event for uncovered overage", async () => {
		const { db, sqlite, now } = setup();
		insertReservation(sqlite, { id: "reservation-stripe", now });
		const charge = await settleBillingUsage(db, {
			id: "charge-stripe",
			organizationId: "org-1",
			reservationId: "reservation-stripe",
			gatewayLogId: "gateway-stripe",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			source: "operator",
			inputTokens: 1_500,
			outputTokens: 500,
			providerCostMicros: 2_000,
			usageQuality: "gateway_reported",
			providerCostQuality: "estimated",
			meteringReady: true,
			occurredAt: now,
			now,
		});
		expect(charge.customerChargeMicros).toBe(50_000);
		expect(charge.meteredOverageTokens).toBe(1_000);
		expect(
			sqlite
				.prepare(
					"SELECT quantity, status FROM stripe_meter_outbox WHERE usage_charge_id='charge-stripe'",
				)
				.get(),
		).toEqual({ quantity: 1_000, status: "pending" });

		await settleBillingUsage(db, {
			id: "charge-stripe-duplicate",
			organizationId: "org-1",
			reservationId: "reservation-stripe",
			gatewayLogId: "gateway-stripe",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			source: "operator",
			inputTokens: 1_500,
			outputTokens: 500,
			providerCostMicros: 2_000,
			usageQuality: "gateway_reported",
			providerCostQuality: "estimated",
			meteringReady: true,
			occurredAt: now,
			now,
		});
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM stripe_meter_outbox").get(),
		).toEqual({
			count: 1,
		});
	});

	it("rounds customer units across the period, not once per inference", async () => {
		const { db, sqlite, now } = setup();
		insertReservation(sqlite, { id: "reservation-small-1", now });
		insertReservation(sqlite, { id: "reservation-small-2", now });
		const first = await settleBillingUsage(db, {
			id: "charge-small-1",
			organizationId: "org-1",
			reservationId: "reservation-small-1",
			gatewayLogId: "gateway-small-1",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			source: "operator",
			inputTokens: 1_001,
			outputTokens: 0,
			providerCostMicros: 100,
			usageQuality: "gateway_reported",
			providerCostQuality: "estimated",
			meteringReady: true,
			occurredAt: now,
			now,
		});
		const second = await settleBillingUsage(db, {
			id: "charge-small-2",
			organizationId: "org-1",
			reservationId: "reservation-small-2",
			gatewayLogId: "gateway-small-2",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			source: "operator",
			inputTokens: 999,
			outputTokens: 0,
			providerCostMicros: 100,
			usageQuality: "gateway_reported",
			providerCostQuality: "estimated",
			meteringReady: true,
			occurredAt: now,
			now,
		});
		expect(first.customerChargeMicros).toBe(50_000);
		expect(second.customerChargeMicros).toBe(0);
		expect(first.meteredOverageTokens).toBe(1);
		expect(second.meteredOverageTokens).toBe(999);
		expect(
			sqlite
				.prepare("SELECT SUM(quantity) AS quantity FROM stripe_meter_outbox")
				.get(),
		).toEqual({ quantity: 1_000 });
		expect(
			sqlite
				.prepare(
					"SELECT customer_charge_micros AS charge, metered_overage_tokens AS tokens FROM billing_usage_periods",
				)
				.get(),
		).toEqual({ charge: 50_000, tokens: 1_000 });
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

	it("settles a matching successful usage row after its reservation TTL expired", async () => {
		const { db, sqlite, now } = setup();
		insertReservation(sqlite, {
			id: "reservation-expired",
			status: "expired",
			now,
		});
		const charge = await settleBillingUsage(db, {
			id: "charge-expired",
			organizationId: "org-1",
			reservationId: "reservation-expired",
			gatewayLogId: "gateway-expired",
			provider: "azure-openai",
			model: "gpt-5.6-terra",
			source: "automation",
			inputTokens: 100,
			outputTokens: 10,
			providerCostMicros: 200,
			usageQuality: "gateway_reported",
			providerCostQuality: "estimated",
			meteringReady: true,
			occurredAt: now,
			now,
		});
		expect(charge.id).toBe("charge-expired");
		expect(
			sqlite
				.prepare(
					"SELECT status, settled_at AS settledAt FROM billing_usage_reservations WHERE id='reservation-expired'",
				)
				.get(),
		).toEqual({ status: "settled", settledAt: now });
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
				"billing_credit_entries",
				"stripe_meter_outbox",
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

	it("rolls back every financial write when one D1 batch statement fails", async () => {
		const { db, sqlite, now } = setup();
		insertReservation(sqlite, { id: "reservation-rollback", now });
		await grantBillingCredit(db, {
			id: "credit-rollback",
			organizationId: "org-1",
			amountMicros: 50_000,
			sourceType: "test",
			idempotencyKey: "credit:rollback",
			createdAt: now,
		});
		sqlite.exec(`
			CREATE TRIGGER reject_test_charge
			BEFORE INSERT ON billing_usage_charges
			WHEN NEW.id = 'charge-rollback'
			BEGIN
				SELECT RAISE(ABORT, 'forced charge failure');
			END;
		`);

		await expect(
			settleBillingUsage(db, {
				id: "charge-rollback",
				organizationId: "org-1",
				reservationId: "reservation-rollback",
				gatewayLogId: "gateway-rollback",
				provider: "azure-openai",
				model: "gpt-5.6-terra",
				source: "operator",
				inputTokens: 1_500,
				outputTokens: 500,
				providerCostMicros: 2_000,
				usageQuality: "gateway_reported",
				providerCostQuality: "estimated",
				meteringReady: true,
				occurredAt: now,
				now,
			}),
		).rejects.toThrow("forced charge failure");

		expect(
			sqlite
				.prepare(
					`SELECT used_input_tokens AS input, used_output_tokens AS output,
						settlement_version AS version
					 FROM billing_usage_periods`,
				)
				.get(),
		).toEqual({ input: 0, output: 0, version: 0 });
		expect(
			sqlite
				.prepare(
					"SELECT status FROM billing_usage_reservations WHERE id='reservation-rollback'",
				)
				.get(),
		).toEqual({ status: "reserved" });
		expect(
			sqlite
				.prepare(
					"SELECT credit_balance_micros AS balance FROM billing_accounts WHERE organization_id='org-1'",
				)
				.get(),
		).toEqual({ balance: 50_000 });
		expect(
			sqlite.prepare("SELECT COUNT(*) AS count FROM stripe_meter_outbox").get(),
		).toEqual({
			count: 0,
		});
	});

	it("retries a stale period pre-read without inserting an unaccounted charge", async () => {
		const { db, sqlite, now } = setup();
		insertReservation(sqlite, { id: "reservation-race-1", now });
		insertReservation(sqlite, { id: "reservation-race-2", now });

		const [first, second] = await Promise.all([
			settleBillingUsage(db, {
				id: "charge-race-1",
				organizationId: "org-1",
				reservationId: "reservation-race-1",
				gatewayLogId: "gateway-race-1",
				provider: "azure-openai",
				model: "gpt-5.6-terra",
				source: "operator",
				inputTokens: 600,
				outputTokens: 0,
				providerCostMicros: 100,
				usageQuality: "gateway_reported",
				providerCostQuality: "estimated",
				meteringReady: true,
				occurredAt: now,
				now,
			}),
			settleBillingUsage(db, {
				id: "charge-race-2",
				organizationId: "org-1",
				reservationId: "reservation-race-2",
				gatewayLogId: "gateway-race-2",
				provider: "azure-openai",
				model: "gpt-5.6-terra",
				source: "operator",
				inputTokens: 600,
				outputTokens: 0,
				providerCostMicros: 100,
				usageQuality: "gateway_reported",
				providerCostQuality: "estimated",
				meteringReady: true,
				occurredAt: now,
				now,
			}),
		]);

		expect(new Set([first.id, second.id])).toEqual(
			new Set(["charge-race-1", "charge-race-2"]),
		);
		expect(
			sqlite
				.prepare(
					`SELECT used_input_tokens AS input, provider_cost_micros AS cost,
						settlement_version AS version
					 FROM billing_usage_periods`,
				)
				.get(),
		).toEqual({ input: 1_200, cost: 200, version: 2 });
		expect(
			sqlite
				.prepare("SELECT COUNT(*) AS count FROM billing_usage_charges")
				.get(),
		).toEqual({
			count: 2,
		});
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
		const lease = "2026-07-27T12:05:00.000Z";
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
			eventId: "evt-old",
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
		await markStripeWebhookEventProcessed(db, {
			eventId: "evt-old",
			outcome: "applied",
			now,
		});

		await claimStripeWebhookEvent(db, {
			eventId: "evt-new",
			eventType: "customer.subscription.deleted",
			entityKey: "sub-1",
			eventCreatedAt: 200,
			now,
			leaseExpiresAt: lease,
		});
		await markStripeWebhookEventProcessed(db, {
			eventId: "evt-new",
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
});

describe("billing credit journal on real D1 semantics", () => {
	it("replays a grant idempotently without interactive transactions", async () => {
		const { db, now } = setup();
		const first = await grantBillingCredit(db, {
			id: "credit-a",
			organizationId: "org-1",
			amountMicros: 30_000,
			sourceType: "promotion",
			idempotencyKey: "promo:replay",
			createdAt: now,
		});
		const replay = await grantBillingCredit(db, {
			id: "credit-a-dup",
			organizationId: "org-1",
			amountMicros: 30_000,
			sourceType: "promotion",
			idempotencyKey: "promo:replay",
			createdAt: now,
		});
		// The unique idempotency index keeps the first journal row; the replay
		// returns it instead of double-granting.
		expect(replay.id).toBe(first.id);
	});

	it("expires a grant via one atomic compensating adjustment", async () => {
		const { db, sqlite, now } = setup();
		await grantBillingCredit(db, {
			id: "credit-exp",
			organizationId: "org-1",
			amountMicros: 30_000,
			sourceType: "promotion",
			idempotencyKey: "promo:expiring",
			expiresAt: "2026-01-01T00:00:00.000Z",
			createdAt: now,
		});
		const expired = await expireBillingCredits(db, now);
		expect(expired).toBe(1);
		const account = sqlite
			.prepare(
				"SELECT credit_balance_micros AS balance FROM billing_accounts WHERE organization_id = 'org-1'",
			)
			.get() as { balance: number };
		expect(account.balance).toBe(0);
		const adjustment = sqlite
			.prepare(
				"SELECT kind, amount_micros AS amount, source_ref AS ref FROM billing_credit_entries WHERE idempotency_key = 'credit-expiry:credit-exp'",
			)
			.get() as { kind: string; amount: number; ref: string };
		expect(adjustment).toMatchObject({
			kind: "adjustment",
			amount: -30_000,
			ref: "credit-exp",
		});
		// Re-running is a no-op: the expiry idempotency key already exists.
		expect(await expireBillingCredits(db, now)).toBe(0);
	});

	it("expires only up to the remaining balance after partial consumption", async () => {
		const { db, sqlite, now } = setup();
		await grantBillingCredit(db, {
			id: "credit-partial",
			organizationId: "org-1",
			amountMicros: 50_000,
			sourceType: "promotion",
			idempotencyKey: "promo:partial",
			expiresAt: "2026-01-01T00:00:00.000Z",
			createdAt: now,
		});
		// Simulate consumption of most of the balance before expiry runs.
		sqlite
			.prepare(
				"INSERT INTO billing_credit_entries (id, organization_id, kind, amount_micros, source_type, idempotency_key, metadata, created_at) VALUES ('debit-1', 'org-1', 'usage_debit', -45000, 'usage', 'debit:1', '{}', ?)",
			)
			.run(now);
		expect(await expireBillingCredits(db, now)).toBe(1);
		const account = sqlite
			.prepare(
				"SELECT credit_balance_micros AS balance FROM billing_accounts WHERE organization_id = 'org-1'",
			)
			.get() as { balance: number };
		// Only the remaining 5,000 micros can expire — never negative.
		expect(account.balance).toBe(0);
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
				`INSERT INTO stripe_meter_outbox (
					id, organization_id, usage_charge_id, stripe_customer_id,
					stripe_environment, event_name,
					quantity, idempotency_key, status, attempt_count, next_attempt_at,
					created_at, updated_at
				) VALUES ('outbox-1', 'org-1', 'charge-x', 'cus_1', ?, 'token_usage',
					1000, 'meter:charge-x', 'pending', ?, ?, ?, ?)`,
			)
			.run(stripeEnvironment, attemptCount, now, now, now);
	}

	function outboxRow(sqlite: DatabaseSync) {
		return sqlite
			.prepare(
				"SELECT status, attempt_count AS attempts FROM stripe_meter_outbox WHERE id = 'outbox-1'",
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
