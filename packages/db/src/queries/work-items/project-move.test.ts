import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { workMilestoneItems } from "../../schema/work-factory";
import {
	workAttempts,
	workEvents,
	workItemComments,
	workItems,
} from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { updateWorkItemSpecification } from "./crud";
import { workItemHasMilestoneLinks } from "./milestones";

it("moves Work to another project, audits it, and refuses while a milestone pins it", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			workItems,
			workEvents,
			workAttempts,
			workItemComments,
			workMilestoneItems,
		),
	);
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
		"pinned",
		"org",
		"Pinned",
		"proposed",
		"2026-10-01T00:00:00.000Z",
		"project-a",
		"objective",
		"objective-a",
	);
	sqlite
		.prepare(
			"INSERT INTO work_milestone_items(org_id,milestone_id,work_item_id,created_at) VALUES(?,?,?,?)",
		)
		.run("org", "milestone-a", "pinned", "2026-10-01T00:00:00.000Z");
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

	expect(
		await workItemHasMilestoneLinks(db, { orgId: "org", workItemId: "pinned" }),
	).toBe(true);
	expect(
		await workItemHasMilestoneLinks(db, { orgId: "org", workItemId: "free" }),
	).toBe(false);
	await expect(
		updateWorkItemSpecification(db, {
			orgId: "org",
			workItemId: "pinned",
			actor,
			projectId: "project-b",
		}),
	).rejects.toThrow();
	expect(
		sqlite.prepare("SELECT project_id FROM work_items WHERE id='pinned'").get(),
	).toEqual({ project_id: "project-a" });

	// Naming the current project is not a move and needs no milestone check.
	const same = await updateWorkItemSpecification(db, {
		orgId: "org",
		workItemId: "pinned",
		actor,
		projectId: "project-a",
		title: "Pinned, renamed",
	});
	expect(same.projectId).toBe("project-a");
	sqlite.close();
});
