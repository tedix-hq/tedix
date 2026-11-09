import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { listWorkActivity } from "./activity";

it("backfills event scope and follows inserts and item moves without changing ledger content", async () => {
	const migration = "20261109181953_work_event_feed_scope";
	const sqlite = createMigratedSqlite({
		foreignKeys: false,
		beforeMigration: migration,
	});
	sqlite.exec(`
		INSERT INTO work_items (id, org_id, project_id, objective_id, title, admission_spec_revision, created_at, updated_at)
		VALUES ('item', 'org-example', 'project-old', 'objective-old', 'Example', 'spec-example', '2026-10-01', '2026-10-01'),
		('foreign', 'org-foreign', 'project-old', 'objective-old', 'Foreign', 'spec-example', '2026-10-01', '2026-10-01'),
		('unscoped', 'org-example', NULL, NULL, 'Unscoped', 'spec-example', '2026-10-01', '2026-10-01');
		INSERT INTO work_events (id, org_id, work_item_id, event_type, actor_type, actor_id, payload, occurred_at)
		VALUES ('old', 'org-example', 'item', 'comment', 'system', 'tedix', '{"summary":"kept"}', '2026-10-01'),
		('foreign-event', 'org-foreign', 'foreign', 'comment', 'system', 'tedix', '{}', '2026-10-01'),
		('unscoped-event', 'org-example', 'unscoped', 'comment', 'system', 'tedix', '{}', '2026-10-01');
	`);
	const ledger = () =>
		sqlite
			.prepare(
				"SELECT sequence, id, org_id, work_item_id, payload, occurred_at FROM work_events ORDER BY sequence",
			)
			.all();
	const before = ledger();
	sqlite.exec(
		readFileSync(
			new URL(`../../../drizzle/${migration}/migration.sql`, import.meta.url),
			"utf8",
		),
	);
	expect(ledger()).toEqual(before);
	const scopes = () =>
		sqlite
			.prepare(
				"SELECT id, project_id, objective_id FROM work_events ORDER BY sequence",
			)
			.all();
	expect(scopes()).toEqual([
		{ id: "old", project_id: "project-old", objective_id: "objective-old" },
		{
			id: "foreign-event",
			project_id: "project-old",
			objective_id: "objective-old",
		},
		{ id: "unscoped-event", project_id: null, objective_id: null },
	]);
	// Exercise recursive trigger safety as well as D1's default trigger behavior.
	sqlite.exec("PRAGMA recursive_triggers=ON");
	sqlite.exec(
		"UPDATE work_items SET project_id='project-new', objective_id='objective-new', admission_spec_revision='spec-moved', version=version+1 WHERE org_id='org-example' AND id='item'",
	);
	expect(ledger()).toEqual(before);
	expect(scopes()[0]).toEqual({
		id: "old",
		project_id: "project-new",
		objective_id: "objective-new",
	});
	expect(scopes()[1]).toEqual({
		id: "foreign-event",
		project_id: "project-old",
		objective_id: "objective-old",
	});
	sqlite.exec(`INSERT INTO work_events (id, org_id, work_item_id, event_type, actor_type, actor_id, occurred_at, project_id, objective_id)
		SELECT 'new', org_id, id, 'comment', 'system', 'tedix', '2026-10-02', 'wrong-project', 'wrong-objective' FROM work_items WHERE id='item'`);
	expect(scopes()[3]).toEqual({
		id: "new",
		project_id: "project-new",
		objective_id: "objective-new",
	});
	const db = createDbQueryClient(createD1Facade(sqlite));
	for (const scope of [
		{ projectId: "project-new" },
		{ objectiveId: "objective-new" },
	]) {
		const page = await listWorkActivity(db as never, {
			orgId: "org-example",
			...scope,
		});
		expect(page.events.map((e) => e.id)).toEqual(["new", "old"]);
	}
	expect(
		(
			await listWorkActivity(db as never, {
				orgId: "org-example",
				projectId: "project-old",
			})
		).events,
	).toEqual([]);
	sqlite.exec(
		"UPDATE work_items SET project_id=NULL, objective_id=NULL, admission_spec_revision='spec-unscoped', version=version+1 WHERE org_id='org-example' AND id='item'",
	);
	expect(scopes()[0]).toEqual({
		id: "old",
		project_id: null,
		objective_id: null,
	});
	expect(scopes()[3]).toEqual({
		id: "new",
		project_id: null,
		objective_id: null,
	});
	sqlite.exec("UPDATE work_events SET work_item_id='foreign' WHERE id='new'");
	// A mismatched tenant cannot borrow another tenant's scope even with FKs disabled.
	expect(scopes()[3]).toEqual({
		id: "new",
		project_id: null,
		objective_id: null,
	});
});
