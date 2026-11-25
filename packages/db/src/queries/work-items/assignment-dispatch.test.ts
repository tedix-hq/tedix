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
			"INSERT INTO work_items(id,org_id,title,description,created_at,metadata,project_id,accountable_owner_type,accountable_owner_id,executor_type,executor_id) VALUES(?,?,?,?,?,?,'project','user','fictional-owner','external_agent','claude-code')",
		)
		.run(
			"work",
			"org-acme",
			"Fictional guide",
			"Bounded brief",
			"2026-10-18T00:00:00.000Z",
			JSON.stringify({ retained: true }),
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
		retained: true,
		laneDispatchReceiptId: expect.any(String),
	});
	expect(accepted.dispatchState).toBe("ready");
	expect(accepted.description).toBe("Bounded brief");
	expect(sqlite.prepare("SELECT body FROM work_item_comments").all()).toEqual([
		{ body: expect.stringMatching(/^Dispatched to claude-code at /) },
	]);
	const changed = await updateWorkItemSpecification(db, {
		...base,
		executor: "codex",
		expectedWorkItemVersion: accepted.version,
	});
	expect(changed.dispatchState).toBe("ready");
	expect(changed.executorId).toBe("codex");
	expect(changed.executorType).toBe("external_agent");
	// The person's choice holds: the router and failover leave it alone.
	expect(changed.metadata?.onlyExecutor).toBe(true);
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

it("dispatches previously unassigned accepted Work to a human or tedi", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys=OFF");
		sqlite.exec(
			schemaDdl(workItems, workEvents, workAttempts, workItemComments),
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		for (const executor of ["human", "tedi"] as const) {
			sqlite
				.prepare(
					"INSERT INTO work_items(id,org_id,title,disposition,created_at,metadata) VALUES(?,'org','T','accepted','2026-10-18T00:00:00.000Z','{}')",
				)
				.run(executor);
			const updated = await updateWorkItemSpecification(db, {
				orgId: "org",
				workItemId: executor,
				actor: { type: "user", id: "owner" },
				executor,
			});
			expect(updated.dispatchState).toBe("ready");
			expect(updated.executorId).toBe(executor);
		}
	} finally {
		sqlite.close();
	}
});

it("a runner's hold stays until the Work is revised, and the revision makes it ready again", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(workItems, workEvents, workAttempts, workItemComments));
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,disposition,created_at,metadata,project_id,accountable_owner_type,accountable_owner_id,executor_type,executor_id,dispatch_state) VALUES('work','org-acme','Fictional guide','accepted','2026-10-18T00:00:00.000Z',?,'project','user','fictional-owner','external_agent','codex','ready')",
		)
		.run(JSON.stringify({}));
	const db = createDbQueryClient(createD1Facade(sqlite));
	const base = {
		orgId: "org-acme",
		workItemId: "work",
		actor: { type: "user" as const, id: "fictional-owner" },
	};
	const hold = {
		state: "held" as const,
		reason: "3 runs failed on this version of the task.",
		note: "exit 1",
	};
	const held = await updateWorkItemSpecification(db, {
		...base,
		laneDispatch: hold,
	});
	expect(held.dispatchState).toBe("held");
	expect(held.metadata?.laneDispatch).toEqual({
		reason: hold.reason,
		note: hold.note,
	});
	expect(held.version).toBe(2);
	// Recording the hold is bookkeeping: no dispatch receipt, same admission revision.
	expect(
		sqlite.prepare("SELECT count(*) AS n FROM work_item_comments").get()?.n,
	).toBe(0);
	const revised = await updateWorkItemSpecification(db, {
		...base,
		description: "A repaired brief",
	});
	expect(revised.dispatchState).toBe("ready");
	expect(revised.admissionSpecRevision).not.toBe(held.admissionSpecRevision);
	expect(sqlite.prepare("SELECT body FROM work_item_comments").all()).toEqual([
		{ body: expect.stringMatching(/^Dispatched to codex at /) },
	]);
	// A coordinator's hold carries no reason and is left to the coordinator.
	await updateWorkItemSpecification(db, {
		...base,
		laneDispatch: { state: "held" },
	});
	const edited = await updateWorkItemSpecification(db, {
		...base,
		title: "Fictional guide, second edition",
	});
	expect(edited.dispatchState).toBe("held");
	sqlite.close();
});

it("acceptance renews a lapsed operational purpose window so the accepted item is admissible", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(workItems, workEvents, workAttempts, workItemComments));
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,created_at,work_class,purpose_exception_expires_at,project_id,accountable_owner_type,accountable_owner_id) VALUES(?,?,?,?,?,?,'project','user','fictional-owner')",
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
