import { DatabaseSync } from "node:sqlite";
import { createRouterClient } from "@orpc/server";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { workEvents, workAttemptMessages } from "@tedix/db/schema/work-items";
import {
	workInteractions,
	workInteractionResponses,
} from "@tedix/db/schema/work-factory";
import type { BaseContext } from "../../orpc";

const mocks = vi.hoisted(() => ({ item: vi.fn() }));
vi.mock("@tedix/db/queries/work-items/crud", async (original) => ({
	...(await original<typeof import("@tedix/db/queries/work-items/crud")>()),
	getWorkItemById: mocks.item,
}));
import { waitProcedure } from "./wait";

const id = "11111111-1111-4111-8111-111111111111";
const orgId = "22222222-2222-4222-8222-222222222222";
let sqlite: DatabaseSync;
let context: BaseContext;
function client() {
	return createRouterClient({ wait: waitProcedure }, { context });
}
beforeEach(() => {
	sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE organizations (id TEXT PRIMARY KEY);
		CREATE TABLE work_items (id TEXT, org_id TEXT, UNIQUE(org_id,id));
		CREATE TABLE work_attempts (id TEXT PRIMARY KEY, org_id TEXT, work_item_id TEXT);
		CREATE TABLE work_cases (id TEXT, org_id TEXT, UNIQUE(org_id,id));
		CREATE TABLE projects (id TEXT, org_id TEXT, UNIQUE(org_id,id));
	`);
	sqlite.prepare("INSERT INTO organizations VALUES (?)").run(orgId);
	sqlite.prepare("INSERT INTO organizations VALUES (?)").run("other-org");
	for (const [item, org] of [
		[id, orgId],
		["other", orgId],
		[id, "other-org"],
	])
		sqlite.prepare("INSERT INTO work_items VALUES (?,?)").run(item, org);
	sqlite
		.prepare("INSERT INTO work_attempts VALUES ('attempt',?,?)")
		.run(orgId, id);
	sqlite.exec(
		schemaDdl(
			workEvents,
			workAttemptMessages,
			workInteractions,
			workInteractionResponses,
		),
	);
	context = {
		db: createDbClient(createD1Facade(sqlite)),
		env: {},
		headers: new Headers(),
		authType: "apikey",
		organizationId: orgId,
		apiKey: {
			id: "test-key",
			name: "reader",
			organizationId: orgId,
			scopes: ["mcp:work.read"],
		},
	} as BaseContext;
	mocks.item.mockResolvedValue({ id, orgId });
});
afterEach(() => {
	vi.useRealTimers();
	sqlite.close();
});
function event(eventId: string, itemId = id, organization = orgId) {
	sqlite
		.prepare(
			"INSERT INTO work_events(id,org_id,work_item_id,event_type,actor_type,actor_id,payload,occurred_at) VALUES(?,?,?,'work.completed','user','person','{}','2026-11-20T12:00:00Z')",
		)
		.run(eventId, organization, itemId);
}
function response(responseId: string) {
	sqlite
		.prepare(
			"INSERT INTO work_interaction_responses(id,org_id,interaction_id,resolved_request_version,resolution_fence,responder_type,responder_id,body,response_kind,responded_at) VALUES(?,?,'question',1,'fence','user','person','Yes','answer','2026-11-20T12:00:00Z')",
		)
		.run(responseId, orgId);
}
it("one pending call wakes on an answer and its cursor does not replay it", async () => {
	vi.useFakeTimers();
	sqlite
		.prepare(
			"INSERT INTO work_interactions(id,org_id,work_item_id,kind,subject,prompt,target_type,target_id,creator_type,creator_id,created_at) VALUES('question',?,?,'question','Proceed?','Proceed?','user','person','user','person','2026-11-20T12:00:00Z')",
		)
		.run(orgId, id);
	let settled = false;
	const pending = client()
		.wait({ id, timeoutMs: 5000 })
		.then((result) => {
			settled = true;
			return result;
		});
	await vi.advanceTimersByTimeAsync(100);
	expect(settled).toBe(false);
	response("answer");
	await vi.advanceTimersByTimeAsync(1000);
	const result = await pending;
	expect(result).toMatchObject({
		reason: "changed",
		changes: [{ kind: "response", id: "answer", type: "answer" }],
	});
	expect(
		await client().wait({ id, cursor: result.cursor, timeoutMs: 0 }),
	).toMatchObject({ reason: "timeout", changes: [], cursor: result.cursor });
});
it("returns a clear timeout and a reusable cursor after the requested duration", async () => {
	vi.useFakeTimers();
	let settled = false;
	const pending = client()
		.wait({ id, timeoutMs: 1500 })
		.then((result) => {
			settled = true;
			return result;
		});
	await vi.advanceTimersByTimeAsync(1499);
	expect(settled).toBe(false);
	await vi.advanceTimersByTimeAsync(1);
	expect(await pending).toMatchObject({
		reason: "timeout",
		changes: [],
		cursor: { workItemId: id },
	});
});
it("pages all events and messages without skipping changes or crossing tenants", async () => {
	const baseline = await client().wait({ id, timeoutMs: 0 });
	for (let i = 0; i < 101; i++) event(`event-${i}`);
	event("other-task", "other");
	event("other-org", id, "other-org");
	sqlite
		.prepare(
			"INSERT INTO work_attempt_messages(id,org_id,work_item_id,attempt_id,kind,body,sender_type,sender_id,created_at) VALUES('message',?,?,'attempt','follow_up','Continue','user','person','2026-11-20T12:00:00Z')",
		)
		.run(orgId, id);
	const first = await client().wait({
		id,
		cursor: baseline.cursor,
		timeoutMs: 0,
	});
	expect(first.changes).toHaveLength(101);
	expect(first.changes.at(-1)).toEqual({
		kind: "message",
		id: "message",
		type: "follow_up",
	});
	const second = await client().wait({
		id,
		cursor: first.cursor,
		timeoutMs: 0,
	});
	expect(second.changes).toEqual([
		{ kind: "event", id: "event-100", type: "work.completed" },
	]);
});
it("refuses missing read scope, another organization and another task's cursor", async () => {
	context.apiKey!.scopes = ["mcp:work.write"];
	await expect(client().wait({ id, timeoutMs: 0 })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	context.apiKey!.scopes = ["mcp:work.read"];
	mocks.item.mockResolvedValueOnce({ id, orgId: "other-org" });
	await expect(client().wait({ id, timeoutMs: 0 })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await expect(
		client().wait({
			id,
			timeoutMs: 0,
			cursor: { workItemId: orgId, event: 0, message: 0, response: 0 },
		}),
	).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
it("cancels a pending wait without continuing database reads", async () => {
	vi.useFakeTimers();
	const controller = new AbortController();
	const pending = client().wait(
		{ id, timeoutMs: 5000 },
		{ signal: controller.signal },
	);
	const rejection = expect(pending).rejects.toThrow("Cancelled");
	await vi.advanceTimersByTimeAsync(10);
	const reads = mocks.item.mock.calls.length;
	controller.abort(new Error("Cancelled"));
	await rejection;
	await vi.advanceTimersByTimeAsync(5000);
	expect(mocks.item.mock.calls.length).toBe(reads);
});
