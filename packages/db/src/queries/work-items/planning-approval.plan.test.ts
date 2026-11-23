import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { workEvents, workItems, type WorkItem } from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { hasOwnerWorkDelegation } from "./planning-approval";

it("reads only an item's lifecycle events for owner delegation", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys=OFF");
		for (const table of [workItems, workEvents]) sqlite.exec(schemaDdl(table));
		let query = "";
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (statement) => {
					query = statement;
				},
			}),
		);
		await hasOwnerWorkDelegation(
			db,
			{
				orgId: "org-example",
				id: "item-example",
				version: 1,
				admissionSpecRevision: "rev",
				accountableOwnerType: "user",
				accountableOwnerId: "owner",
			} as WorkItem,
			"2026-11-23T15:00:00.000Z",
		);
		const params = Array.from(
			{ length: (query.match(/\?/g) ?? []).length },
			() => "org-example",
		);
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...params)
			.map((row) => String(row.detail))
			.join(" | ");
		expect(plan).toContain(
			"SEARCH delegation USING INDEX idx_work_events_item_lifecycle",
		);
		expect(plan).not.toContain("idx_work_events_item_sequence");
	} finally {
		sqlite.close();
	}
});
