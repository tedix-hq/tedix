import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { workItems, workEvents } from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { updateWorkItemSpecification } from "./crud";

it("fences date updates, preserves omitted dates and audits clearing without lifecycle changes", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(workItems, workEvents));
	sqlite.exec(
		"INSERT INTO work_items(id,org_id,title,disposition,created_at) VALUES('work','org','Plan','proposed','2026-10-01T00:00:00.000Z')",
	);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const input = {
		orgId: "org",
		workItemId: "work",
		actor: { type: "user" as const, id: "owner" },
	};
	const updated = await updateWorkItemSpecification(db, {
		...input,
		expectedWorkItemVersion: 1,
		dueDate: "2026-10-20",
	});
	expect(updated.dueDate).toBe("2026-10-20");
	expect(updated.disposition).toBe("proposed");
	await expect(
		updateWorkItemSpecification(db, {
			...input,
			expectedWorkItemVersion: 1,
			dueDate: "2026-11-20",
		}),
	).rejects.toThrow();
	await expect(
		updateWorkItemSpecification(db, {
			...input,
			orgId: "other",
			dueDate: null,
		}),
	).rejects.toThrow();
	const preserved = await updateWorkItemSpecification(db, {
		...input,
		title: "Updated plan",
	});
	expect(preserved.dueDate).toBe("2026-10-20");
	const cleared = await updateWorkItemSpecification(db, {
		...input,
		dueDate: null,
	});
	expect(cleared.dueDate).toBeNull();
	expect(cleared.disposition).toBe("proposed");
	expect(
		sqlite.prepare("SELECT count(*) AS count FROM work_events").get()?.count,
	).toBe(3);
	sqlite.close();
});
