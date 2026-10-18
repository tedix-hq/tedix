import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { workInteractions } from "../../schema/work-factory";
import { workEvents } from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../../test/schema-ddl";
import { listWorkActivity } from "./activity";
import { listOrgWorkAttempts } from "./projections";

it("filters a person's Feed before paging, retaining their tasks, requested help and shared work", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		canonicalWorkFactoryDdl() + schemaDdl(workInteractions, workEvents),
	);
	const now = "2026-10-18T01:00:00Z";
	for (const [id, owner, org] of [
		["own", "luz", "org"],
		["other", "river", "org"],
		["needed", "river", "org"],
		["shared", null, "org"],
		["foreign", "luz", "foreign-org"],
	] as const) {
		sqlite
			.prepare(
				"INSERT INTO work_items(id,org_id,title,accountable_owner_type,accountable_owner_id,created_at) VALUES(?,?,?,'user',?,?)",
			)
			.run(id, org, id, owner, now);
		if (owner === null)
			sqlite
				.prepare("UPDATE work_items SET accountable_owner_type=NULL WHERE id=?")
				.run(id);
		sqlite
			.prepare(
				"INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES(?,?,?,'work.completed','user','river','{}',?)",
			)
			.run(id, org, id, now);
		sqlite
			.prepare(
				"INSERT INTO work_attempts(id,org_id,work_item_id,executor_type,executor_id,runtime_state,outcome,attempt_number,started_at,heartbeat_at,finished_at) VALUES(?,?,?,'external_agent','agent','succeeded','succeeded',1,?,?,?)",
			)
			.run(id, org, id, now, now, now);
	}
	sqlite
		.prepare(
			"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,creator_type,creator_id,target_type,target_id,created_at) VALUES('ask','org','needed','question','Your help','Please review','user','river','user','luz',?)",
		)
		.run(now);
	const db = createDbClient(createD1Facade(sqlite));
	try {
		const activity = await listWorkActivity(db, {
			orgId: "org",
			viewerUserId: "luz",
			limit: 2,
		});
		const next = await listWorkActivity(db, {
			orgId: "org",
			viewerUserId: "luz",
			limit: 2,
			cursor: activity.nextCursor!,
		});
		expect(
			[...activity.events, ...next.events].map((row) => row.workItemId).sort(),
		).toEqual(["needed", "own", "shared"]);
		const attempts = await listOrgWorkAttempts(db, {
			orgId: "org",
			viewerUserId: "luz",
			limit: 100,
		});
		expect(attempts.data.map((row) => row.workItem.id).sort()).toEqual([
			"needed",
			"own",
			"shared",
		]);
		expect(
			(
				await listWorkActivity(db, { orgId: "org", viewerUserId: "stranger" })
			).events.map((row) => row.workItemId),
		).toEqual(["shared"]);
	} finally {
		sqlite.close();
	}
});
