import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../query-client";
import { decisionEdges } from "../schema/decision-graph";
import { workItems } from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getDeckDecisionContexts } from "./decision-graph";

it("seeks deck edges from the cards and hop nodes instead of scanning the organization", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys=OFF");
		for (const table of [decisionEdges, workItems])
			sqlite.exec(schemaDdl(table));
		let query = "";
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (statement) => {
					query = statement;
				},
			}),
		);
		await getDeckDecisionContexts(db, "org-example", [
			{ id: "card-1", workItemId: "work-1" },
		]);
		const params = Array.from(
			{ length: (query.match(/\?/g) ?? []).length },
			() => "org-example",
		);
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...params)
			.map((row) => String(row.detail));
		// Production statistics also seek the card-to-card join by to_id; the
		// statistics-free local planner may not, so only the hops and the final
		// read are pinned here.
		expect(plan).toContain(
			"SEARCH decision_edges USING INDEX sqlite_autoindex_decision_edges_1 (id=?)",
		);
		const hopSeeks = plan.filter((d) =>
			d.includes("(org_id=? AND from_id=? AND from_kind=? AND kind=?)"),
		);
		expect(hopSeeks.length).toBeGreaterThanOrEqual(5);
		expect(plan.join(" | ")).not.toMatch(/SCAN (decision_edges|matched)\b/);
	} finally {
		sqlite.close();
	}
});
