import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import {
	getBillingServiceCreditSnapshot,
	reserveBillingServiceCredits,
	setBillingServiceCreditControls,
	settleBillingServiceCreditUsage,
} from "./billing-service-credits";

const NOW = "2026-07-30T02:30:00.000Z";
const PERIOD_START = "2026-07-01T00:00:00.000Z";
const PERIOD_END = "2026-08-01T00:00:00.000Z";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE organizations (
			id TEXT PRIMARY KEY
		);
		CREATE TABLE tedis (
			id TEXT PRIMARY KEY,
			organization_id TEXT NOT NULL
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
			stripe_environment TEXT,
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
		CREATE TABLE billing_provider_usage (
			id TEXT PRIMARY KEY,
			organization_id TEXT,
			tedi_id TEXT,
			reservation_id TEXT,
			gateway_log_id TEXT,
			provider_usage_id TEXT,
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
		CREATE UNIQUE INDEX uniq_billing_provider_usage_gateway_log
			ON billing_provider_usage (gateway_log_id)
			WHERE gateway_log_id IS NOT NULL;
		CREATE UNIQUE INDEX uniq_billing_provider_usage_provider_id
			ON billing_provider_usage (provider_usage_id)
			WHERE provider_usage_id IS NOT NULL;
		INSERT INTO billing_plan_versions VALUES (
			'growth-v2', 'growth', 2, 'active', 'Growth', 'usd',
			249000000, 2399000000, 500000, 0, 1000, 50000,
			1, 10, 16, 250000, 200, 1,
			'{}', '2026-07-27T00:00:00.000Z', '${NOW}'
		);
	`);
	const migration = readFileSync(
		new URL(
			"../../drizzle/20260730020216_managed_seo_credits/migration.sql",
			import.meta.url,
		),
		"utf8",
	);
	sqlite.exec(migration);
	sqlite.exec(`
		INSERT INTO organizations (id) VALUES ('org-1');
		INSERT INTO tedis (id, organization_id) VALUES ('tedi-1', 'org-1');
		INSERT INTO billing_accounts (
			organization_id, plan_version_id, status, billing_mode,
			period_start, period_end, created_at, updated_at
		) VALUES (
			'org-1', 'growth-v2', 'active', 'stripe',
			'${PERIOD_START}', '${PERIOD_END}', '${NOW}', '${NOW}'
		);
	`);
	return {
		sqlite,
		db: createDbClient(createD1Facade(sqlite)),
	};
}

async function reserve(
	db: ReturnType<typeof createDbClient>,
	overrides: Partial<Parameters<typeof reserveBillingServiceCredits>[1]> = {},
) {
	return reserveBillingServiceCredits(db, {
		id: "reservation-1",
		organizationId: "org-1",
		tediId: "tedi-1",
		serviceKey: "seo",
		operationKey: "research_keywords",
		idempotencyKey: "seo-request-123",
		expiresAt: "2026-07-30T02:40:00.000Z",
		now: NOW,
		...overrides,
	});
}

describe("managed service credits", () => {
	it("atomically grants the plan allowance and reserves a versioned rate", async () => {
		const { db, sqlite } = setup();
		const before = await getBillingServiceCreditSnapshot(
			db,
			"org-1",
			"seo",
			NOW,
		);
		expect(before).toMatchObject({
			includedCredits: 500,
			grantedCredits: 500,
			availableCredits: 500,
		});

		const first = await reserve(db);
		const replay = await reserve(db, { id: "reservation-replay" });

		expect(first.allowed).toBe(true);
		expect(replay.allowed).toBe(true);
		if (!first.allowed || !replay.allowed) return;
		expect(first.replayed).toBe(false);
		expect(replay.replayed).toBe(true);
		expect(first.reservation).toMatchObject({
			id: "reservation-1",
			planVersionId: "growth-v2",
			rateCardId: "seo-research-keywords-v1",
			creditsReserved: 4,
			customerValueMicros: 40_000,
		});
		expect(replay.reservation.id).toBe(first.reservation.id);
		expect(
			sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM billing_service_credit_entries WHERE kind = 'grant'",
				)
				.get(),
		).toEqual({ count: 1 });
		expect(first.snapshot).toMatchObject({
			includedCredits: 500,
			reservedCredits: 4,
			availableCredits: 496,
		});
	});

	it("settles successful provider usage into one debit and metering-ready receipt", async () => {
		const { db, sqlite } = setup();
		const decision = await reserve(db);
		if (!decision.allowed) throw new Error(decision.code);

		const settled = await settleBillingServiceCreditUsage(db, {
			id: "usage-1",
			reservationId: decision.reservation.id,
			organizationId: "org-1",
			tediId: "tedi-1",
			providerUsageId: "dataforseo:task-1",
			provider: "dataforseo",
			model: "/v3/dataforseo_labs/google/keyword_suggestions/live",
			providerCostMicros: 12_500,
			providerCostQuality: "provider_reported",
			providerSucceeded: true,
			occurredAt: NOW,
			now: NOW,
		});
		await settleBillingServiceCreditUsage(db, {
			id: "usage-replay",
			reservationId: decision.reservation.id,
			organizationId: "org-1",
			tediId: "tedi-1",
			providerUsageId: "dataforseo:task-1",
			provider: "dataforseo",
			model: "/v3/dataforseo_labs/google/keyword_suggestions/live",
			providerCostMicros: 12_500,
			providerCostQuality: "provider_reported",
			providerSucceeded: true,
			occurredAt: NOW,
			now: NOW,
		});

		expect(settled.status).toBe("settled");
		expect(
			sqlite
				.prepare(
					"SELECT amount_credits AS amountCredits FROM billing_service_credit_entries WHERE kind = 'debit'",
				)
				.all(),
		).toEqual([{ amountCredits: -4 }]);
		expect(
			sqlite
				.prepare(
					"SELECT customer_metering_ready AS ready FROM billing_provider_usage",
				)
				.get(),
		).toEqual({ ready: 1 });
		const snapshot = await getBillingServiceCreditSnapshot(
			db,
			"org-1",
			"seo",
			NOW,
		);
		expect(snapshot).toMatchObject({
			usedCredits: 4,
			reservedCredits: 0,
			availableCredits: 496,
			providerCostMicros: 12_500,
		});
	});

	it("releases credits and records cost-only evidence when the provider fails", async () => {
		const { db, sqlite } = setup();
		const decision = await reserve(db);
		if (!decision.allowed) throw new Error(decision.code);

		const released = await settleBillingServiceCreditUsage(db, {
			id: "usage-failed",
			reservationId: decision.reservation.id,
			organizationId: "org-1",
			tediId: "tedi-1",
			providerUsageId: "dataforseo:task-failed",
			provider: "dataforseo",
			model: "/v3/dataforseo_labs/google/keyword_suggestions/live",
			providerCostMicros: 12_000,
			providerCostQuality: "provider_reported",
			providerSucceeded: false,
			occurredAt: NOW,
			now: NOW,
		});

		expect(released).toMatchObject({
			status: "released",
			rejectionCode: "provider_failed",
		});
		expect(
			sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM billing_service_credit_entries WHERE kind = 'debit'",
				)
				.get(),
		).toEqual({ count: 0 });
		expect(
			sqlite
				.prepare(
					"SELECT customer_metering_ready AS ready FROM billing_provider_usage",
				)
				.get(),
		).toEqual({ ready: 0 });
	});

	it("does not settle credits against a provider receipt owned by another reservation", async () => {
		const { db, sqlite } = setup();
		const first = await reserve(db);
		if (!first.allowed) throw new Error(first.code);
		await settleBillingServiceCreditUsage(db, {
			id: "usage-failed",
			reservationId: first.reservation.id,
			organizationId: "org-1",
			tediId: "tedi-1",
			providerUsageId: "dataforseo:task-collision",
			provider: "dataforseo",
			model: "/v3/dataforseo_labs/google/keyword_suggestions/live",
			providerCostMicros: 12_000,
			providerCostQuality: "provider_reported",
			providerSucceeded: false,
			occurredAt: NOW,
			now: NOW,
		});

		const second = await reserve(db, {
			id: "reservation-2",
			idempotencyKey: "seo-request-456",
		});
		if (!second.allowed) throw new Error(second.code);
		await expect(
			settleBillingServiceCreditUsage(db, {
				id: "usage-collision",
				reservationId: second.reservation.id,
				organizationId: "org-1",
				tediId: "tedi-1",
				providerUsageId: "dataforseo:task-collision",
				provider: "dataforseo",
				model: "/v3/dataforseo_labs/google/keyword_suggestions/live",
				providerCostMicros: 12_000,
				providerCostQuality: "provider_reported",
				providerSucceeded: true,
				occurredAt: NOW,
				now: NOW,
			}),
		).rejects.toThrow("Failed to settle managed service credits");
		expect(
			sqlite
				.prepare(
					"SELECT status FROM billing_service_credit_reservations WHERE id = 'reservation-2'",
				)
				.get(),
		).toEqual({ status: "reserved" });
		expect(
			sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM billing_service_credit_entries WHERE kind = 'debit'",
				)
				.get(),
		).toEqual({ count: 0 });
	});

	it("fails closed on tenant controls before provider spend", async () => {
		const { db } = setup();
		await setBillingServiceCreditControls(db, {
			organizationId: "org-1",
			serviceKey: "seo",
			enabled: true,
			monthlyCreditLimit: 3,
			updatedBy: "owner-1",
			now: NOW,
		});
		const limited = await reserve(db);
		expect(limited).toMatchObject({
			allowed: false,
			code: "monthly_credit_limit",
		});

		await setBillingServiceCreditControls(db, {
			organizationId: "org-1",
			serviceKey: "seo",
			enabled: false,
			updatedBy: "owner-1",
			now: NOW,
		});
		const disabled = await reserve(db, {
			id: "reservation-2",
			idempotencyKey: "seo-request-456",
		});
		expect(disabled).toMatchObject({
			allowed: false,
			code: "service_disabled",
		});
	});
});
