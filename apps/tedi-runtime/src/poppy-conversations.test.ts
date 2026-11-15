import assert from "node:assert/strict";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { Database } from "bun:sqlite";
import {
	PoppyConversations,
	type PoppySql,
	type PoppyReply,
} from "./poppy-conversations";
import { handlePoppyRuntime, poppyTurn, PoppyRuntime } from "./poppy-runtime";

const db = new Database(":memory:");
const sql: PoppySql = {
	exec<T>(query: string, ...values: SqlStorageValue[]) {
		const rows = db.query(query).all(...(values as never[])) as T[];
		return { toArray: () => rows };
	},
};
const atomic = <T>(fn: () => T) => db.transaction(fn)();
let store = new PoppyConversations(sql, atomic);
const owner = {
	organizationId: "org-example",
	clientId: "https://agent.example/client",
	userId: "visitor",
	version: "1.0",
	sessionId: "first",
};
const post = (id: string, text = "Question") => ({
	id,
	message: { author: { type: "agent" }, text },
});
type ReadView = {
	conversation_id: string;
	error: string;
	cursor: string;
	working: boolean;
	handoff: string;
	responder: string;
	closed: boolean;
	has_more: boolean;
	events: Array<{
		id: string;
		type: string;
		message: { id: string; as_of_request?: string; author: { type: string } };
	}>;
};
const view = (receipt: PoppyReply) => receipt.body as ReadView;
const created = store.request(
	owner,
	"POST",
	"",
	post("request1"),
	"Public hours: 9–5.",
);
assert.equal(created.httpStatus, 201);
const cid = view(created).conversation_id as string;
assert.match(cid, /^[A-Za-z0-9_-]{1,256}$/);
assert.equal(view(store.read(owner, cid, null)).working, true);

// Restart against the same SQLite, with a new Session and Agent ID: ownership is client + user.
store = new PoppyConversations(sql, atomic);
const resumedOwner = { ...owner, sessionId: "new", agentId: "another" };
assert.deepEqual(
	store.request(resumedOwner, "POST", "", post("request1")),
	created,
);
assert.equal(
	view(
		store.read(
			{ ...owner, clientId: "https://other.example/client" },
			cid,
			null,
		),
	).error,
	"conversation_not_found",
);
assert.deepEqual(
	store.read({ ...owner, userId: "another" }, cid, null),
	store.read(owner, "missing", null),
);
assert.equal(
	view(store.read({ ...owner, version: "1.1" }, cid, null)).error,
	"version_mismatch",
);
assert.equal(
	view(store.request(owner, "POST", "", post("request1", "Changed"))).error,
	"request_id_conflict",
);
assert.equal(
	view(store.request(owner, "POST", `${cid}/messages`, post("request1"))).error,
	"request_id_conflict",
);
const firstJob = store.nextJob()!;
assert.equal(firstJob.publicInstructions, "Public hours: 9–5.");
const turn = poppyTurn(firstJob);
assert.deepEqual(turn.tools, {});
assert.match(turn.system, /Public hours/);
assert.match(turn.guardedUserText, /<<<external_poppy-conversation>>>/);
assert.equal(turn.freshHistory, true);
store.finish(firstJob, "We open at 9.");
store.finish(firstJob, "Duplicate reply must not appear");
let read = view(store.read(owner, cid, null));
assert.equal(read.working, false);
assert.equal(read.events.length, 2);
assert.equal(read.events[1]!.message.as_of_request, "request1");
const cursor = read.cursor as string;
assert.deepEqual(view(store.read(owner, cid, cursor)), {
	conversation_id: cid,
	events: [],
	cursor,
	has_more: false,
	working: false,
	handoff: "none",
	responder: "agent",
	closed: false,
});
assert.equal(view(store.read(owner, cid, "fake")).error, "invalid_cursor");

// Validate before mutating and roll back all local state if acceptance fails.
const invalidBodies: JsonValue[] = [
	{ id: "bad+id", message: { author: { type: "agent" }, text: "x" } },
	{ id: "empty", message: { author: { type: "agent" } } },
	{ message: { text: "x" } },
];
for (const body of invalidBodies)
	assert.equal(store.request(owner, "POST", "", body).httpStatus, 400);
assert.equal(
	store.request(owner, "POST", `${cid}/handoff`, {
		id: "notaccepted",
		message: post("ignored").message,
	}).httpStatus,
	400,
);
assert.equal(
	store.request(owner, "POST", `${cid}/handoff`, { id: "notaccepted" })
		.httpStatus,
	202,
);
read = view(store.read(owner, cid, cursor));
assert.equal(read.handoff, "pending");
assert.equal(read.responder, "agent");
const desks = store.desks(owner, cid);
assert.equal(desks.length, 1);
store.request(owner, "POST", `${cid}/handoff`, { id: "handoff_again" });
assert.equal(
	store.desks(owner, cid).length,
	1,
	"repeated handoff creates no duplicate desk request",
);
store.humanReply(
	owner,
	cid,
	desks[0]!.interactionId,
	"Alex here. How can I help?",
);
read = view(store.read(owner, cid, cursor));
assert.equal(read.handoff, "none");
assert.equal(read.responder, "human");
assert.equal(read.events.at(-1)!.message.author.type, "human");
assert.equal(read.events.at(-1)!.message.as_of_request, undefined);
store.request(owner, "POST", `${cid}/messages`, post("for_human"));
assert.equal(store.nextJob(), null, "human messages do not run the model");
assert.equal(view(store.read(owner, cid, null)).working, true);
const humanDesk = store.desks(owner, cid).find((d) => d.pending)!;
store.humanReply(owner, cid, humanDesk.interactionId, "I can answer that.");
assert.equal(view(store.read(owner, cid, null)).working, false);

// Direct Conversations pause the parent, retain separate event feeds, and close with it.
const child = view(
	store.request(owner, "POST", "", {
		...post("direct1"),
		parent_conversation_id: cid,
	}),
).conversation_id as string;
assert.notEqual(child, cid);
assert.equal(
	view(store.read(owner, cid, null)).events.at(-1)!.type,
	"direct_opened",
);
assert.equal(
	view(store.read(owner, child, null)).events[0]!.message.id,
	"direct1",
);
assert.equal(
	view(store.request(owner, "POST", `${cid}/messages`, post("blocked"))).error,
	"direct_conversation_open",
);
assert.equal(
	view(
		store.request(owner, "POST", "", {
			...post("direct2"),
			parent_conversation_id: cid,
		}),
	).error,
	"direct_conversation_open",
);
assert.equal(
	view(
		store.request(owner, "POST", "", {
			...post("nested"),
			parent_conversation_id: child,
		}),
	).error,
	"invalid_request",
);
assert.equal(
	view(
		store.request({ ...owner, userId: "stranger" }, "POST", "", {
			...post("foreign"),
			parent_conversation_id: cid,
		}),
	).error,
	"conversation_not_found",
);
store.request(owner, "POST", `${child}/close`, { id: "closechild" });
assert.equal(
	view(store.read(owner, cid, null)).events.at(-1)!.type,
	"direct_closed",
);
assert.deepEqual(
	store.request(owner, "POST", "", {
		...post("direct1"),
		parent_conversation_id: cid,
	}).body,
	{ conversation_id: child },
	"retries of a closed Direct Conversation retain the original receipt",
);
const child2 = view(
	store.request(owner, "POST", "", {
		...post("direct3"),
		parent_conversation_id: cid,
	}),
).conversation_id as string;
store.request(owner, "POST", `${child2}/handoff`, { id: "childhandoff" });
store.request(owner, "POST", `${cid}/close`, { id: "closeparent" });
assert.equal(view(store.read(owner, child2, null)).closed, true);
assert.equal(
	store.desks(owner, cid).every((d) => !d.pending),
	true,
);
assert.equal(store.nextJob(), null);
assert.equal(view(store.read(owner, cid, null)).working, false);
const count = view(store.read(owner, cid, null)).events.length;
assert.equal(
	store.request(owner, "POST", `${cid}/close`, { id: "closeagain" }).httpStatus,
	202,
);
assert.equal(view(store.read(owner, cid, null)).events.length, count);
for (const action of ["messages", "handoff", "handoff/cancel"])
	assert.equal(
		view(
			store.request(
				owner,
				"POST",
				`${cid}/${action}`,
				post(`closed_${action.replaceAll("/", "_")}`),
			),
		).error,
		"conversation_closed",
	);

// Pagination and cursors never leak another conversation's events.
const many = view(store.request(owner, "POST", "", post("many0")))
	.conversation_id as string;
for (let i = 1; i < 105; i++)
	store.request(owner, "POST", `${many}/messages`, post(`many${i}`));
const page = view(store.read(owner, many, null));
assert.equal(page.events.length, 100);
assert.equal(page.has_more, true);
assert.equal(view(store.read(owner, many, page.cursor)).events.length, 5);
assert.equal(view(store.read(owner, many, cursor)).error, "invalid_cursor");

// A long poll returns on durable completion without an extra message and POST retries keep their status.
let kicks = 0;
const base = {
	organizationId: "org-example",
	identity: owner,
	publicInstructions: "Public",
	method: "GET",
	path: `${many}/events`,
	cursor: view(store.read(owner, many, page.cursor)).cursor,
	wait: 1,
	includeEvents: true,
};
const response = await handlePoppyRuntime(
	new Request("https://internal/__internal/poppy", {
		method: "POST",
		body: JSON.stringify(base),
	}),
	{
		organizationId: "org-example",
		store,
		kick: async () => {
			kicks++;
			for (let j = store.nextJob(); j; j = store.nextJob())
				store.finish(j, "Answer");
		},
	},
);
assert.equal(response.status, 200);
assert.equal(
	((await response.json()) as { receipt: { body: ReadView } }).receipt.body
		.working,
	false,
);
assert.equal(kicks, 1);
const foreign = await handlePoppyRuntime(
	new Request("https://internal/__internal/poppy", {
		method: "POST",
		body: JSON.stringify({ ...base, organizationId: "other" }),
	}),
	{
		organizationId: "org-example",
		store,
		kick: async () => {
			throw Error("must not run");
		},
	},
);
assert.equal(foreign.status, 404);
// Queue redrive is deduplicated while active, failures stay pending, and other visitors progress.
const queued: string[] = [];
let failing = "";
const runtime = new PoppyRuntime({
	storage: { sql, transactionSync: atomic } as unknown as DurableObjectStorage,
	organizationId: () => "org-example",
	queue: async (cid) => {
		queued.push(cid);
	},
	run: async (turn) => {
		if (turn.sessionKey === `poppy_${failing}`) throw Error("provider failure");
		return { assistantText: "Queued answer", turnError: null };
	},
});
const failId = view(
	store.request(owner, "POST", "", post("willfail")),
).conversation_id;
const otherId = view(
	store.request(owner, "POST", "", post("willwork")),
).conversation_id;
failing = failId;
await runtime.kick();
await runtime.kick();
assert.deepEqual(queued, [failId, otherId]);
await assert.rejects(runtime.drain(failId), /provider failure/);
await runtime.drain(otherId);
assert.equal(view(store.read(owner, otherId, null)).working, false);
assert.equal(view(store.read(owner, failId, null)).working, true);
failing = "";
await runtime.recover();
await runtime.drain(failId);
assert.equal(view(store.read(owner, failId, null)).working, false);
const contextConversation = view(
	store.request(owner, "POST", "", {
		id: "ctx1",
		message: {
			author: { type: "agent" },
			text: "Question",
			context: { locale: "en", user_available: true },
		},
	}),
).conversation_id;
store.request(owner, "POST", `${contextConversation}/messages`, {
	id: "ctx2",
	message: {
		author: { type: "agent" },
		text: "Next",
		context: { locale: "fr", user_available: null },
	},
});
const contextJob1 = store.nextJob(contextConversation)!;
assert.deepEqual(contextJob1.context, { locale: "en", user_available: true });
store.finish(contextJob1, "First answer");
const contextJob2 = store.nextJob(contextConversation)!;
assert.deepEqual(contextJob2.context, { locale: "fr" });
assert.match(JSON.stringify(contextJob2.history), /First answer/);
assert.deepEqual(
	store.read(
		{ ...owner, organizationId: "another-org" },
		contextConversation,
		null,
	),
	store.read(owner, "missing", null),
);
store.finish(contextJob2, "Next answer");
store.request(owner, "POST", `${contextConversation}/handoff`, {
	id: "context_handoff",
});
const firstCard = store
	.desks(owner, contextConversation)
	.find((desk) => desk.pending)!;
store.request(
	owner,
	"POST",
	`${contextConversation}/messages`,
	post("late_message"),
);
store.humanReply(
	owner,
	contextConversation,
	firstCard.interactionId,
	"I joined before seeing your latest message.",
);
assert.equal(
	store.nextJob(contextConversation),
	null,
	"newer messages wait for the human after joining",
);
assert.equal(view(store.read(owner, contextConversation, null)).working, true);
const laterCard = store
	.desks(owner, contextConversation)
	.find((desk) => desk.pending)!;
store.humanReply(
	owner,
	contextConversation,
	laterCard.interactionId,
	"I read the latest message.",
);
assert.equal(view(store.read(owner, contextConversation, null)).working, false);
db.close();
console.log(
	"Poppy durable ownership, deduplication, events, handoff, Direct Conversations, close, pagination, recovery and public-turn tests passed",
);
