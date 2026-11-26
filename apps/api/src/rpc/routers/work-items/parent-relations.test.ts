import { DatabaseSync } from "node:sqlite";
import { createDbClient } from "@tedix/db/client";
import { organizationMembers } from "@tedix/db/schema/organization-members";
import {
	workItems,
	workEvents,
	workItemRelations,
} from "@tedix/db/schema/work-items";
import { decisionEdges } from "@tedix/db/schema/decision-graph";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { expect, it } from "vite-plus/test";
import type { BaseContext } from "../../orpc";
import {
	setParentProcedure,
	removeRelationProcedure,
} from "./coordination-git";

const id = "11111111-1111-4111-8111-111111111111";
const parent = "22222222-2222-4222-8222-222222222222";
const foreign = "33333333-3333-4333-8333-333333333333";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			workItems,
			workEvents,
			workItemRelations,
			organizationMembers,
			decisionEdges,
		),
	);
	sqlite.exec(
		"INSERT INTO organization_members(id,organization_id,descope_user_id,user_id,email,role,status) VALUES('member','org','subject','user','member@example.test','owner','active')",
	);
	for (const [itemId, orgId] of [
		[id, "org"],
		[parent, "org"],
		[foreign, "other"],
	]) {
		sqlite
			.prepare(
				"INSERT INTO work_items(id,org_id,title,created_at,disposition,version) VALUES(?,?,'Task','2026-11-26','accepted',1)",
			)
			.run(itemId!, orgId!);
	}
	const context = {
		db: createDbClient(createD1Facade(sqlite)),
		organizationId: "org",
		authType: "user",
		user: { sub: "subject" },
		headers: new Headers(),
	} as BaseContext;
	const setParent = (
		parentWorkItemId: string | null,
		expectedWorkItemVersion?: number,
	) =>
		setParentProcedure["~orpc"].handler!({
			input: { id, parentWorkItemId, expectedWorkItemVersion },
			context,
			path: [],
			procedure: setParentProcedure,
			signal: undefined,
			lastEventId: undefined,
		});
	const remove = (relatedWorkItemId: string) =>
		removeRelationProcedure["~orpc"].handler!({
			input: { workItemId: id, relatedWorkItemId, kind: "blocks" },
			context,
			path: [],
			procedure: removeRelationProcedure,
			signal: undefined,
			lastEventId: undefined,
		});
	return { sqlite, setParent, remove };
}

it("refuses cyclic, cross-org and cancelled parents without changing Work; steward edits retain CAS and an event", async () => {
	const { sqlite, setParent } = fixture();
	try {
		sqlite
			.prepare("UPDATE work_items SET parent_work_item_id=? WHERE id=?")
			.run(id, parent);
		await expect(setParent(parent)).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(setParent(foreign)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		sqlite
			.prepare(
				"UPDATE work_items SET parent_work_item_id=NULL, disposition='cancelled' WHERE id=?",
			)
			.run(parent);
		await expect(setParent(parent)).rejects.toThrow("cancelled");
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_events").get()?.n,
		).toBe(0);
		sqlite
			.prepare("UPDATE work_items SET disposition='accepted' WHERE id=?")
			.run(parent);
		sqlite.exec("UPDATE organization_members SET role='member'");
		await expect(setParent(parent)).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		sqlite
			.prepare(
				"UPDATE work_items SET steward_type='user', steward_id='user' WHERE id=?",
			)
			.run(id);
		expect(await setParent(parent, 1)).toMatchObject({
			parentWorkItemId: parent,
			version: 2,
		});
		await expect(setParent(null, 1)).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect(await setParent(null, 2)).toMatchObject({
			parentWorkItemId: null,
			version: 3,
		});
		expect(
			sqlite
				.prepare(
					"SELECT count(*) AS n FROM work_events WHERE event_type='work.parent_changed'",
				)
				.get()?.n,
		).toBe(2);
	} finally {
		sqlite.close();
	}
});

it("refuses cross-org relation removal and unrelated members; either endpoint steward can remove with one event", async () => {
	const { sqlite, remove } = fixture();
	try {
		sqlite
			.prepare(
				"INSERT INTO work_item_relations(id,org_id,from_work_item_id,to_work_item_id,relation_type,created_at) VALUES('relation','org',?,?,'blocks','2026-11-26')",
			)
			.run(id, parent);
		await expect(remove(foreign)).rejects.toMatchObject({ code: "FORBIDDEN" });
		sqlite.exec("UPDATE organization_members SET role='member'");
		await expect(remove(parent)).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_events").get()?.n,
		).toBe(0);
		sqlite
			.prepare(
				"UPDATE work_items SET steward_type='user', steward_id='user' WHERE id=?",
			)
			.run(parent);
		expect(await remove(parent)).toEqual({ removed: true });
		expect(await remove(parent)).toEqual({ removed: false });
		expect(
			sqlite.prepare("SELECT count(*) AS n FROM work_item_relations").get()?.n,
		).toBe(0);
		expect(
			sqlite.prepare("SELECT event_type, actor_id FROM work_events").all(),
		).toEqual([{ event_type: "work.relation_removed", actor_id: "user" }]);
	} finally {
		sqlite.close();
	}
});
