import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import { coreTable } from "../../core-store/client";
import { organizations } from "../../schema/organizations";
import { billingPlanVersions, billingAccounts } from "../../schema/billing";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { createPGliteFacade } from "../../test/pglite-facade";
import {
	expireBillingReservations,
	getBillingReservationFreshness,
	getBillingReservationTokenEstimates,
	getVoiceBillingReservation,
	listBillingUsageReservations,
	releaseBillingReservation,
	reserveBillingUsage,
} from "./reservations";

const now = "2026-07-27T12:00:00.000Z";
const periodEnd = "2026-08-01T00:00:00.000Z";
for (const store of ["d1", "postgres"] as const)
	describe(store, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			}
			await db
				.insert(coreTable(db, organizations))
				.values({ id: "org-example", name: "Example", slug: "example" });
			await db.insert(coreTable(db, billingPlanVersions)).values({
				id: "plan-example",
				planKey: "growth",
				version: 9001,
				status: "active",
				name: "Example",
				includedMonthlyCredits: 100,
				maxTedis: 5,
				maxCronJobsPerTedi: 10,
				maxIterationsPerTask: 16,
				creditFx: {
					microUsdPerEur: 1000000,
					source: "https://example.test/fx",
					asOf: "2026-07-01",
				},
				effectiveAt: now,
				createdAt: now,
			});
			await db.insert(coreTable(db, billingAccounts)).values({
				organizationId: "org-example",
				planVersionId: "plan-example",
				status: "active",
				billingMode: "stripe",
				periodStart: "2026-07-01T00:00:00.000Z",
				periodEnd,
				createdAt: now,
				updatedAt: now,
			});
		}, 30000);
		afterAll(async () => {
			await close?.();
		});
		it("holds credits once, preserves tenant scope and metadata, and releases or expires holds", async () => {
			const input = {
				id: "hold",
				organizationId: "org-example",
				source: "operator" as const,
				provider: "example",
				model: "example",
				estimatedInputTokens: 2,
				estimatedOutputTokens: 3,
				idempotencyKey: "voice:hold",
				expiresAt: periodEnd,
				credits: 4,
				metadata: { nested: { enabled: true } },
				now,
			};
			await expect(reserveBillingUsage(db, input)).resolves.toMatchObject({
				allowed: true,
				reservation: {
					id: "hold",
					planVersionId: "plan-example",
					expiresAt: periodEnd,
					credits: 4,
				},
			});
			await expect(
				reserveBillingUsage(db, { ...input, id: "replay" }),
			).resolves.toMatchObject({ allowed: true, reservation: { id: "hold" } });
			await expect(
				getVoiceBillingReservation(db, {
					organizationId: "other",
					reservationId: "hold",
				}),
			).resolves.toBeNull();
			await expect(
				getVoiceBillingReservation(db, {
					organizationId: "org-example",
					reservationId: "hold",
				}),
			).resolves.toMatchObject({ metadata: input.metadata });
			expect(
				await listBillingUsageReservations(db, {
					organizationId: "org-example",
				}),
			).toHaveLength(1);
			expect(
				await getBillingReservationTokenEstimates(db, [
					"hold",
					"hold",
					...Array.from({ length: 150 }, (_, i) => `missing-${i}`),
				]),
			).toEqual([
				{ id: "hold", estimatedInputTokens: 2, estimatedOutputTokens: 3 },
			]);
			expect(await getBillingReservationFreshness(db, Date.parse(now))).toEqual(
				{ maxCreatedAt: now },
			);
			await expect(
				releaseBillingReservation(db, {
					reservationId: "hold",
					organizationId: "other",
					reason: "cancelled",
					now,
				}),
			).resolves.toBeNull();
			await expect(
				releaseBillingReservation(db, {
					reservationId: "hold",
					organizationId: "org-example",
					reason: "cancelled",
					now,
				}),
			).resolves.toMatchObject({ status: "released" });
			await reserveBillingUsage(db, {
				...input,
				id: "expire",
				idempotencyKey: "expire",
				expiresAt: "2026-07-27T12:01:00.000Z",
			});
			expect(
				await expireBillingReservations(db, "2026-07-27T12:02:00.000Z"),
			).toBe(1);
			expect(
				await expireBillingReservations(db, "2026-07-27T12:02:00.000Z"),
			).toBe(0);
		});
	});
