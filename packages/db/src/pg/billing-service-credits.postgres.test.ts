import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { createDbClient } from "../client";
import * as sqliteCredits from "../queries/billing-service-credits";
import {
	billingAccounts as sqliteAccounts,
	billingPlanVersions as sqlitePlans,
	billingPlanServiceAllowances as sqliteAllowances,
	billingServiceRateCards as sqliteRates,
	billingServiceCreditEntries as sqliteEntries,
	billingServiceCreditReservations as sqliteReservations,
	billingProviderUsage as sqliteUsage,
} from "../schema/billing";
import { organizations as sqliteOrganizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import {
	getBillingServiceCreditSnapshot,
	grantBillingServiceCredits,
	releaseBillingServiceCreditReservation,
	reserveBillingServiceCredits,
	setBillingServiceCreditControls,
	settleBillingServiceCreditUsage,
} from "./queries/billing-service-credits";
import {
	billingAccounts,
	billingPlanVersions,
	billingPlanServiceAllowances,
	billingServiceCreditEntries,
	billingServiceCreditReservations,
	billingServiceRateCards,
	billingProviderUsage,
} from "./schema/billing";
import { organizations } from "./schema/organizations";

const now = "2026-11-05T12:00:00.000Z";
const periodStart = "2026-11-01T00:00:00.000Z";
const periodEnd = "2026-12-01T00:00:00.000Z";
const reservationInput = {
	id: "reservation-1",
	organizationId: "org-service-test",
	tediId: "tedi-test",
	serviceKey: "seo",
	operationKey: "research_keywords",
	idempotencyKey: "request-1",
	expiresAt: "2026-11-05T12:10:00.000Z",
	now,
} as const;
const settlementInput = {
	id: "receipt-1",
	reservationId: reservationInput.id,
	organizationId: reservationInput.organizationId,
	providerUsageId: "provider:receipt-1",
	provider: "test-provider",
	model: "test-endpoint",
	providerCostMicros: 25,
	providerCostQuality: "provider_reported",
	providerSucceeded: true,
	occurredAt: now,
	now,
} as const;

describe("Postgres managed service credits", () => {
	const pg = new PGlite();
	const db = drizzle({ client: pg });
	beforeAll(async () => {
		const root = new URL("../../drizzle-pg/", import.meta.url);
		const directories = (await readdir(root))
			.filter((name) => /^\d{14}_/.test(name))
			.sort();
		for (const directory of directories) {
			const migration = await readFile(
				new URL(`${directory}/migration.sql`, root),
				"utf8",
			);
			await pg.exec(migration);
		}
	});
	afterAll(async () => {
		await pg.close();
	});
	beforeEach(async () => {
		await pg.exec(
			"TRUNCATE organizations, billing_plan_versions, billing_service_rate_cards, billing_provider_usage CASCADE",
		);
		await db.insert(organizations).values({
			id: reservationInput.organizationId,
			name: "Service Test",
			slug: "service-test",
		});
		await db.insert(billingPlanVersions).values({
			id: "plan-service-test",
			planKey: "growth",
			version: 999,
			status: "active",
			name: "Test",
			includedMonthlyTokens: 0,
			maxTedis: 1,
			maxCronJobsPerTedi: 1,
			maxIterationsPerTask: 1,
			defaultDailyTokenLimit: 0,
			defaultDailyMessageLimit: 0,
			effectiveAt: periodStart,
		});
		await db.insert(billingAccounts).values({
			organizationId: reservationInput.organizationId,
			planVersionId: "plan-service-test",
			status: "active",
			periodStart,
			periodEnd,
		});
		await db.insert(billingPlanServiceAllowances).values({
			id: "allowance-test",
			planVersionId: "plan-service-test",
			serviceKey: "seo",
			includedCredits: 8,
		});
		await db.insert(billingServiceRateCards).values({
			id: "rate-test",
			serviceKey: "seo",
			operationKey: "research_keywords",
			version: 999,
			status: "active",
			provider: "test-provider",
			providerEndpoint: "test-endpoint",
			creditCost: 4,
			customerValueMicros: 100,
			providerCostCeilingMicros: 50,
			effectiveAt: periodStart,
		});
	});

	it("journals one grant and reserves only the available credits across competing calls", async () => {
		const decisions = await Promise.all(
			[1, 2, 3].map((n) =>
				reserveBillingServiceCredits(db, {
					...reservationInput,
					id: `reservation-${n}`,
					idempotencyKey: `request-${n}`,
				}),
			),
		);
		expect(decisions.filter((decision) => decision.allowed)).toHaveLength(2);
		expect(decisions.filter((decision) => !decision.allowed)).toMatchObject([
			{ code: "credit_allowance_exhausted" },
		]);
		expect(await db.select().from(billingServiceCreditEntries)).toHaveLength(1);
		expect(
			await getBillingServiceCreditSnapshot(
				db,
				reservationInput.organizationId,
				"seo",
				now,
			),
		).toMatchObject({
			grantedCredits: 8,
			usedCredits: 0,
			reservedCredits: 8,
			availableCredits: 0,
			enabled: true,
		});
		const replay = await reserveBillingServiceCredits(db, {
			...reservationInput,
			id: "replayed",
		});
		expect(replay).toMatchObject({
			allowed: true,
			replayed: true,
			reservation: { id: reservationInput.id },
		});
	});

	it("settles once, keeps provider costs numeric, and prevents a second receipt", async () => {
		expect(
			(await reserveBillingServiceCredits(db, reservationInput)).allowed,
		).toBe(true);
		const [first, replay] = await Promise.all([
			settleBillingServiceCreditUsage(db, settlementInput),
			settleBillingServiceCreditUsage(db, {
				...settlementInput,
				id: "receipt-replayed",
			}),
		]);
		expect(first).toEqual(replay);
		expect(first).toMatchObject({
			status: "settled",
			actualProviderCostMicros: 25,
		});
		expect(await db.select().from(billingProviderUsage)).toHaveLength(1);
		expect(await db.select().from(billingServiceCreditEntries)).toHaveLength(2);
		await expect(
			settleBillingServiceCreditUsage(db, {
				...settlementInput,
				providerUsageId: "provider:other",
			}),
		).rejects.toThrow("not settleable");
		expect(
			await getBillingServiceCreditSnapshot(
				db,
				reservationInput.organizationId,
				"seo",
				now,
			),
		).toMatchObject({
			usedCredits: 4,
			reservedCredits: 0,
			availableCredits: 4,
			providerCostMicros: 25,
		});
	});

	it("rolls back the receipt and debit if the reservation transition fails", async () => {
		await reserveBillingServiceCredits(db, reservationInput);
		await pg.exec(`
   CREATE FUNCTION reject_service_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'injected settlement failure'; END $$;
   CREATE TRIGGER reject_service_settlement BEFORE UPDATE ON billing_service_credit_reservations
    FOR EACH ROW EXECUTE FUNCTION reject_service_settlement();
  `);
		try {
			await expect(
				settleBillingServiceCreditUsage(db, settlementInput),
			).rejects.toMatchObject({
				cause: { message: "injected settlement failure" },
			});
			expect(await db.select().from(billingProviderUsage)).toHaveLength(0);
			expect(await db.select().from(billingServiceCreditEntries)).toHaveLength(
				1,
			);
			expect(
				await db.select().from(billingServiceCreditReservations),
			).toMatchObject([{ status: "reserved", providerUsageId: null }]);
		} finally {
			await pg.exec(
				"DROP TRIGGER reject_service_settlement ON billing_service_credit_reservations; DROP FUNCTION reject_service_settlement()",
			);
		}
	});

	it("records failed provider cost and releases credits without a debit", async () => {
		await reserveBillingServiceCredits(db, reservationInput);
		expect(
			await settleBillingServiceCreditUsage(db, {
				...settlementInput,
				providerSucceeded: false,
			}),
		).toMatchObject({ status: "released", rejectionCode: "provider_failed" });
		expect(await db.select().from(billingServiceCreditEntries)).toHaveLength(1);
		expect(
			await getBillingServiceCreditSnapshot(
				db,
				reservationInput.organizationId,
				"seo",
				now,
			),
		).toMatchObject({ availableCredits: 8, providerCostMicros: 25 });
	});

	it("keeps a colliding receipt from charging or settling another reservation", async () => {
		await reserveBillingServiceCredits(db, reservationInput);
		await reserveBillingServiceCredits(db, {
			...reservationInput,
			id: "reservation-2",
			idempotencyKey: "request-2",
		});
		await settleBillingServiceCreditUsage(db, settlementInput);
		await expect(
			settleBillingServiceCreditUsage(db, {
				...settlementInput,
				id: "receipt-2",
				reservationId: "reservation-2",
			}),
		).rejects.toThrow("Failed to journal managed service credit debit");
		expect(await db.select().from(billingProviderUsage)).toHaveLength(1);
		expect(await db.select().from(billingServiceCreditEntries)).toHaveLength(2);
		expect(
			await db
				.select()
				.from(billingServiceCreditReservations)
				.where(eq(billingServiceCreditReservations.id, "reservation-2")),
		).toMatchObject([{ status: "reserved" }]);
	});

	it("enforces controls, grants idempotently, and releases a reservation once", async () => {
		await setBillingServiceCreditControls(db, {
			organizationId: reservationInput.organizationId,
			serviceKey: "seo",
			enabled: false,
			updatedBy: "test-owner",
			now,
		});
		expect(
			await reserveBillingServiceCredits(db, reservationInput),
		).toMatchObject({ allowed: false, code: "service_disabled" });
		await setBillingServiceCreditControls(db, {
			organizationId: reservationInput.organizationId,
			serviceKey: "seo",
			enabled: true,
			monthlyCreditLimit: 4,
			updatedBy: "test-owner",
			now,
		});
		await reserveBillingServiceCredits(db, reservationInput);
		expect(
			await reserveBillingServiceCredits(db, {
				...reservationInput,
				id: "reservation-2",
				idempotencyKey: "request-2",
			}),
		).toMatchObject({ allowed: false, code: "monthly_credit_limit" });
		const grant = {
			id: "grant-test",
			organizationId: reservationInput.organizationId,
			serviceKey: "seo",
			amountCredits: 3,
			sourceType: "test",
			idempotencyKey: "grant-key",
			createdAt: now,
		} as const;
		expect(await grantBillingServiceCredits(db, grant)).toEqual(
			await grantBillingServiceCredits(db, { ...grant, id: "grant-replay" }),
		);
		const release = {
			reservationId: reservationInput.id,
			organizationId: reservationInput.organizationId,
			reason: "cancelled",
			now,
		};
		expect(
			await releaseBillingServiceCreditReservation(db, release),
		).toMatchObject({ status: "released" });
		expect(
			await releaseBillingServiceCreditReservation(db, release),
		).toBeNull();
	});

	it("rolls back a receipt when its debit key belongs to a grant", async () => {
		await reserveBillingServiceCredits(db, reservationInput);
		await grantBillingServiceCredits(db, {
			id: "conflicting-grant",
			organizationId: reservationInput.organizationId,
			serviceKey: "seo",
			amountCredits: 1,
			sourceType: "test",
			idempotencyKey: `service-debit:${settlementInput.providerUsageId}`,
			createdAt: now,
		});
		await expect(
			settleBillingServiceCreditUsage(db, settlementInput),
		).rejects.toThrow("Failed to journal managed service credit debit");
		expect(await db.select().from(billingProviderUsage)).toHaveLength(0);
		expect(await db.select().from(billingServiceCreditEntries)).toHaveLength(2);
		expect(
			await db.select().from(billingServiceCreditReservations),
		).toMatchObject([{ status: "reserved", providerUsageId: null }]);
	});

	it("rolls back a plan grant when reservation insertion fails", async () => {
		await pg.exec(`
		 CREATE FUNCTION reject_service_reservation() RETURNS trigger LANGUAGE plpgsql AS $$
		  BEGIN RAISE EXCEPTION 'injected reservation failure'; END $$;
		 CREATE TRIGGER reject_service_reservation BEFORE INSERT ON billing_service_credit_reservations
		  FOR EACH ROW EXECUTE FUNCTION reject_service_reservation();
		`);
		try {
			await expect(
				reserveBillingServiceCredits(db, reservationInput),
			).rejects.toMatchObject({
				cause: { message: "injected reservation failure" },
			});
			expect(await db.select().from(billingServiceCreditEntries)).toHaveLength(
				0,
			);
			expect(
				await db.select().from(billingServiceCreditReservations),
			).toHaveLength(0);
		} finally {
			await pg.exec(
				"DROP TRIGGER reject_service_reservation ON billing_service_credit_reservations; DROP FUNCTION reject_service_reservation()",
			);
		}
	});

	it("enforces tedi and provider cost ceilings and accepts an unassigned tedi", async () => {
		await setBillingServiceCreditControls(db, {
			organizationId: reservationInput.organizationId,
			serviceKey: "seo",
			enabled: true,
			perTediMonthlyLimit: 4,
			monthlyProviderCostLimitMicros: 100,
			updatedBy: "test-owner",
			now,
		});
		expect(
			await getBillingServiceCreditSnapshot(
				db,
				reservationInput.organizationId,
				"seo",
				now,
			),
		).toMatchObject({
			perTediMonthlyLimit: 4,
			monthlyProviderCostLimitMicros: 100,
		});
		expect(
			(await reserveBillingServiceCredits(db, reservationInput)).allowed,
		).toBe(true);
		expect(
			await reserveBillingServiceCredits(db, {
				...reservationInput,
				id: "reservation-2",
				idempotencyKey: "request-2",
			}),
		).toMatchObject({ allowed: false, code: "tedi_credit_limit" });
		await setBillingServiceCreditControls(db, {
			organizationId: reservationInput.organizationId,
			serviceKey: "seo",
			enabled: true,
			perTediMonthlyLimit: 4,
			monthlyProviderCostLimitMicros: 75,
			updatedBy: "test-owner",
			now,
		});
		expect(
			await reserveBillingServiceCredits(db, {
				...reservationInput,
				id: "reservation-2",
				idempotencyKey: "request-2",
				tediId: null,
			}),
		).toMatchObject({ allowed: false, code: "provider_cost_limit" });
		await releaseBillingServiceCreditReservation(db, {
			reservationId: reservationInput.id,
			organizationId: reservationInput.organizationId,
			reason: "cancelled",
			now,
		});
		expect(
			(
				await reserveBillingServiceCredits(db, {
					...reservationInput,
					id: "reservation-2",
					idempotencyKey: "request-2",
					tediId: null,
				})
			).allowed,
		).toBe(true);
	});

	it("matches every SQLite service ledger column, balance, and snapshot through replay and rollback", async () => {
		const sqlite = createMigratedSqlite();
		const sqliteDb = createDbClient(createD1Facade(sqlite));
		const randomUUID = vi
			.spyOn(crypto, "randomUUID")
			.mockReturnValue("00000000-0000-4000-8000-000000000001");
		try {
			await sqliteDb
				.insert(sqliteOrganizations)
				.values(await db.select().from(organizations));
			await sqliteDb
				.insert(sqlitePlans)
				.values(await db.select().from(billingPlanVersions));
			await sqliteDb
				.insert(sqliteAccounts)
				.values(await db.select().from(billingAccounts));
			await sqliteDb
				.insert(sqliteAllowances)
				.values(await db.select().from(billingPlanServiceAllowances));
			await sqliteDb
				.insert(sqliteRates)
				.values(await db.select().from(billingServiceRateCards));
			const input = { ...reservationInput, tediId: null };

			async function assertParity() {
				const pgState = {
					journal: await db
						.select()
						.from(billingServiceCreditEntries)
						.orderBy(billingServiceCreditEntries.id),
					reservations: await db
						.select()
						.from(billingServiceCreditReservations)
						.orderBy(billingServiceCreditReservations.id),
					providerUsage: await db
						.select()
						.from(billingProviderUsage)
						.orderBy(billingProviderUsage.id),
					balance: await db
						.select({
							creditBalanceMicros: billingAccounts.creditBalanceMicros,
						})
						.from(billingAccounts)
						.where(eq(billingAccounts.organizationId, input.organizationId)),
					snapshot: await getBillingServiceCreditSnapshot(
						db,
						input.organizationId,
						"seo",
						now,
					),
				};
				const sqliteState = {
					journal: await sqliteDb
						.select()
						.from(sqliteEntries)
						.orderBy(sqliteEntries.id),
					reservations: await sqliteDb
						.select()
						.from(sqliteReservations)
						.orderBy(sqliteReservations.id),
					providerUsage: await sqliteDb
						.select()
						.from(sqliteUsage)
						.orderBy(sqliteUsage.id),
					balance: await sqliteDb
						.select({ creditBalanceMicros: sqliteAccounts.creditBalanceMicros })
						.from(sqliteAccounts)
						.where(eq(sqliteAccounts.organizationId, input.organizationId)),
					snapshot: await sqliteCredits.getBillingServiceCreditSnapshot(
						sqliteDb,
						input.organizationId,
						"seo",
						now,
					),
				};
				expect(pgState).toEqual(sqliteState);
				return pgState;
			}

			const initial = await assertParity();
			expect(initial.balance).toEqual([{ creditBalanceMicros: 0 }]);
			expect(await reserveBillingServiceCredits(db, input)).toEqual(
				await sqliteCredits.reserveBillingServiceCredits(sqliteDb, input),
			);
			const reserved = await assertParity();
			expect(reserved.journal).toHaveLength(1);
			expect(reserved.reservations).toHaveLength(1);
			expect(reserved.providerUsage).toHaveLength(0);

			randomUUID.mockReturnValue("00000000-0000-4000-8000-000000000002");
			expect(
				await settleBillingServiceCreditUsage(db, settlementInput),
			).toEqual(
				await sqliteCredits.settleBillingServiceCreditUsage(
					sqliteDb,
					settlementInput,
				),
			);
			const settled = await assertParity();
			expect(settled.journal).toHaveLength(2);
			expect(settled.providerUsage).toHaveLength(1);
			expect(settled.balance).toEqual(initial.balance);
			expect(settled.snapshot).toMatchObject({
				usedCredits: 4,
				reservedCredits: 0,
				availableCredits: 4,
				providerCostMicros: 25,
			});

			const replay = { ...settlementInput, id: "replayed" };
			expect(await settleBillingServiceCreditUsage(db, replay)).toEqual(
				await sqliteCredits.settleBillingServiceCreditUsage(sqliteDb, replay),
			);
			expect(await assertParity()).toEqual(settled);

			randomUUID.mockReturnValue("00000000-0000-4000-8000-000000000003");
			const second = {
				...input,
				id: "reservation-2",
				idempotencyKey: "request-2",
			};
			expect(await reserveBillingServiceCredits(db, second)).toEqual(
				await sqliteCredits.reserveBillingServiceCredits(sqliteDb, second),
			);
			const beforeRollback = await assertParity();
			sqlite.exec(
				`CREATE TRIGGER reject_service_parity BEFORE UPDATE ON billing_service_credit_reservations BEGIN SELECT RAISE(ABORT, 'injected parity failure'); END`,
			);
			await pg.exec(`CREATE FUNCTION reject_service_parity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected parity failure'; END $$;
			 CREATE TRIGGER reject_service_parity BEFORE UPDATE ON billing_service_credit_reservations FOR EACH ROW EXECUTE FUNCTION reject_service_parity()`);
			try {
				randomUUID.mockReturnValue("00000000-0000-4000-8000-000000000004");
				const failed = {
					...settlementInput,
					id: "receipt-2",
					providerUsageId: "provider:receipt-2",
					reservationId: second.id,
				};
				await expect(
					settleBillingServiceCreditUsage(db, failed),
				).rejects.toMatchObject({
					cause: { message: "injected parity failure" },
				});
				await expect(
					sqliteCredits.settleBillingServiceCreditUsage(sqliteDb, failed),
				).rejects.toMatchObject({
					message: "injected parity failure",
					code: "ERR_SQLITE_ERROR",
					errcode: 1811,
				});
				expect(await assertParity()).toEqual(beforeRollback);
			} finally {
				await pg.exec(
					"DROP TRIGGER reject_service_parity ON billing_service_credit_reservations; DROP FUNCTION reject_service_parity()",
				);
			}
		} finally {
			randomUUID.mockRestore();
			sqlite.close();
		}
	});
});
