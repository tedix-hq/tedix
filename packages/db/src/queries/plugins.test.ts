import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { organizations } from "../schema/organizations";
import { tediPlugins } from "../schema/plugins";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	createPluginEvent,
	createPluginInstall,
	deletePluginInstall,
	getPluginById,
	getPluginInstall,
	listPluginEvents,
	listPlugins,
	updatePluginInstall,
} from "./plugins";

for (const store of ["d1", "postgres"] as const)
	describe(`plugins (${store})`, () => {
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
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			}
			await db.insert(coreTable(db, organizations)).values([
				{ id: "org-a", name: "A", slug: "a" },
				{ id: "org-b", name: "B", slug: "b" },
			]);
			await db.insert(coreTable(db, tediPlugins)).values([
				{
					id: "plugin",
					slug: "plugin",
					name: "Search_" + "A".repeat(70) + "%",
					type: "tool",
					version: "1.0.0",
					status: "published",
					manifest: { nested: { enabled: true } },
					createdAt: "2026-01-01",
				},
				{
					id: "null-date",
					slug: "null-date",
					name: "Search_" + "A".repeat(70) + "%",
					type: "tool",
					version: "1.0.0",
					status: "published",
					createdAt: null,
				},
				{
					id: "other",
					slug: "other",
					name: "Other",
					type: "workflow",
					version: "1.0.0",
				},
			]);
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("keeps literal long searches, null ordering and paginated totals", async () => {
			const result = await listPlugins(db, {
				type: "tool",
				status: "published",
				query: "search_" + "a".repeat(70) + "%",
				limit: 1,
			});
			expect(result.total).toBe(2);
			expect(result.data.map((row) => row.id)).toEqual(["plugin"]);
			expect(
				(await listPlugins(db, { query: "%", offset: 1 })).data.map(
					(row) => row.id,
				),
			).toEqual(["null-date"]);
			expect((await getPluginById(db, "plugin"))?.manifest).toEqual({
				nested: { enabled: true },
			});
		});

		it("round-trips install JSON and scopes event reads to their organization", async () => {
			await createPluginInstall(db, {
				id: "install",
				orgId: "org-a",
				pluginId: "plugin",
				config: { enabled: true },
				permissionsGranted: ["read"],
			});
			expect(await getPluginInstall(db, "install", "org-b")).toBeUndefined();
			expect(
				(
					await updatePluginInstall(db, "install", {
						status: "active",
						config: { nested: { count: 2 } },
					})
				)?.config,
			).toEqual({ nested: { count: 2 } });
			expect(
				(await getPluginInstall(db, "install", "org-a"))?.permissionsGranted,
			).toEqual(["read"]);
			for (const orgId of ["org-a", "org-b"])
				await createPluginEvent(db, {
					id: orgId,
					orgId,
					pluginId: "plugin",
					eventType: "changed",
					payload: { ok: true },
					status: "completed",
				});
			const events = await listPluginEvents(db, {
				orgId: "org-a",
				pluginId: "plugin",
				eventType: "changed",
				status: "completed",
			});
			expect(events.total).toBe(1);
			expect(events.data.map((row) => [row.id, row.payload])).toEqual([
				["org-a", { ok: true }],
			]);
			await deletePluginInstall(db, "install");
			expect(await getPluginInstall(db, "install", "org-a")).toBeUndefined();
			expect(
				await updatePluginInstall(db, "missing", { status: "active" }),
			).toBeUndefined();
		});
	});
