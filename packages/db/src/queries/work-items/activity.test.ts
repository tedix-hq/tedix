import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { workEvents } from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { listWorkActivity } from "./activity";

function seed(equalTimes = false) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE work_items (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT NOT NULL, disposition TEXT NOT NULL, project_id TEXT, objective_id TEXT, work_kind TEXT NOT NULL);
		CREATE TABLE work_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, org_id TEXT NOT NULL, work_item_id TEXT NOT NULL, attempt_id TEXT, event_type TEXT NOT NULL, actor_type TEXT NOT NULL, actor_id TEXT NOT NULL, actor_session_id TEXT, payload TEXT NOT NULL, occurred_at TEXT NOT NULL);
		INSERT INTO work_items VALUES ('sweep','org','Curation sweep','accepted','proj','docs','coding');
		INSERT INTO work_items VALUES ('other','org','Unrelated work','accepted','proj','other-goal','incident');
		INSERT INTO work_events (id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES
			('e1','org','sweep','attempt.started','external_agent','agent','{}','2026-08-28T04:31:00.000Z'),
			('e2','org','sweep','attempt.settled','external_agent','agent','{}','2026-08-28T04:33:00.000Z'),
			('e3','org','other','attempt.started','external_agent','agent','{}','2026-08-28T04:32:00.000Z');
	`);
	if (equalTimes)
		sqlite.exec(
			"UPDATE work_events SET occurred_at = '2026-08-28T04:33:00.000Z' WHERE id = 'e3'",
		);
	return createDbClient(createD1Facade(sqlite));
}

describe("listWorkActivity", () => {
	it("continues through equal timestamps without duplicates and retains tenant scope", async () => {
		const db = seed(true);
		const first = await listWorkActivity(db, { orgId: "org", limit: 1 });
		const second = await listWorkActivity(db, {
			orgId: "org",
			limit: 1,
			cursor: first.nextCursor!,
		});
		const third = await listWorkActivity(db, {
			orgId: "org",
			limit: 1,
			cursor: second.nextCursor!,
		});
		expect(
			[...first.events, ...second.events, ...third.events].map((e) => e.id),
		).toEqual(["e3", "e2", "e1"]);
		expect(third.nextCursor).toBeNull();
		expect(
			(
				await listWorkActivity(db, {
					orgId: "another-org",
					cursor: first.nextCursor!,
				})
			).events,
		).toEqual([]);
	});
	it("filters the objective before taking the newest event and retains tenant scope", async () => {
		const db = seed();
		const result = await listWorkActivity(db, {
			orgId: "org",
			objectiveId: "other-goal",
			limit: 1,
		});
		expect(result.events.map((event) => event.id)).toEqual(["e3"]);
		expect(result.events[0]?.workItemKind).toBe("incident");
		expect(
			(
				await listWorkActivity(db, {
					orgId: "another-org",
					objectiveId: "other-goal",
				})
			).events,
		).toEqual([]);
	});
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

	it("polls by append sequence across equal and late timestamps without skipping the next page", async () => {
		const db = seed(true);
		const first = await listWorkActivity(db, {
			orgId: "org",
			afterSequence: 0,
			limit: 1,
		});
		expect(first.events.map((e) => e.id)).toEqual(["e1"]);
		expect(first).toMatchObject({
			nextSequence: 1,
			truncated: true,
			nextCursor: null,
		});
		const second = await listWorkActivity(db, {
			orgId: "org",
			afterSequence: first.nextSequence,
			limit: 2,
		});
		expect(second.events.map((e) => e.id)).toEqual(["e2", "e3"]);
		expect(second).toMatchObject({ nextSequence: 3, truncated: false });
		await db.insert(workEvents).values({
			id: "late",
			orgId: "org",
			workItemId: "sweep",
			eventType: "comment",
			actorType: "external_agent",
			actorId: "agent",
			occurredAt: "2026-08-27T00:00:00.000Z",
		});
		const late = await listWorkActivity(db, {
			orgId: "org",
			afterSequence: second.nextSequence,
		});
		expect(late.events.map((e) => e.id)).toEqual(["late"]);
		expect(late.nextSequence).toBe(4);
		const empty = await listWorkActivity(db, {
			orgId: "org",
			afterSequence: late.nextSequence,
		});
		expect(empty).toMatchObject({
			events: [],
			nextSequence: 4,
			truncated: false,
		});
	});

	it("filters before a forward page and keeps another tenant's checkpoint empty", async () => {
		const db = seed();
		const result = await listWorkActivity(db, {
			orgId: "org",
			afterSequence: 0,
			projectId: "proj",
			objectiveId: "other-goal",
			eventTypes: ["attempt.started"],
			limit: 1,
		});
		expect(result.events.map((e) => e.id)).toEqual(["e3"]);
		expect(result).toMatchObject({ nextSequence: 3, truncated: false });
		expect(
			await listWorkActivity(db, {
				orgId: "another-org",
				afterSequence: 0,
			}),
		).toMatchObject({ events: [], nextSequence: 0, truncated: false });
	});
});
