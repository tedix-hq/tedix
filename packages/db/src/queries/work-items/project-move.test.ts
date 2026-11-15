import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	workAttempts,
	workEvents,
	workItemComments,
	workItems,
} from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { updateWorkItemSpecification } from "./crud";

it("moves Work to another project and audits it", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(workItems, workEvents, workAttempts, workItemComments));
	const insert = sqlite.prepare(
		"INSERT INTO work_items(id,org_id,title,disposition,created_at,project_id,work_class,objective_id) VALUES(?,?,?,?,?,?,?,?)",
	);
	insert.run(
		"free",
		"org",
		"Free",
		"accepted",
		"2026-10-01T00:00:00.000Z",
		"project-a",
		"objective",
		"objective-a",
	);
	insert.run(
		"draft",
		"org",
		"Draft",
		"proposed",
		"2026-10-01T00:00:00.000Z",
		"project-a",
		"objective",
		"objective-a",
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const actor = { type: "user" as const, id: "owner" };

	const moved = await updateWorkItemSpecification(db, {
		orgId: "org",
		workItemId: "free",
		actor,
		projectId: "project-b",
		objectiveId: "objective-b",
	});
	expect(moved.projectId).toBe("project-b");
	expect(moved.objectiveId).toBe("objective-b");
	expect(moved.disposition).toBe("accepted");
	const event = sqlite
		.prepare(
			"SELECT payload FROM work_events WHERE work_item_id='free' AND event_type='work.specification_updated'",
		)
		.get() as { payload: string };
	expect(JSON.parse(event.payload)).toEqual({
		projectMove: { from: "project-a", to: "project-b" },
	});

	const proposed = await updateWorkItemSpecification(db, {
		orgId: "org",
		workItemId: "draft",
		actor,
		projectId: "project-b",
	});
	expect(proposed.projectId).toBe("project-b");
	expect(
		sqlite.prepare("SELECT project_id FROM work_items WHERE id='draft'").get(),
	).toEqual({ project_id: "project-b" });

	// Naming the current project is not a move.
	const same = await updateWorkItemSpecification(db, {
		orgId: "org",
		workItemId: "draft",
		actor,
		projectId: "project-b",
		title: "Draft, renamed",
	});
	expect(same.projectId).toBe("project-b");
	sqlite.close();
});
