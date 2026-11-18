import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { workInteractions } from "../../schema/work-factory";
import { schemaDdl } from "../../test/schema-ddl";

it("seeks interaction sources by organization and state and recomputes metadata updates", () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(schemaDdl(workInteractions));
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(`INSERT INTO work_interactions
			(id, org_id, work_item_id, kind, subject, prompt, creator_type, creator_id, created_at, metadata)
			VALUES ('one', 'org', 'work', 'question', 'Status', '?', 'system', 'example', '2026-11-18', '{"source":"commitment_followup"}'),
			('missing', 'org', 'work', 'question', 'Status', '?', 'system', 'example', '2026-11-18', '{}')`);
		const query =
			"SELECT id FROM work_interactions WHERE org_id=? AND source=? AND status=? ORDER BY created_at";
		expect(
			sqlite.prepare(query).all("org", "commitment_followup", "open"),
		).toEqual([{ id: "one" }]);
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all("org", "commitment_followup", "open")
			.map((row) => String(row.detail));
		expect(plan).toContainEqual(
			expect.stringContaining(
				"USING INDEX idx_work_interactions_source_status_org (source=? AND status=? AND org_id=?)",
			),
		);
		expect(plan.some((row) => row.includes("TEMP B-TREE"))).toBe(false);
		expect(
			sqlite
				.prepare(
					"EXPLAIN QUERY PLAN SELECT id FROM work_interactions WHERE source=? AND status=?",
				)
				.all("commitment_followup", "open")
				.map((row) => String(row.detail)),
		).toContainEqual(
			expect.stringContaining(
				"USING INDEX idx_work_interactions_source_status_org (source=? AND status=?)",
			),
		);
		sqlite.exec(
			`UPDATE work_interactions SET metadata='{"source":"support-draft"}' WHERE id='one'`,
		);
		expect(
			sqlite.prepare(query).all("org", "commitment_followup", "open"),
		).toEqual([]);
		expect(sqlite.prepare(query).all("org", "support-draft", "open")).toEqual([
			{ id: "one" },
		]);
		expect(
			sqlite
				.prepare("SELECT source FROM work_interactions WHERE id='missing'")
				.get()?.source,
		).toBeNull();
	} finally {
		sqlite.close();
	}
});
