import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { readWorkMapSnapshot } from "./map";

const T0 = "2026-11-05T20:00:00.000Z";
const T1 = "2026-11-05T21:00:00.000Z";

describe("readWorkMapSnapshot", () => {
	it("reads live items with their latest event and comment, epics, child progress and heartbeats in one batch", async () => {
		const sqlite = createMigratedSqlite({ foreignKeys: false });
		sqlite.exec(`
			INSERT INTO organizations(id,name,slug) VALUES('org','Org','org'),('other','Other','other');
			INSERT INTO projects(id,org_id,key,name,status,created_at) VALUES('p1','org','EU','EU','active','${T0}');
		`);
		const item = sqlite.prepare(
			"INSERT INTO work_items(id,org_id,title,disposition,parent_work_item_id,project_id,metadata,created_at,admission_spec_revision) VALUES(?,?,?,?,?,?,?,?,'r1')",
		);
		item.run(
			"epic",
			"org",
			"Epic: EU data layout",
			"accepted",
			null,
			"p1",
			"{}",
			T0,
		);
		item.run("c1", "org", "Seam", "completed", "epic", "p1", "{}", T0);
		item.run("c2", "org", "Speed test", "accepted", "epic", "p1", "{}", T1);
		sqlite.exec(
			"UPDATE work_items SET executor_type='external_agent', executor_id='codex', dispatch_state='held' WHERE id='c2'",
		);
		item.run("c3", "org", "Dropped", "cancelled", "epic", "p1", "{}", T0);
		item.run("x", "other", "Other org", "accepted", null, null, "{}", T0);
		sqlite.exec(`
			INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES
				('e1','org','c2','work.accepted','user','u','{}','${T0}'),
				('e2','org','c2','comment','user','u','{}','${T1}');
			INSERT INTO work_item_comments(id,org_id,work_item_id,author_type,author_id,body,created_at) VALUES
				('k1','org','c2','external_agent','lane','Dispatcher execution held: tests fail','${T1}');
			INSERT INTO dispatcher_health_reports(org_id,reporter_id,executor,lane,running,observed_at,reported_at,slots_in_use,slots_total) VALUES
				('org','mac','supervisor','supervisor',1,'${T1}','${T1}',0,0),
				('other','mac','supervisor','supervisor',1,'${T1}','${T1}',0,0);
		`);
		const db = createDbQueryClient(createD1Facade(sqlite));

		const snapshot = await readWorkMapSnapshot(db, { orgId: "org", now: T1 });

		expect(snapshot.items.map((row) => row.id).sort()).toEqual(["c2", "epic"]);
		expect(snapshot.items.find((row) => row.id === "c2")).toMatchObject({
			parentId: "epic",
			executor: "codex",
			laneState: "held",
			lastEventAt: T1,
			lastEventType: "comment",
			lastComment: "Dispatcher execution held: tests fail",
		});
		expect(snapshot.epics.map((row) => row.id)).toEqual(["epic"]);
		expect(
			Object.fromEntries(
				snapshot.childCounts.map((row) => [row.disposition, row.count]),
			),
		).toEqual({ accepted: 1, cancelled: 1, completed: 1 });
		expect(snapshot.projects.map((row) => row.id)).toEqual(["p1"]);
		expect(snapshot.heartbeats).toHaveLength(1);
	});
});
