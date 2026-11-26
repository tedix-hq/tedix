import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import { coreTable } from "../../core-store/client";
import {
	appCatalog as schemaAppCatalog,
	appCatalogBrowseTotals as schemaAppCatalogBrowseTotals,
	appCatalogCategoryTotals as schemaAppCatalogCategoryTotals,
} from "../../schema/catalog";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { createPGliteFacade } from "../../test/pglite-facade";
import {
	checkCatalogBrowseTotals,
	getCatalogCategories,
	getCatalogStats,
} from "./categories-stats";
import { listCatalogApps } from "./list-apps";
import { refreshCatalogShadowedVariants } from "./vendor-variants";

const stores = ["d1", "postgres"] as const;

async function applyPostgresMigrations(engine: {
	exec: (sql: string) => Promise<unknown>;
}) {
	for (const migration of readMigrationFiles({
		migrationsFolder: fileURLToPath(
			new URL("../../../drizzle-pg", import.meta.url),
		),
	}))
		for (const ddl of migration.sql) await engine.exec(ddl);
}

for (const store of stores) {
	describe(`catalog core store: ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		const appCatalog = () => coreTable(db, schemaAppCatalog);
		const browseTotals = () => coreTable(db, schemaAppCatalogBrowseTotals);
		const categoryTotals = () => coreTable(db, schemaAppCatalogCategoryTotals);

		function insertApp(id: string, overrides: Record<string, unknown> = {}) {
			return db.insert(appCatalog()).values({
				id,
				name: `Fictional ${id}`,
				connectorType: "MCP",
				developerType: "THIRD_PARTY",
				isDiscoverable: true,
				status: "ENABLED",
				reviewStatus: "RELEASED",
				lastSyncedAt: "2026-01-01",
				exploreShadowed: false,
				...overrides,
			} as never);
		}

		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				await applyPostgresMigrations(fixture.engine);
			}
		});

		afterAll(async () => {
			await close();
		});

		it("maintains browse and category totals across inserts, updates and deletes", async () => {
			await insertApp("visible-a", { category: "FINANCE" });
			await insertApp("visible-b", {
				category: "FINANCE",
				exploreShadowed: true,
			});
			await insertApp("visible-c", { category: "PRODUCTIVITY" });
			await insertApp("hidden-dev", { developerType: null });
			await insertApp("pending", { reviewStatus: "PENDING" });

			expect(
				await db
					.select()
					.from(browseTotals())
					.where(eq(browseTotals().id, "public")),
			).toEqual([{ id: "public", total: 3, exploreTotal: 2 }]);

			expect(
				await db
					.select()
					.from(categoryTotals())
					.orderBy(categoryTotals().category),
			).toEqual([
				{ category: "FINANCE", total: 2 },
				{ category: "PRODUCTIVITY", total: 1 },
			]);

			await db
				.update(appCatalog())
				.set({ status: "DISABLED" })
				.where(eq(appCatalog().id, "visible-c"));
			await db.delete(appCatalog()).where(eq(appCatalog().id, "visible-a"));

			expect(await db.select().from(browseTotals())).toEqual([
				{ id: "public", total: 1, exploreTotal: 0 },
			]);
			expect(
				await db
					.select()
					.from(categoryTotals())
					.orderBy(categoryTotals().category),
			).toEqual([
				{ category: "FINANCE", total: 1 },
				{ category: "PRODUCTIVITY", total: 0 },
			]);

			expect((await checkCatalogBrowseTotals(db)).matches).toBe(true);
			const stats = await getCatalogStats(db);
			expect(stats.total).toBe(1);
			expect(stats.mcp).toBe(1);
			const categories = await getCatalogCategories(db);
			expect(categories).toEqual([
				{ name: "FINANCE", label: "Finance", count: 1 },
			]);
		});

		it("lists public apps and refreshes shadowed vendor variants on both stores", async () => {
			await insertApp("vendor-run", {
				name: "Vendor Mail",
				website: "https://vendor.example",
				mcpToolCount: 3,
				category: "FINANCE",
			});
			await insertApp("vendor-card", {
				name: "Vendor Mail",
				website: "https://vendor.example",
				connectorType: "FIRST_PARTY_ECOSYSTEM",
				category: "FINANCE",
			});
			await insertApp("vendor-plain", {
				name: "Vendor Notes",
				website: "https://other.example",
				category: "PRODUCTIVITY",
			});

			const refreshed = await refreshCatalogShadowedVariants(db);
			expect(refreshed.flagged).toBe(1);
			// visible-b has no vendor key, so the refresh clears its stale flag.
			expect(refreshed.cleared).toBe(1);

			const { apps } = await listCatalogApps(db, {
				hideShadowedVariants: true,
			});
			const ids = apps.map((app) => app.id);
			expect(ids).toContain("vendor-run");
			expect(ids).toContain("vendor-plain");
			expect(ids).not.toContain("vendor-card");

			expect((await checkCatalogBrowseTotals(db)).matches).toBe(true);
		});
	});
}
