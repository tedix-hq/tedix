import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { createD1Facade } from "../test/d1-facade";
import { getNextTenantBundleForCompression } from "./tenant-bundles";

test("compression scan is scoped, ordered, bounded and includes inactive retained versions", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(`CREATE TABLE tenant_bundles (
			id TEXT PRIMARY KEY, slug TEXT, version INTEGER, r2_prefix TEXT, main_module TEXT,
			etag TEXT, modules_json TEXT, source_revision TEXT, is_active INTEGER,
			created_at TEXT, deployed_at TEXT, deployed_by TEXT, summary TEXT
		);
		INSERT INTO tenant_bundles (id, slug, version, modules_json, is_active) VALUES
		('a3', 'acme', 3, '[]', 1), ('a1', 'acme', 1, '[]', 0),
		('a2', 'acme', 2, '[]', 0), ('b1', 'other', 1, '[]', 1);`);
		const db = createDbQueryClient(createD1Facade(sqlite));
		expect(
			await getNextTenantBundleForCompression(db, "acme", 0),
		).toMatchObject({
			bundle: { version: 1, isActive: false },
			total: 3,
			remaining: 3,
		});
		expect(
			await getNextTenantBundleForCompression(db, "acme", 1),
		).toMatchObject({ bundle: { version: 2 }, total: 3, remaining: 2 });
		expect(await getNextTenantBundleForCompression(db, "acme", 3)).toEqual({
			bundle: null,
			total: 3,
			remaining: 0,
		});
		expect(await getNextTenantBundleForCompression(db, "missing", 0)).toEqual({
			bundle: null,
			total: 0,
			remaining: 0,
		});
	} finally {
		sqlite.close();
	}
});
