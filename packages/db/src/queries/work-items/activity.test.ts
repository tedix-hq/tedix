import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { listWorkActivity } from "./activity";

function seed() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE work_items (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, disposition TEXT NOT NULL, project_id TEXT);
		CREATE TABLE work_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL, work_item_id TEXT NOT NULL, attempt_id TEXT, event_type TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, actor_session_id TEXT, payload TEXT NOT NULL, occurred_at TEXT NOT NULL);
		INSERT INTO work_items VALUES ('sweep','org','Curation sweep','accepted','proj');
		INSERT INTO work_items VALUES ('other','org','Unrelated work','accepted','proj');
		INSERT INTO work_events (id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES
			('e1','org','sweep','attempt.started','external_agent','agent','{}','2026-08-28T04:31:00.000Z'),
			('e2','org','sweep','attempt.settled','external_agent','agent','{}','2026-08-28T04:33:00.000Z'),
			('e3','org','other','attempt.started','external_agent','agent','{}','2026-08-28T04:32:00.000Z');
	`);
	return createDbClient(createD1Facade(sqlite));
}

describe("listWorkActivity", () => {
	it("scopes to one Work Item when workItemId is supplied", async () => {
		const db = seed();
		const { events } = await listWorkActivity(db, {
			orgId: "org",
			workItemId: "sweep",
		});
		// The whole point: a per-item audit trail must contain only that item.
		// Before this filter existed the caller got the org-wide feed and could
		// not tell the difference.
		expect(events.map((e) => e.id)).toEqual(["e2", "e1"]);
		expect(events.every((e) => e.workItemId === "sweep")).toBe(true);
	});

	it("still returns the org-wide feed when no item is named", async () => {
		const db = seed();
		const { events } = await listWorkActivity(db, { orgId: "org" });
		expect(events).toHaveLength(3);
	});
});
