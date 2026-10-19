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
import { updateWorkItemSpecification } from "./crud";

it("fences date updates, preserves omitted dates and audits clearing without lifecycle changes", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(workItems, workEvents, workAttempts, workItemComments));
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
		deadline: "2026-10-20",
	});
	expect(updated.dueDate).toBe("2026-10-20");
	expect(updated.deadline).toBe("2026-10-20");
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
	expect(preserved.deadline).toBe("2026-10-20");
	const cleared = await updateWorkItemSpecification(db, {
		...input,
		dueDate: null,
		deadline: null,
	});
	expect(cleared.dueDate).toBeNull();
	expect(cleared.deadline).toBeNull();
	expect(cleared.disposition).toBe("proposed");
	expect(
		sqlite.prepare("SELECT count(*) AS count FROM work_events").get()?.count,
	).toBe(3);
	sqlite.close();
});

it("stores executor selection without losing other metadata and rejects another tenant", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(workItems, workEvents, workAttempts, workItemComments));
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,disposition,created_at,metadata) VALUES(?,?,?,?,?,?)",
		)
		.run(
			"work",
			"org-acme",
			"A task",
			"accepted",
			"2026-10-01T00:00:00.000Z",
			JSON.stringify({ retained: true }),
		);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const input = {
		orgId: "org-acme",
		workItemId: "work",
		actor: { type: "user" as const, id: "acme-owner" },
		executor: "codex",
	};
	const updated = await updateWorkItemSpecification(db, {
		...input,
		expectedWorkItemVersion: 1,
	});
	expect(updated.metadata).toEqual({
		retained: true,
		executor: "codex",
		laneDispatch: { state: "ready" },
		laneDispatchReceiptId: expect.any(String),
	});
	expect(updated.version).toBe(2);
	await expect(
		updateWorkItemSpecification(db, { ...input, orgId: "org-other" }),
	).rejects.toThrow();
	await expect(
		updateWorkItemSpecification(db, { ...input, expectedWorkItemVersion: 1 }),
	).rejects.toThrow();
	sqlite.close();
});

it("fences dispatch plans against live Attempts and preserves calendar and metadata", async () => {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(workItems, workEvents, workAttempts, workItemComments));
	sqlite
		.prepare(
			"INSERT INTO work_items(id,org_id,title,disposition,created_at,start_at,metadata) VALUES(?,?,?,?,?,?,?)",
		)
		.run(
			"work",
			"org-acme",
			"Queued task",
			"accepted",
			"2026-10-01T00:00:00.000Z",
			"2026-10-20",
			JSON.stringify({ executor: "codex", retained: true }),
		);
	const db = createDbQueryClient(createD1Facade(sqlite));
	const input = {
		orgId: "org-acme",
		workItemId: "work",
		actor: { type: "tedi" as const, id: "acme-lead" },
		updatedAt: "2026-10-17T21:00:00.000Z",
		laneDispatch: { state: "ready" as const, score: 42 },
	};
	sqlite
		.prepare(
			"INSERT INTO work_attempts(id,org_id,work_item_id,executor_type,executor_id,attempt_number,started_at,heartbeat_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
		)
		.run(
			"attempt",
			"org-acme",
			"work",
			"external_agent",
			"acme-agent",
			1,
			"2026-10-17T20:59:00.000Z",
			"2026-10-17T20:59:00.000Z",
			"2026-10-17T21:04:00.000Z",
		);
	await expect(updateWorkItemSpecification(db, input)).rejects.toThrow();
	sqlite.exec("UPDATE work_attempts SET expires_at = NULL");
	await expect(updateWorkItemSpecification(db, input)).rejects.toThrow();
	sqlite.exec(
		"UPDATE work_attempts SET expires_at = '2026-10-17T21:04:00.000Z'",
	);
	expect(sqlite.prepare("SELECT version FROM work_items").get()?.version).toBe(
		1,
	);
	expect(sqlite.prepare("SELECT count(*) AS n FROM work_events").get()?.n).toBe(
		0,
	);
	const updated = await updateWorkItemSpecification(db, {
		...input,
		updatedAt: "2026-10-17T21:05:00.000Z",
		expectedWorkItemVersion: 1,
	});
	expect(updated.metadata).toEqual({
		executor: "codex",
		retained: true,
		laneDispatch: { state: "ready", score: 42 },
		laneDispatchReceiptId: expect.any(String),
	});
	expect(updated.startAt).toBe("2026-10-20");
	await expect(
		updateWorkItemSpecification(db, { ...input, orgId: "org-other" }),
	).rejects.toThrow();
	await expect(
		updateWorkItemSpecification(db, { ...input, expectedWorkItemVersion: 1 }),
	).rejects.toThrow();
	sqlite.close();
});
