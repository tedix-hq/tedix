import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { coreTable } from "../core-store/client";
import type { DbClient } from "../client";
import { organizations } from "../schema/organizations";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
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
	billingProviderUsage,
	billingServiceCreditControls,
	billingServiceCreditReservations,
	billingServiceRateCards,
	billingUsageReservations,
} from "../schema/billing";
import { createD1Facade } from "../test/d1-facade";
import { tableDdl } from "../test/schema-ddl";
import { getCreditPoolSnapshot } from "./billing/credit-pool";
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
	`);
	for (const table of [
		billingPlanVersions,
		billingAccounts,
		billingProviderUsage,
		billingServiceRateCards,
		billingServiceCreditControls,
		billingServiceCreditReservations,
		billingUsageReservations,
		billingCreditTopUps,
		billingCreditConsumptions,
		billingCreditUsageTotals,
		billingCreditCaps,
		billingCreditNotices,
		billingCreditMeterOutbox,
	]) {
		for (const statement of tableDdl(table)) sqlite.exec(statement);
	}
	sqlite.exec(`
		INSERT INTO billing_plan_versions (
			id, plan_key, version, status, name, currency, monthly_price_micros,
			annual_price_micros, max_tedis, max_cron_jobs_per_tedi,
			max_iterations_per_task, allow_overage, included_monthly_credits,
			metadata, effective_at, created_at
		) VALUES (
			'growth-v2', 'growth', 2, 'active', 'Growth', 'eur', 200000000,
			2000000000, 1, 10, 16, 1, 10, '{}', '2026-07-27T00:00:00.000Z', '${NOW}'
		);
		INSERT INTO billing_service_rate_cards (
			id, service_key, operation_key, version, status, provider,
			provider_endpoint, credit_cost, customer_value_micros,
			provider_cost_ceiling_micros, effective_at, metadata, created_at
		) VALUES (
			'seo-research-keywords-v1', 'seo', 'research_keywords', 1, 'active',
			'dataforseo', '/v3/dataforseo_labs/google/keyword_suggestions/live',
			4, 10000, 30000, '2026-07-30T00:00:00.000Z', '{}', '${NOW}'
		);
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
	it("reserves a versioned rate against the shared credit pool", async () => {
		const { db } = setup();
		const before = await getBillingServiceCreditSnapshot(
			db,
			"org-1",
			"seo",
			NOW,
		);
		expect(before).toMatchObject({ usedCredits: 0, availableCredits: 10 });

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
		expect(first.snapshot).toMatchObject({
			reservedCredits: 4,
			availableCredits: 6,
		});
		// 4 + 4 fits the 10-credit pool; a third reservation does not.
		await reserve(db, { id: "reservation-2", idempotencyKey: "seo-2" });
		expect(
			await reserve(db, { id: "reservation-3", idempotencyKey: "seo-3" }),
		).toMatchObject({ allowed: false, code: "monthly_credit_limit_reached" });
	});

	it("settles successful provider usage into one pool draw and metering-ready receipt", async () => {
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
				.prepare("SELECT kind, credits FROM billing_credit_consumptions")
				.all(),
		).toEqual([{ kind: "service", credits: 4 }]);
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
			availableCredits: 6,
			providerCostMicros: 12_500,
		});
		expect(
			(await getCreditPoolSnapshot(db, { organizationId: "org-1", now: NOW }))
				?.breakdown,
		).toEqual({ ai: 0, codeRuns: 0, services: 4 });
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
				.prepare("SELECT COUNT(*) AS count FROM billing_credit_consumptions")
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
				.prepare("SELECT COUNT(*) AS count FROM billing_credit_consumptions")
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
			code: "service_monthly_credit_limit",
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

for (const store of ["d1", "postgres"] as const)
	describe(`service credits on ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "postgres") {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			} else {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
				close = () => sqlite.close();
			}
			await db
				.insert(coreTable(db, organizations))
				.values({ id: "org-1", name: "Example", slug: "example" });
			await db.insert(coreTable(db, billingPlanVersions)).values({
				id: "parity-plan",
				planKey: "growth",
				version: 9001,
				status: "active",
				name: "Example",
				includedMonthlyCredits: 10,
				maxTedis: 5,
				maxCronJobsPerTedi: 10,
				maxIterationsPerTask: 16,
				effectiveAt: NOW,
				createdAt: NOW,
			});
			await db.insert(coreTable(db, billingAccounts)).values({
				organizationId: "org-1",
				planVersionId: "parity-plan",
				status: "active",
				billingMode: "stripe",
				periodStart: PERIOD_START,
				periodEnd: PERIOD_END,
				createdAt: NOW,
				updatedAt: NOW,
			});
			await db.insert(coreTable(db, billingServiceRateCards)).values({
				id: "seo-rate",
				serviceKey: "seo",
				operationKey: "research_keywords",
				version: 9001,
				status: "active",
				provider: "example",
				providerEndpoint: "/keywords",
				creditCost: 4,
				customerValueMicros: 10000,
				providerCostCeilingMicros: 30000,
				effectiveAt: "2026-07-30T04:00:00+02:00",
				createdAt: NOW,
			});
		}, 60000);
		afterAll(async () => {
			await close?.();
		});

		it("settles once, preserves JSON and tenant scope, and enforces provider spend and disabled controls", async () => {
			const first = await reserve(db, {
				tediId: null,
				metadata: { nested: { enabled: true } },
			});
			expect(first).toMatchObject({
				allowed: true,
				reservation: { metadata: { nested: { enabled: true } } },
			});
			expect(await reserve(db, { id: "replay", tediId: null })).toMatchObject({
				allowed: true,
				replayed: true,
			});
			const receipt = {
				id: "service-receipt",
				reservationId: "reservation-1",
				organizationId: "org-1",
				providerUsageId: "service-provider-receipt",
				provider: "example",
				model: "keywords",
				providerCostMicros: 20000,
				providerCostQuality: "provider_reported" as const,
				providerSucceeded: true,
				occurredAt: NOW,
				now: NOW,
			};
			await expect(
				settleBillingServiceCreditUsage(db, {
					...receipt,
					organizationId: "other",
				}),
			).rejects.toThrow("not found");
			expect(await settleBillingServiceCreditUsage(db, receipt)).toMatchObject({
				status: "settled",
			});
			await settleBillingServiceCreditUsage(db, receipt);
			expect(
				await getBillingServiceCreditSnapshot(db, "org-1", "seo", NOW),
			).toMatchObject({
				usedCredits: 4,
				reservedCredits: 0,
				availableCredits: 6,
				providerCostMicros: 20000,
			});
			await setBillingServiceCreditControls(db, {
				organizationId: "org-1",
				serviceKey: "seo",
				enabled: true,
				monthlyProviderCostLimitMicros: 40000,
				updatedBy: "owner",
				now: NOW,
			});
			expect(
				await reserve(db, {
					id: "blocked",
					idempotencyKey: "blocked",
					tediId: null,
				}),
			).toMatchObject({ allowed: false, code: "provider_cost_limit" });
			await setBillingServiceCreditControls(db, {
				organizationId: "org-1",
				serviceKey: "seo",
				enabled: false,
				updatedBy: "owner",
				now: NOW,
			});
			expect(
				await reserve(db, {
					id: "disabled",
					idempotencyKey: "disabled",
					tediId: null,
				}),
			).toMatchObject({ allowed: false, code: "service_disabled" });
		});
	});
