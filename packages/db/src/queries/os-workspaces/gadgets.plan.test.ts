import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { osGadgetRevisions, osGadgets } from "../../schema/os-workspaces";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { listCardSourceApps } from "./gadgets";

describe("OS gadget list query plans", () => {
	it("reads active apps in creation order without scanning or sorting the gadget table", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
			CREATE TABLE os_workspaces (
				id TEXT PRIMARY KEY NOT NULL,
				organization_id TEXT NOT NULL REFERENCES organizations(id)
			);
		`);
		sqlite.exec(schemaDdl(osGadgets, osGadgetRevisions));

		let query = "";
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare(sql) {
					query = sql;
				},
			}),
		);
		await listCardSourceApps(db, { limit: 500 });

		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
			.map((row) => String(row.detail));
		expect(plan).toContain(
			"SEARCH os_gadgets USING INDEX os_gadgets_status_created_idx (status=?)",
		);
		expect(plan.some((line) => /SCAN os_gadgets/.test(line))).toBe(false);
		expect(plan.some((line) => /TEMP B-TREE/.test(line))).toBe(false);
		sqlite.close();
	});
});
