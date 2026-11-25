import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect, it } from "vite-plus/test";
import { eq, getTableName, is } from "drizzle-orm";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { createDbClient, type DbClient } from "../client";
import * as catalog from "../schema/catalog";
import { apps } from "../schema/apps";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { createPGliteFacade } from "../test/pglite-facade";
import { tableDdl } from "../test/schema-ddl";
import { coreTable } from "./client";

for (const store of ["d1", "postgres"] as const)
	it(`${store}: resolves catalog Core API and cross-domain relations with foreign keys enabled`, async () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		const tables: SQLiteTable[] = [];
		for (const value of Object.values(catalog))
			if (is(value, SQLiteTable)) tables.push(value);
		if (store === "d1") {
			const sqlite = new DatabaseSync(":memory:");
			sqlite.exec("PRAGMA foreign_keys = ON");
			for (const table of [organizations, ...tables, apps])
				for (const ddl of tableDdl(table)) sqlite.exec(ddl);
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
			for (const table of tables) {
				expect(
					getTableConfig(coreTable(db, table) as unknown as PgTable).schema,
				).toBe("catalog");
				expect(
					(
						await fixture.engine.query("SELECT to_regclass($1) AS name", [
							`public.${getTableName(table)}`,
						])
					).rows,
				).toEqual([{ name: null }]);
			}
		}
		try {
			const entry = coreTable(db, catalog.appCatalog);
			const listing = coreTable(db, catalog.appCatalogStoreListings);
			const app = coreTable(db, apps);
			await db
				.insert(coreTable(db, organizations))
				.values({ id: "org", name: "Org", slug: "org" });
			await db.insert(entry).values({
				id: "catalog",
				name: "Example",
				connectorType: "MCP",
				lastSyncedAt: "2026-11-25",
			});
			await db.insert(listing).values({
				id: "listing",
				catalogAppId: "catalog",
				source: "manual",
				sourceAppId: "source",
				lastSyncedAt: "2026-11-25",
			});
			await db.insert(app).values({
				id: "installed",
				organizationId: "org",
				name: "Installed",
				slug: "installed",
				catalogAppId: "catalog",
			});
			expect(await db.select({ id: entry.id }).from(entry)).toEqual([
				{ id: "catalog" },
			]);
			expect(
				await db.query.appCatalog.findFirst({
					where: { id: "catalog" },
					columns: { id: true },
					with: {
						storeListings: {
							columns: { id: true },
							with: { catalogApp: { columns: { id: true } } },
						},
						installedApps: { columns: { id: true } },
					},
				}),
			).toEqual({
				id: "catalog",
				storeListings: [{ id: "listing", catalogApp: { id: "catalog" } }],
				installedApps: [{ id: "installed" }],
			});
			expect(
				await db.query.apps.findFirst({
					where: { id: "installed" },
					columns: { id: true },
					with: { catalogApp: { columns: { id: true } } },
				}),
			).toEqual({ id: "installed", catalogApp: { id: "catalog" } });
			await expect(
				db.insert(app).values({
					id: "bad",
					organizationId: "org",
					name: "Bad",
					slug: "bad",
					catalogAppId: "missing",
				}),
			).rejects.toThrow();
			await db.delete(entry).where(eq(entry.id, "catalog"));
			expect(await db.select({ id: listing.id }).from(listing)).toEqual([]);
			expect(
				await db.select({ catalogAppId: app.catalogAppId }).from(app),
			).toEqual([{ catalogAppId: null }]);
		} finally {
			await close();
		}
	}, 30000);
