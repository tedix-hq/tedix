import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";

test("retention protects active, future, newest compressed and captured generations", async () => {
	const { listPrunableTenantBundles, deleteTenantBundleRow } =
		await import("./tenant-bundles");
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(`CREATE TABLE tenant_bundles (
			id TEXT PRIMARY KEY, slug TEXT, version INTEGER, r2_prefix TEXT, main_module TEXT,
			etag TEXT, modules_json TEXT, source_revision TEXT, is_active INTEGER,
			created_at TEXT, deployed_at TEXT, deployed_by TEXT, summary TEXT
		);`);
		for (let version = 1; version <= 12; version++) {
			sqlite
				.prepare(
					"INSERT INTO tenant_bundles (id,slug,version,modules_json,is_active) VALUES (?,?,?,?,?)",
				)
				.run(`a${version}`, "acme", version, "[]", version === 11 ? 1 : 0);
		}
		sqlite.exec(
			"INSERT INTO tenant_bundles (id,slug,version,modules_json,is_active) VALUES ('other','other',1,'[]',1)",
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const evidence = {
			compressedVersions: [2, 3, 4, 5, 6, 7, 8, 9],
			referencedVersions: [1],
		};
		expect(
			(await listPrunableTenantBundles(db, "acme", 5, evidence)).map(
				(b) => b.version,
			),
		).toEqual([2, 3, 4, 10]);
		expect(
			(await listPrunableTenantBundles(db, "acme", 0, evidence)).map(
				(b) => b.version,
			),
		).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(await listPrunableTenantBundles(db, "missing", 5, evidence)).toEqual(
			[],
		);
		expect(await deleteTenantBundleRow(db, "acme", 11)).toBe(false);
		expect(await deleteTenantBundleRow(db, "acme", 12)).toBe(false);
		expect(await deleteTenantBundleRow(db, "acme", 2)).toBe(true);
		expect(await deleteTenantBundleRow(db, "acme", 2)).toBe(false);
		// A rollback that moves active behind the candidate closes the delete guard.
		sqlite.exec(
			"UPDATE tenant_bundles SET is_active = (version = 3) WHERE slug = 'acme'",
		);
		expect(await deleteTenantBundleRow(db, "acme", 4)).toBe(false);
		sqlite.exec("UPDATE tenant_bundles SET is_active = 0 WHERE slug = 'acme'");
		expect(await listPrunableTenantBundles(db, "acme", 5, evidence)).toEqual(
			[],
		);
		expect(await deleteTenantBundleRow(db, "acme", 4)).toBe(false);
	} finally {
		sqlite.close();
	}
});
