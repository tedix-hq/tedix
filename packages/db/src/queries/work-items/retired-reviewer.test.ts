import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import {
	workItems,
	workEvents,
	workAttempts,
	workItemComments,
} from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	getWorkItemById,
	listWorkItemsPage,
	updateWorkItemSpecification,
} from "./crud";

it("retains reviewer assignments while omitting their retired stored lease", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(workItems, workEvents, workAttempts, workItemComments));
	sqlite.exec(`INSERT INTO work_items(id,org_id,title,created_at,reviewer_type,reviewer_id,reviewer_lease_expires_at)
		VALUES('work','org','Historical work','2026-11-01T00:00:00.000Z','tedi','old-reviewer','2026-11-02T00:00:00.000Z')`);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const updated = await updateWorkItemSpecification(db, {
		orgId: "org",
		workItemId: "work",
		actor: { type: "user", id: "owner" },
		title: "Current work",
	});
	const item = await getWorkItemById(db, "work", "org");
	const page = await listWorkItemsPage(db, { orgId: "org" });
	for (const row of [item, updated, ...page.data]) {
		expect(row).toMatchObject({ id: "work", title: "Current work" });
		expect(row).toMatchObject({
			reviewerType: "tedi",
			reviewerId: "old-reviewer",
		});
		expect(row).not.toHaveProperty("reviewerLeaseExpiresAt");
	}
	expect(
		sqlite
			.prepare(
				"SELECT reviewer_type,reviewer_id,reviewer_lease_expires_at FROM work_items WHERE id='work'",
			)
			.get(),
	).toEqual({
		reviewer_type: "tedi",
		reviewer_id: "old-reviewer",
		reviewer_lease_expires_at: "2026-11-02T00:00:00.000Z",
	});
	sqlite.close();
});
