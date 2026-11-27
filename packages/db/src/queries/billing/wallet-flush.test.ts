import { getCreditPoolSnapshot } from "./credit-pool";
import { postWalletFlush } from "./wallet-flush";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import { coreTable } from "../../core-store/client";
import { organizations } from "../../schema/organizations";
import {
	billingPlanVersions,
	billingAccounts,
	billingProviderUsage,
} from "../../schema/billing";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { createPGliteFacade } from "../../test/pglite-facade";

const now = "2026-07-27T12:00:00.000Z";
const periodEnd = "2026-08-01T00:00:00.000Z";
for (const store of ["d1", "postgres"] as const)
	describe(store, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		let exec: (ddl: string) => unknown;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
				close = () => sqlite.close();
				exec = (ddl) => sqlite.exec(ddl);
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				exec = (ddl) => fixture.engine.exec(ddl);
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

		it("posts multi-group flushes once and rolls credits back if provider evidence fails", async () => {
			const periodStart = "2026-07-01T00:00:00.000Z";
			const snapshot = () =>
				getCreditPoolSnapshot(db, { organizationId: "org-example", now });
			const before = await snapshot();
			const flush = {
				organizationId: "org-example",
				flushId: "flush",
				now,
				groups: Array.from({ length: 5 }, (_, i) => ({
					key: `group-${i}`,
					kind: "code_run" as const,
					tediId: null,
					userId: `member-${i}`,
					periodStart,
					periodEnd,
					credits: 3,
					anonymousLoads: 2,
					namedLoads: 1,
					runs: 3,
					firstAt: now,
				})),
			};
			await postWalletFlush(db, flush);
			await postWalletFlush(db, flush);
			const after = await snapshot();
			expect(before!.availableCredits - after!.availableCredits).toBe(15);
			const evidence = await db
				.select()
				.from(coreTable(db, billingProviderUsage));
			expect(evidence).toHaveLength(10);
			expect(evidence).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						quantity: 2,
						metadata: {
							surface: "gateway_model_code",
							identity: "anonymous",
							runs: 3,
						},
					}),
					expect.objectContaining({
						quantity: 1,
						metadata: {
							surface: "gateway_model_code",
							identity: "named",
							runs: 3,
						},
					}),
				]),
			);
			// Fail after consumption statements to prove the flush is atomic.
			await exec(
				store === "postgres"
					? `
    CREATE FUNCTION reject_wallet_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'provider evidence unavailable'; END; $$;
    CREATE TRIGGER reject_wallet_evidence BEFORE INSERT ON billing_provider_usage
    FOR EACH ROW EXECUTE FUNCTION reject_wallet_evidence();
   `
					: `CREATE TRIGGER reject_wallet_evidence BEFORE INSERT ON billing_provider_usage
    BEGIN SELECT RAISE(ABORT, 'provider evidence unavailable'); END;`,
			);
			await expect(
				postWalletFlush(db, { ...flush, flushId: "rollback" }),
			).rejects.toThrow();
			expect((await snapshot())?.availableCredits).toBe(
				after?.availableCredits,
			);
			expect(
				await db.select().from(coreTable(db, billingProviderUsage)),
			).toHaveLength(10);
		});
	});
