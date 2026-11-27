import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { createPGliteFacade } from "../test/pglite-facade";
import { billingAccounts, billingPlanVersions } from "../schema/billing";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getRuntimeEntitlement,
	runtimeEntitlementQuery,
	runtimeEntitlementFromRow,
	runtimeEntitlementIsActive,
} from "./runtime-entitlements";

const START = "2026-08-01T00:00:00.000Z";
const END = "2026-09-01T00:00:00.000Z";

describe.each(["d1", "postgres"] as const)(
	"runtime entitlements (%s)",
	(store) => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = new DatabaseSync(":memory:");
				sqlite.exec(
					schemaDdl(organizations, billingPlanVersions, billingAccounts),
				);
				db = createDbClient(createD1Facade(sqlite));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			}
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});
		it("projects only provider-neutral runtime fields from the temporary backing tables", async () => {
			await db.insert(coreTable(db, organizations)).values([
				{
					id: "org-1",
					name: "Acme",
					slug: "acme",
					createdAt: START,
					updatedAt: START,
				},
			]);
			await db.insert(coreTable(db, billingPlanVersions)).values({
				id: "profile-1",
				planKey: "starter",
				version: 7,
				status: "active",
				name: "Developer",
				includedMonthlyCredits: 500,
				maxTedis: 2,
				maxCronJobsPerTedi: 5,
				maxIterationsPerTask: 12,
				effectiveAt: START,
				createdAt: START,
			});
			await db.insert(coreTable(db, billingAccounts)).values({
				organizationId: "org-1",
				planVersionId: "profile-1",
				status: "active",
				billingMode: "internal",
				stripeEnvironment: "test",
				stripeCustomerId: "cus_must_not_escape",
				periodStart: START,
				periodEnd: END,
				entitlementVersion: 3,
				metadata: {
					runtimeEntitlementSource: "installation",
					runtimeEntitlementGrants: [
						{ key: "browser-runtime", status: "active", source: "operator" },
					],
				},
				createdAt: START,
				updatedAt: START,
			});

			const entitlement = await getRuntimeEntitlement(db, "org-1");
			expect(entitlement).toEqual({
				organizationId: "org-1",
				status: "active",
				effectivePeriod: { startsAt: START, endsAt: END },
				profile: { key: "starter", name: "Developer" },
				limits: {
					includedMonthlyCredits: 500,
					maxTedis: 2,
					maxCronJobsPerTedi: 5,
					maxIterationsPerTask: 12,
				},
				grants: [
					{ key: "browser-runtime", status: "active", source: "operator" },
				],
				source: "installation",
				version: 3,
			});
			const [rows] = await db.batch([runtimeEntitlementQuery(db, "org-1")]);
			expect(runtimeEntitlementFromRow(rows[0])).toEqual(entitlement);
			expect(JSON.stringify(entitlement)).not.toMatch(
				/stripe|price|charge|rate/i,
			);
			expect(runtimeEntitlementIsActive(entitlement!, Date.parse(START))).toBe(
				true,
			);
			expect(runtimeEntitlementIsActive(entitlement!, Date.parse(END))).toBe(
				false,
			);
			await expect(getRuntimeEntitlement(db, "missing")).resolves.toBeNull();
		});
	},
);
