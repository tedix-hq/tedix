import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { listRationaleRecords } from "./rationale-records";

describe("maintained rationale totals", () => {
	it("backfills and tracks inserts, duplicate writes, updates and deletes", async () => {
		const seed = `INSERT INTO tedi_rationale_records
			(id,tedi_id,org_id,action,rationale,category,created_at)
			VALUES ('existing','tedi','org-a','action','why','custom','2026-01-01');`;
		const sqlite = createMigratedSqlite({
			transformMigration: (sql, name) =>
				name.endsWith("_main_d1_count_reads")
					? `INSERT INTO organizations (id,name,slug) VALUES ('org-a','Example','example');
					INSERT INTO tedis (id,organization_id,name,slug) VALUES ('tedi','org-a','Example','example');` +
						seed +
						sql
					: sql,
		});
		const db = createDbClient(createD1Facade(sqlite));
		const total = async (orgId: string, category?: string) =>
			(await listRationaleRecords(db, { orgId, category })).total;
		expect(await total("org-a")).toBe(1);
		expect(await total("empty")).toBe(0);
		sqlite.exec(seed.replace("'existing'", "'new'"));
		sqlite.exec(seed.replace("INSERT INTO", "INSERT OR IGNORE INTO"));
		expect(await total("org-a")).toBe(2);
		expect(await total("org-a", "custom")).toBe(2);
		expect(await total("org-a", "other")).toBe(0);
		expect(() =>
			sqlite.exec(
				"UPDATE tedi_rationale_records SET org_id='org-b' WHERE id='new'",
			),
		).toThrow("rationale organization is immutable");
		expect(await total("org-a")).toBe(2);
		expect(await total("org-b")).toBe(0);
		sqlite.exec(
			"UPDATE tedi_rationale_records SET outcome='done' WHERE id='existing'",
		);
		expect(await total("org-a")).toBe(2);
		sqlite.exec("DELETE FROM tedi_rationale_records");
		expect(await total("org-a")).toBe(0);
		expect(await total("org-b")).toBe(0);
		sqlite.exec(seed);
		sqlite.exec("DELETE FROM tedis WHERE id='tedi'");
		expect(await total("org-a")).toBe(0);
		sqlite.exec("DELETE FROM organizations WHERE id='org-a'");
		expect(sqlite.prepare("SELECT * FROM rationale_org_counts").all()).toEqual(
			[],
		);
	});
});
