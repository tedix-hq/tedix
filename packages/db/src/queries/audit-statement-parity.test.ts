import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import { organizations } from "../schema/organizations";
import { auditEvents } from "../schema/audit-events";
import { updateOrganization } from "./organizations";

const occurredAt = new Date("2026-11-01T00:00:00.000Z");
const metadata = { previousValue: "Example", enabled: true, nested: { n: 2 } };

for (const store of ["d1", "postgres"] as const)
	describe(store, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
				close = () => {
					if (sqlite.isOpen) sqlite.close();
				};
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
			await db.insert(coreTable(db, organizations)).values({
				id: "org-1",
				name: "Example",
				slug: "example",
			});
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("stores the exact occurredAt timestamp and JSON metadata inside the update batch", async () => {
			const event = {
				id: "audit-1",
				organizationId: "org-1",
				actorId: "admin-1",
				actorType: "user" as const,
				action: "organization.updated",
				resourceType: "organization",
				resourceId: "org-1",
				occurredAt,
				metadata,
				ignoreDuplicates: true,
			};
			await updateOrganization(db, "org-1", { name: "Renamed" }, event);
			// A redelivery with the same deterministic id must not rewrite the row.
			await updateOrganization(
				db,
				"org-1",
				{ name: "Renamed Again" },
				{ ...event, occurredAt: new Date("2026-11-02T00:00:00.000Z") },
			);
			const rows = await db
				.select()
				.from(coreTable(db, auditEvents))
				.where(eq(coreTable(db, auditEvents).id, "audit-1"));
			expect(rows).toHaveLength(1);
			expect(rows[0]?.timestamp.toISOString()).toBe("2026-11-01T00:00:00.000Z");
			expect(rows[0]?.metadata).toEqual(metadata);
		});
	});
