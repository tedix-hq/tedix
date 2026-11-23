import { DatabaseSync } from "node:sqlite";
import { sql } from "drizzle-orm";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { workAttempts, workEvents, workItems } from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { rootAttemptBudgetAvailable } from "./child-delegation";

it("finds a root's delegated children through the delegation-root index", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys=OFF");
		for (const table of [workItems, workAttempts, workEvents])
			sqlite.exec(schemaDdl(table));
		let query = "";
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (statement) => {
					query = statement;
				},
			}),
		);
		await db.all(
			sql`SELECT ${rootAttemptBudgetAvailable("org-example", "root-example")} AS available`,
		);
		const params = Array.from(
			{ length: (query.match(/\?/g) ?? []).length },
			() => "org-example",
		);
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...params)
			.map((row) => String(row.detail))
			.join(" | ");
		expect(plan).toContain("idx_work_items_delegation_root");
		expect(plan).not.toMatch(/SCAN delegated\b/);
	} finally {
		sqlite.close();
	}
});
