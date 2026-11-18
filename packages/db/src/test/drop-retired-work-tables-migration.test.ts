import { readFileSync } from "node:fs";
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

	it("restores release_locks with its original columns, idempotently", () => {
		const db = createMigratedSqlite();
		const columns = () =>
			db
				.prepare("PRAGMA table_info(release_locks)")
				.all()
				.map((column) => [column.name, column.type, column.notnull, column.pk]);
		const expected = [
			["surface", "TEXT", 0, 1],
			["owner_token", "TEXT", 1, 0],
			["target_sha", "TEXT", 1, 0],
			["started_at", "INTEGER", 1, 0],
			["github_run_id", "TEXT", 0, 0],
			["github_job_id", "TEXT", 0, 0],
		];
		expect(columns()).toEqual(expected);
		db.exec(
			readFileSync(
				new URL(
					"../../drizzle/20261118083839_restore_release_locks/migration.sql",
					import.meta.url,
				),
				"utf8",
			),
		);
		expect(columns()).toEqual(expected);
	});
});
