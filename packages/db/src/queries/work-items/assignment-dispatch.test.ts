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
import { acceptWorkItem, updateWorkItemSpecification } from "./crud";
import { hasActivePurposeContext } from "./purpose";

it("acceptance and reassignment atomically preserve the brief, ready dispatch, and leave one receipt per successful change", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(workItems, workEvents, workAttempts, workItemComments));
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,description,created_at,metadata) VALUES(?,?,?,?,?,?)",
		)
		.run(
			"work",
			"org-acme",
			"Fictional guide",
			"Bounded brief",
			"2026-10-18T00:00:00.000Z",
			JSON.stringify({ executor: "claude-code", retained: true }),
		);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const base = {
		orgId: "org-acme",
		workItemId: "work",
		actor: { type: "user" as const, id: "fictional-owner" },
	};
	const accepted = await acceptWorkItem(db, {
		...base,
		acceptanceContract: { version: 1, doneLooksLike: "A summary is recorded" },
	});
	expect(accepted.metadata).toEqual({
		executor: "claude-code",
		retained: true,
		laneDispatch: { state: "ready" },
		laneDispatchReceiptId: expect.any(String),
	});
	expect(accepted.description).toBe("Bounded brief");
	expect(sqlite.prepare("SELECT body FROM work_item_comments").all()).toEqual([
		{ body: expect.stringMatching(/^Dispatched to claude-code at /) },
	]);
	const changed = await updateWorkItemSpecification(db, {
		...base,
		executor: "codex",
		expectedWorkItemVersion: accepted.version,
	});
	expect(changed.metadata?.executor).toBe("codex");
	await expect(
		updateWorkItemSpecification(db, {
			...base,
			executor: "claude-code",
			expectedWorkItemVersion: accepted.version,
		}),
	).rejects.toThrow();
	expect(
		sqlite.prepare("SELECT count(*) AS n FROM work_item_comments").get()?.n,
	).toBe(2);
	expect(sqlite.prepare("SELECT count(*) AS n FROM work_events").get()?.n).toBe(
		2,
	);
	sqlite.close();
});

it("acceptance renews a lapsed operational purpose window so the accepted item is admissible", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(workItems, workEvents, workAttempts, workItemComments));
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,created_at,work_class,purpose_exception_expires_at) VALUES(?,?,?,?,?,?)",
		)
		.run(
			"work",
			"org-acme",
			"Fictional chore filed long ago",
			"2026-10-01T00:00:00.000Z",
			"maintenance",
			"2026-10-08T00:00:00.000Z",
		);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const acceptedAt = "2026-10-21T09:00:00.000Z";
	expect(
		hasActivePurposeContext(
			{
				workClass: "maintenance",
				objectiveId: null,
				purposeExceptionExpiresAt: "2026-10-08T00:00:00.000Z",
			},
			acceptedAt,
		),
	).toBe(false);
	const accepted = await acceptWorkItem(db, {
		orgId: "org-acme",
		workItemId: "work",
		actor: { type: "user", id: "fictional-owner" },
		acceptanceContract: { version: 1, doneLooksLike: "The chore is done" },
		acceptedAt,
	});
	expect(accepted.purposeExceptionExpiresAt).toBe("2026-10-28T09:00:00.000Z");
	expect(hasActivePurposeContext(accepted, acceptedAt)).toBe(true);
	sqlite.close();
});
