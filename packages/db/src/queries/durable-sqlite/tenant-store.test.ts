import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { organizations } from "../../schema/organizations";
import { createDurableSqliteFixture } from "../../test/durable-sqlite-fixture";
import { schemaDdl } from "../../test/schema-ddl";
import { createTenantStoreDb } from "./tenant-store";

function sqliteWithOrgs() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations));
	return sqlite;
}

describe("durable-sqlite fixture", () => {
	it("round-trips reads and writes through the drizzle DO driver", async () => {
		const sqlite = sqliteWithOrgs();
		const db = createTenantStoreDb(createDurableSqliteFixture(sqlite));
		db.insert(organizations)
			.values({ id: "org-1", name: "Example", slug: "example" })
			.run();
		const rows = await db.select().from(organizations);
		expect(rows).toEqual([
			expect.objectContaining({ id: "org-1", name: "Example" }),
		]);
	});

	it("commits a transaction and rolls back on throw", async () => {
		const sqlite = sqliteWithOrgs();
		const db = createTenantStoreDb(createDurableSqliteFixture(sqlite));
		db.transaction((tx) => {
			tx.insert(organizations)
				.values({ id: "org-1", name: "A", slug: "a" })
				.run();
			tx.insert(organizations)
				.values({ id: "org-2", name: "B", slug: "b" })
				.run();
		});
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM organizations").get(),
		).toEqual({ n: 2 });
		expect(() =>
			db.transaction((tx) => {
				tx.insert(organizations)
					.values({ id: "org-3", name: "C", slug: "c" })
					.run();
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM organizations").get(),
		).toEqual({ n: 2 });
	});
});
