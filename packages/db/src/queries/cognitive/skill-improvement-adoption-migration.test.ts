import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";

const migration = readFileSync(
	new URL(
		"../../../drizzle/20261031192409_skill_improvement_adoption/migration.sql",
		import.meta.url,
	),
	"utf8",
);

describe("improvement adoption backfill", () => {
	it("recovers adopted revisions and their existing runs without inventing missing evidence", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(`CREATE TABLE skill_entries (id TEXT PRIMARY KEY, organization_id TEXT, source_skill_id TEXT, lifecycle_state TEXT, tags TEXT, revision_reasoning TEXT, updated_at TEXT);
   CREATE TABLE skill_runs (id TEXT PRIMARY KEY, organization_id TEXT, skill_id TEXT);
   INSERT INTO skill_runs VALUES ('passed-run', 'org-a', 'adopted');`);
		const insert = db.prepare(
			"INSERT INTO skill_entries VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		insert.run(
			"main",
			"org-a",
			null,
			"active",
			null,
			"Workflow improvement adopted activated by user owner after certified run passed-run: Fewer requests\n\nWorkflow improvement missing-run activated by user owner after certified run absent-run: Older reason",
			null,
		);
		const add = (
			id: string,
			org: string,
			source: string,
			state: string,
			tags: string | null,
			reason: string,
		) =>
			insert.run(id, org, source, state, tags, reason, "2026-10-30T10:00:00Z");
		add(
			"adopted",
			"org-a",
			"main",
			"archived",
			'["workflow-improvement"]',
			"Proposal reason\nActivated into canonical skill main revision 5.",
		);
		add(
			"missing-run",
			"org-a",
			"main",
			"archived",
			'["workflow-improvement"]',
			"Activated into canonical skill main revision 3.",
		);
		add(
			"rejected",
			"org-a",
			"main",
			"archived",
			'["workflow-improvement"]',
			"Rejected proposal",
		);
		add(
			"foreign",
			"org-b",
			"main",
			"archived",
			'["workflow-improvement"]',
			"Activated into canonical skill main revision 5.",
		);
		add(
			"wrong-main",
			"org-a",
			"main",
			"archived",
			'["workflow-improvement"]',
			"Activated into canonical skill other revision 5.",
		);
		add(
			"invalid",
			"org-a",
			"main",
			"archived",
			'["workflow-improvement"]',
			"Activated into canonical skill main revision 5oops.",
		);
		add(
			"draft",
			"org-a",
			"main",
			"draft",
			'["workflow-improvement"]',
			"Activated into canonical skill main revision 5.",
		);
		add(
			"copy",
			"org-a",
			"main",
			"archived",
			null,
			"Activated into canonical skill main revision 5.",
		);
		db.exec(migration);
		const adoption = (id: string) => {
			const row = db
				.prepare(
					"SELECT improvement_adoption AS outcome FROM skill_entries WHERE id = ?",
				)
				.get(id) as { outcome: string | null };
			return row.outcome ? JSON.parse(row.outcome) : null;
		};
		expect(adoption("adopted")).toEqual({
			activatedIntoRevision: 5,
			certificationRunId: "passed-run",
			adoptedAt: "2026-10-30T10:00:00Z",
			reason: "Fewer requests",
		});
		expect(adoption("missing-run")).toEqual({
			activatedIntoRevision: 3,
			certificationRunId: null,
			adoptedAt: "2026-10-30T10:00:00Z",
			reason: "Older reason",
		});
		for (const id of [
			"rejected",
			"foreign",
			"wrong-main",
			"invalid",
			"draft",
			"copy",
		])
			expect(adoption(id)).toBeNull();
		expect(db.prepare("SELECT count(*) AS n FROM skill_runs").get()).toEqual({
			n: 1,
		});
		db.close();
	});
});
