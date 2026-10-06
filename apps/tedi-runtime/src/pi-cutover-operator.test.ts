import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
const testRuntime: string = "bun:test";
const { mock } = await import(testRuntime);
// Metadata paging must never construct a native Session; native apply is proved
// separately in workerd. Trap the platform-only import in this SQLite test.
mock.module("agents/harness/pi", () => ({
	openPiSessionStore: () => {
		throw new Error("unexpected native Session construction");
	},
}));
const {
	pageCutoverInventory,
	validateAccountingCheckpoint,
	selectCutoverGraphActivation,
} = await import("./pi-cutover-operator");
const db = new Database(":memory:");
db.run("CREATE TABLE cf_agents_state (id TEXT,state TEXT)");
db.run("INSERT INTO cf_agents_state VALUES ('cf_state_row_id',?)", [
	JSON.stringify({ tediId: "tedi", orgId: "org" }),
]);
db.run("CREATE TABLE cf_agents_sub_agents (class TEXT,name TEXT)");
for (let i = 0; i < 1005; i++)
	db.run("INSERT INTO cf_agents_sub_agents VALUES ('ConversationFacet',?)", [
		`synthetic-${i}`,
	]);
const storage = {
	sql: {
		exec(query: string, ...args: (string | number | null)[]) {
			const result = db.query(query).all(...args);
			return { toArray: () => result };
		},
	},
	async get() {
		return undefined;
	},
	async list() {
		return new Map();
	},
} as unknown as DurableObjectStorage;
const first = await pageCutoverInventory(storage, { offset: 0, limit: 200 });
assert.equal(first.counts.children, 1005);
assert.equal(first.inventory.children.length, 200);
let offset = first.nextOffset,
	count = 200;
while (offset !== null) {
	const page = await pageCutoverInventory(storage, {
		offset,
		limit: 200,
		expectedHash: first.hash,
	});
	assert.equal(page.hash, first.hash);
	count += page.inventory.children.length;
	offset = page.nextOffset;
}
assert.equal(count, 1005);
await assert.rejects(
	pageCutoverInventory(storage, { offset: 0, limit: 201 }),
	/invalid page/,
);
await assert.rejects(
	pageCutoverInventory(storage, { offset: -1, limit: 1 }),
	/invalid page/,
);
db.run("INSERT INTO cf_agents_sub_agents VALUES ('ConversationFacet','new')");
await assert.rejects(
	pageCutoverInventory(storage, {
		offset: 200,
		limit: 200,
		expectedHash: first.hash,
	}),
	/inventory changed/,
);
console.log("PASS complete stable paged cutover inventory");

const completed = {
	version: 1,
	runId: "run",
	fault: null,
	attempts: [
		{
			id: "attempt",
			phase: "completed",
			acknowledged: true,
			effectsStarted: true,
			effectsSealed: true,
			usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
		},
	],
};
assert.doesNotThrow(() =>
	validateAccountingCheckpoint("think-accounting:run", completed),
);
assert.doesNotThrow(() =>
	validateAccountingCheckpoint("pi-accounting:run", completed),
);
for (const change of [
	{ phase: "started" },
	{ acknowledged: false },
	{ effectsSealed: false },
	{ usage: null },
	{ usage: { inputTokens: -1, outputTokens: 2, totalTokens: 1 } },
])
	assert.throws(() =>
		validateAccountingCheckpoint("think-accounting:run", {
			...completed,
			attempts: [{ ...completed.attempts[0], ...change }],
		}),
	);
assert.throws(() =>
	validateAccountingCheckpoint("think-accounting:other", completed),
);
assert.throws(() =>
	validateAccountingCheckpoint("think-accounting:run", {
		...completed,
		receiptFault: true,
	}),
);
console.log(
	"PASS accounting transfer validates terminal usage/effect acknowledgments",
);

const selectionPlan = {
	sourceHash: "a".repeat(64),
	sessions: [
		{ id: "", activeLeaf: "latest-default" },
		{ id: "named", activeLeaf: "latest-named" },
	],
	nodes: [{ id: "latest-default" }],
} as unknown as import("./pi-state-cutover-transcript").TranscriptPlan;
const selectionResult = {
	sourceHash: selectionPlan.sourceHash,
	activeConversations: { "": 7, named: 9 },
} as unknown as import("./pi-state-cutover-transcript").TranscriptResult;
assert.equal(
	selectCutoverGraphActivation(selectionPlan, selectionResult, true)
		.conversationId,
	7,
);
assert.equal(
	selectCutoverGraphActivation(selectionPlan, selectionResult, false)
		.conversationId,
	null,
);
assert.throws(
	() =>
		selectCutoverGraphActivation(
			{ ...selectionPlan, sessions: selectionPlan.sessions.slice(1) },
			{ ...selectionResult, activeConversations: { named: 9 } },
			true,
		),
	/default session/,
);
assert.throws(
	() =>
		selectCutoverGraphActivation(
			selectionPlan,
			{ ...selectionResult, activeConversations: { "": 7 } },
			true,
		),
	/mapping missing/,
);
