import { DatabaseSync } from "node:sqlite";
import { it, expect } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { listRankableSkillEntries } from "./skill-crud";
it("revalidates tenant, readability, and lifecycle for rankable IDs on D1", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`CREATE TABLE skill_entries (
				id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, tedi_id TEXT,
				domain_id TEXT, title TEXT NOT NULL, slug TEXT, folder_path TEXT, description TEXT,
				content TEXT NOT NULL, files TEXT, input_schema TEXT,
				success_count INTEGER NOT NULL DEFAULT 0,
				failure_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT,
				avg_duration_ms INTEGER, revision INTEGER NOT NULL DEFAULT 1,
				revision_reasoning TEXT, supersedes_id TEXT, source_skill_id TEXT,
				source_revision INTEGER, visibility TEXT NOT NULL DEFAULT 'private',
				agent_skills_format TEXT, r2_path TEXT, app_id TEXT, tool_ids TEXT,
				summary TEXT, tags TEXT, audience TEXT, preconditions TEXT,
				lifecycle_state TEXT DEFAULT 'draft', review_flagged_at TEXT,
				review_flag_reason TEXT, pace_layer TEXT NOT NULL DEFAULT 'innovation',
				proposed_by_tedi_id TEXT, created_at TEXT, updated_at TEXT
			);
			`);
	const insert = sqlite.prepare(
		"INSERT INTO skill_entries(id,organization_id,tedi_id,title,content,visibility,lifecycle_state) VALUES(?,?,?,?,?,?,?)",
	);
	for (const row of [
		["a", "org", null, "A", "", "org", "active"],
		["b", "org", "tedi", "B", "", "private", "proven"],
		["c", "other", null, "C", "", "org", "active"],
		["d", "org", "other", "D", "", "private", "active"],
		["e", "org", null, "E", "", "org", "draft"],
	])
		insert.run(...row);
	const db = createDbClient(createD1Facade(sqlite));
	expect(
		(
			await listRankableSkillEntries(db, "org", "tedi", [
				"a",
				"b",
				"c",
				"d",
				"e",
			])
		)
			.map((row) => row.id)
			.sort(),
	).toEqual(["a", "b"]);
	await expect(
		listRankableSkillEntries(db, "org", "tedi", Array(41).fill("a")),
	).rejects.toThrow();
	sqlite.close();
});
