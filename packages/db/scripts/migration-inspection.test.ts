import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../src/query-client";
import { createD1Facade } from "../src/test/d1-facade";
import { readD1MigrationInspection } from "../src/queries/migration-inspection";

it("preserves ordered ledger rows and actual foreign-key violations in native envelopes", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(`PRAGMA foreign_keys=OFF;
CREATE TABLE tedix_drizzle_migrations(id INTEGER PRIMARY KEY, name TEXT);
INSERT INTO tedix_drizzle_migrations VALUES (2, 'second/migration.sql'), (1, 'first/migration.sql');
CREATE TABLE parent(id INTEGER PRIMARY KEY);
CREATE TABLE child(parent_id INTEGER REFERENCES parent(id));
INSERT INTO child VALUES (7);`);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const [ledger, foreignKeys] = await readD1MigrationInspection(db);
		expect(ledger.success).toBe(true);
		expect(ledger.results).toEqual([
			{ name: "first/migration.sql" },
			{ name: "second/migration.sql" },
		]);
		expect(foreignKeys.success).toBe(true);
		expect(foreignKeys.results).toEqual([
			{ table: "child", rowid: 1, parent: "parent", fkid: 0 },
		]);
		sqlite.exec("INSERT INTO parent VALUES (7)");
		expect((await readD1MigrationInspection(db))[1].results).toEqual([]);
	} finally {
		sqlite.close();
	}
});
