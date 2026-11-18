import { describe, expect, it } from "vite-plus/test";
import { createMigratedSqlite } from "./migrated-sqlite";

describe("retired Work tables migration", () => {
	it("removes the tables and every trigger that refers to them while preserving Work writes", () => {
		const db = createMigratedSqlite();
		const retired = [
			"work_milestones",
			"work_milestone_dependencies",
			"work_milestone_items",
			"work_sprints",
			"work_sprint_items",
			"work_item_outbox_events",
			"work_item_inbox_deliveries",
			"work_item_commit_certifications",
			"release_locks",
		];
		const objects = db
			.prepare(
				"SELECT name, sql FROM sqlite_schema WHERE type IN ('table','trigger')",
			)
			.all();
		for (const name of retired) {
			expect(
				objects.filter(
					(row) => row.name === name || String(row.sql).includes(name),
				),
			).toEqual([]);
		}
		db.exec(`INSERT INTO organizations(id,name,slug) VALUES('org','Org','org');
   INSERT INTO projects(id,org_id,key,name,created_at) VALUES('project','org','project','Project','2026-11-18');
   INSERT INTO work_items(id,org_id,project_id,title,admission_spec_revision,created_at) VALUES('work','org','project','Work','r1','2026-11-18');
   INSERT INTO work_item_comments(id,org_id,work_item_id,author_type,body,created_at) VALUES('comment','org','work','system','Hello','2026-11-18');`);
		expect(
			db.prepare("SELECT body FROM work_item_comments WHERE id='comment'").get()
				?.body,
		).toBe("Hello");
		expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
	});
});
