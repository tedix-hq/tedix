import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { organizations } from "../../schema/organizations";
import { createD1Facade } from "../../test/d1-facade";
import { createDurableSqliteFixture } from "../../test/durable-sqlite-fixture";
import { schemaDdl } from "../../test/schema-ddl";
import { createTenantStoreDb, resolveTenantStore } from "./tenant-store";

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

describe("resolveTenantStore", () => {
	it("binds the platform client for platform-d1", () => {
		const sqlite = sqliteWithOrgs();
		const platform = createDbQueryClient(createD1Facade(sqlite));
		const binding = resolveTenantStore({ plane: "platform-d1" }, { platform });
		expect(binding.plane).toBe("platform-d1");
		expect(binding.db).toBe(platform);
	});

	it("binds the tenant client for do-local-sqlite", () => {
		const sqlite = sqliteWithOrgs();
		const platform = createDbQueryClient(createD1Facade(sqlite));
		const tenant = createTenantStoreDb(createDurableSqliteFixture(sqlite));
		const binding = resolveTenantStore(
			{ plane: "do-local-sqlite" },
			{ platform, tenant },
		);
		expect(binding.plane).toBe("do-local-sqlite");
		expect(binding.db).toBe(tenant);
	});

	it("fails closed when do-local-sqlite has no tenant client", () => {
		const sqlite = sqliteWithOrgs();
		const platform = createDbQueryClient(createD1Facade(sqlite));
		expect(() =>
			resolveTenantStore({ plane: "do-local-sqlite" }, { platform }),
		).toThrow("TENANT_STORE_UNBOUND");
	});
});
