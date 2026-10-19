import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { workEvents } from "../../schema/work-items";
import { createD1Facade } from "../../test/d1-facade";
import { canonicalWorkFactoryDdl, schemaDdl } from "../../test/schema-ddl";
import { createWorkItem } from "./crud";
import { isWorkItemCreator } from "./specification-access";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(canonicalWorkFactoryDdl() + schemaDdl(workEvents));
	sqlite.exec(
		"INSERT INTO organizations(id,name,slug) VALUES('org','Org','org')",
	);
	return { sqlite, db: createDbQueryClient(createD1Facade(sqlite)) };
}

it("attributes creation atomically and never trusts caller metadata or a foreign actor", async () => {
	const { db } = fixture();
	await createWorkItem(db, {
		id: "work",
		orgId: "org",
		title: "Task",
		createdBy: { type: "user", id: "member" },
		metadata: { createdBy: "other" },
		createdAt: "2026-10-19T00:00:00Z",
	});
	expect(
		await isWorkItemCreator(db, {
			orgId: "org",
			workItemId: "work",
			userId: "member",
		}),
	).toBe(true);
	expect(
		await isWorkItemCreator(db, {
			orgId: "org",
			workItemId: "work",
			userId: "other",
		}),
	).toBe(false);
	expect(
		await isWorkItemCreator(db, {
			orgId: "foreign",
			workItemId: "work",
			userId: "member",
		}),
	).toBe(false);
});

it("rolls back the Work insert if trusted attribution cannot be recorded", async () => {
	const { sqlite, db } = fixture();
	sqlite.exec(
		"CREATE TRIGGER reject_creation BEFORE INSERT ON work_events BEGIN SELECT RAISE(ABORT,'event unavailable'); END",
	);
	await expect(
		createWorkItem(db, {
			id: "work",
			orgId: "org",
			title: "Task",
			createdBy: { type: "user", id: "member" },
			createdAt: "2026-10-19T00:00:00Z",
		}),
	).rejects.toThrow();
	expect(
		sqlite.prepare("SELECT count(*) AS n FROM work_items").get(),
	).toMatchObject({ n: 0 });
});
