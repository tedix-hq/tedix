import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import {
	planPiTranscriptCutover,
	projectedTranscriptContext,
} from "./pi-state-cutover-transcript";
const db = new Database(":memory:"),
	kv = new Map<string, unknown>();
let writes = 0;
const storage = {
	sql: {
		exec(query: string, ...args: (string | number | null)[]) {
			const result = db.query(query).all(...args);
			return {
				toArray: () => result,
				[Symbol.iterator]: () => result[Symbol.iterator](),
			};
		},
	},
	async get(id: string) {
		return kv.get(id);
	},
	async put() {
		writes++;
	},
	async list({ prefix = "" }: { prefix?: string } = {}) {
		return new Map([...kv].filter(([id]) => id.startsWith(prefix)));
	},
} as unknown as DurableObjectStorage;
db.run("CREATE TABLE cf_agents_state (id TEXT, state TEXT)");
db.run("INSERT INTO cf_agents_state VALUES ('cf_state_row_id',?)", [
	JSON.stringify({ tediId: "tedi", orgId: "org", secret: "not projected" }),
]);
db.run(
	"CREATE TABLE cf_agents_session_messages (session_id TEXT,id TEXT,seq INTEGER,parent_id TEXT,role TEXT,content TEXT,content_chunks INTEGER,created_at INTEGER)",
);
db.run(
	"CREATE TABLE cf_agents_session_message_chunks (session_id TEXT,id TEXT,idx INTEGER,content TEXT)",
);
db.run(
	"CREATE TABLE cf_agents_session_compactions (session_id TEXT,id TEXT,seq INTEGER,from_message_id TEXT,to_message_id TEXT,summary TEXT,created_at INTEGER)",
);
for (const [id, seq, parent] of [
	["root", 1, null],
	["a", 2, "root"],
	["b", 3, "a"],
	["c", 4, "a"],
	["d", 5, "c"],
	["e", 6, "c"],
] as const) {
	const content = JSON.stringify({
		id,
		role: "user",
		parts: [{ type: "text", text: id }],
	});
	db.run("INSERT INTO cf_agents_session_messages VALUES ('',?,?,?,?,?,?,?)", [
		id,
		seq,
		parent,
		"user",
		id === "a" ? content.slice(0, 20) : content,
		id === "a" ? 1 : 0,
		1000,
	]);
	if (id === "a")
		db.run("INSERT INTO cf_agents_session_message_chunks VALUES ('',?,0,?)", [
			id,
			content.slice(20),
		]);
}
db.run(
	"INSERT INTO cf_agents_session_compactions VALUES ('','summary',1,'root','a','shared summary',1000)",
);
const before = db.query("SELECT * FROM cf_agents_session_messages").all();
const plan = await planPiTranscriptCutover(storage, {
	tediId: "tedi",
	orgId: "org",
});
assert.deepEqual(plan.sessions[0]?.leaves, ["b", "d", "e"]);
assert.equal(plan.sessions[0]?.activeLeaf, "e");
assert.equal(plan.nodes.length, 6);
assert.equal(plan.imagePolicy, "current-turn");
assert.match(
	plan.chunks.map((chunk) => chunk.text).join(""),
	/"imagePolicy":"current-turn"/,
);
assert.match(
	JSON.stringify(projectedTranscriptContext(plan, "", "b")),
	/shared summary/,
);
assert.doesNotMatch(
	JSON.stringify(projectedTranscriptContext(plan, "", "b")),
	/"text":"c"/,
);
assert.deepEqual(
	db.query("SELECT * FROM cf_agents_session_messages").all(),
	before,
);
assert.equal(writes, 0);
await assert.rejects(
	planPiTranscriptCutover(storage, { tediId: "foreign", orgId: "org" }),
	/ownership/,
);
db.run("UPDATE cf_agents_session_messages SET parent_id='e' WHERE id='root'");
await assert.rejects(
	planPiTranscriptCutover(storage, { tediId: "tedi", orgId: "org" }),
	/cyclic|cycle/,
);
db.run("UPDATE cf_agents_session_messages SET parent_id=NULL WHERE id='root'");
db.run("DELETE FROM cf_agents_session_message_chunks");
await assert.rejects(
	planPiTranscriptCutover(storage, { tediId: "tedi", orgId: "org" }),
	/missing message chunks/,
);
assert.equal(writes, 0);
console.log(
	"Raw graph ownership, inactive branches, compaction projection, chunk hydration and fail-closed read-only admission passed",
);
