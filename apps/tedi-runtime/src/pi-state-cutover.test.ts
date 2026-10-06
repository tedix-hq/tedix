import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import {
	cutoverHash,
	inventoryPiStateCutover,
	importPiStateCutover,
} from "./pi-state-cutover";

function storage() {
	const db = new Database(":memory:");
	const data = new Map<string, unknown>();
	let writes = 0;
	const sql = {
		exec(query: string, ...bindings: (string | number | null)[]) {
			const values = db.query(query).all(...bindings);
			return {
				toArray: () => values,
				[Symbol.iterator]: () => values[Symbol.iterator](),
			};
		},
	} as unknown as SqlStorage;
	const instance = {
		sql,
		async get(key: string) {
			return data.get(key);
		},
		async list(
			options: { prefix?: string; limit?: number; startAfter?: string } = {},
		) {
			return new Map(
				[...data]
					.sort(([a], [b]) => a.localeCompare(b))
					.filter(
						([key]) =>
							(!options.prefix || key.startsWith(options.prefix)) &&
							(!options.startAfter || key > options.startAfter),
					)
					.slice(0, options.limit ?? 1000),
			);
		},
		async put(key: string | Record<string, unknown>, value?: unknown) {
			writes++;
			if (typeof key === "string") data.set(key, value);
			else for (const [k, v] of Object.entries(key)) data.set(k, v);
		},
	} as unknown as DurableObjectStorage;
	return { db, data, instance, writes: () => writes };
}
{
	const p = storage();
	p.db.run(
		"CREATE TABLE cf_think_submissions (submission_id TEXT, status TEXT, result_status TEXT)",
	);
	p.db.run(
		"INSERT INTO cf_think_submissions VALUES ('done','completed',NULL),('retry','completed','retry')",
	);
	p.db.run(
		"CREATE TABLE cf_agents_task_runs (run_id TEXT, definition TEXT, state TEXT)",
	);
	p.db.run(
		"INSERT INTO cf_agents_task_runs VALUES ('unknown','__cf_internal_chat_turn','unrecognized'),('unrelated','other','running')",
	);
	p.db.run(
		"CREATE TABLE cf_agents_sub_agents (class TEXT, name TEXT, created_at INTEGER)",
	);
	p.db.run(
		"INSERT INTO cf_agents_sub_agents VALUES ('ConversationFacet','populated',1)",
	);
	p.db.run(
		"CREATE TABLE cf_think_scheduled_tasks (task_id TEXT, schedule_id TEXT, next_run_at INTEGER)",
	);
	p.db.run(
		"INSERT INTO cf_think_scheduled_tasks VALUES ('isolate-brain-digest','prior-schedule',12345)",
	);
	const inventory = await inventoryPiStateCutover(p.instance);
	assert.equal(inventory.blocked, true);
	assert.equal(
		inventory.receipts.find((row) => row.id === "done")?.terminal,
		true,
	);
	assert.equal(
		inventory.receipts.find((row) => row.id === "retry")?.terminal,
		false,
	);
	assert.equal(
		inventory.receipts.find((row) => row.id === "unknown")?.terminal,
		false,
	);
	assert.equal(
		inventory.receipts.some((row) => row.id === "unrelated"),
		false,
	);
	assert.deepEqual(inventory.children, [
		{
			className: "ConversationFacet",
			name: "populated",
			identityVersion: null,
			identityName: null,
		},
	]);
	assert.deepEqual(inventory.maintenance, [
		{
			taskId: "isolate-brain-digest",
			scheduleId: "prior-schedule",
			nextRunAt: 12345,
		},
	]);
	assert.equal(p.writes(), 0);
}
{
	const p = storage();
	for (let i = 0; i < 101; i++)
		p.data.set(`__cf_messenger_recovery:${String(i).padStart(3, "0")}`, {
			stage: i === 100 ? "unknown" : "completed",
			secret: "DO-NOT-RETURN",
		});
	p.data.set("pi-image-projection:v1:token", {
		tediId: "tedi",
		orgId: "org",
		url: "tedix-r2://workflow-image/private-key",
		bytes: "PRIVATE-BYTES",
	});
	const before = structuredClone([...p.data]);
	const inventory = await inventoryPiStateCutover(p.instance);
	assert.equal(inventory.receipts.length, 101);
	assert.equal(inventory.blocked, true);
	assert.equal(inventory.privateImages[0]?.scheme, "tedix-r2:");
	assert.doesNotMatch(
		JSON.stringify(inventory),
		/DO-NOT-RETURN|PRIVATE-BYTES|private-key/,
	);
	await assert.rejects(
		importPiStateCutover(p.instance, {
			owner: { tediId: "tedi", orgId: "org" },
			messages: [],
		}),
		/unresolved/,
	);
	assert.deepEqual([...p.data], before);
	assert.equal(p.writes(), 0);
}
{
	const p = storage();
	p.db.run("CREATE TABLE cf_agents_fibers (fiber_id TEXT, status TEXT)");
	p.db.run("INSERT INTO cf_agents_fibers VALUES ('unrecognized','unknown')");
	const inventory = await inventoryPiStateCutover(p.instance);
	assert.equal(inventory.blocked, true);
	assert.equal(inventory.receipts[0]?.source, "schema");
}

{
	const p = storage();
	p.db.run("CREATE TABLE cf_agents_runs (id TEXT, name TEXT)");
	const before = p.db.query("SELECT sql FROM sqlite_master").all();
	const inventory = await inventoryPiStateCutover(p.instance);
	assert.equal(inventory.blocked, false);
	assert.deepEqual(inventory.tables, [{ name: "cf_agents_runs", rows: 0 }]);
	assert.deepEqual(inventory.receipts, []);
	assert.deepEqual(p.db.query("SELECT sql FROM sqlite_master").all(), before);
	assert.equal(p.writes(), 0);
}

{
	const p = storage();
	for (const conversationId of [0, -1, 1.5, Number.NaN]) {
		await assert.rejects(
			importPiStateCutover(p.instance, {
				owner: { tediId: "tedi", orgId: "org" },
				messages: [],
				conversationId,
			}),
			/positive native conversation/,
		);
	}
	assert.equal(p.writes(), 0);
	assert.equal(p.db.query("SELECT name FROM sqlite_master").all().length, 0);
}

{
	const p = storage();
	assert.deepEqual((await inventoryPiStateCutover(p.instance)).storedOwner, {
		tediId: null,
		orgId: null,
		slug: null,
		sessionKey: null,
		unknown: true,
	});
	p.db.run("CREATE TABLE cf_agents_state (id TEXT PRIMARY KEY, state TEXT)");
	for (const value of [
		"{secret-malformed",
		JSON.stringify("secret-string"),
		JSON.stringify({ tediId: 123, orgId: "org", secret: "NEVER-EXPOSE" }),
		JSON.stringify({ tediId: "x".repeat(257), orgId: "org" }),
	]) {
		p.db.run("INSERT OR REPLACE INTO cf_agents_state VALUES (?,?)", [
			"cf_state_row_id",
			value,
		]);
		assert.deepEqual((await inventoryPiStateCutover(p.instance)).storedOwner, {
			tediId: null,
			orgId: null,
			slug: null,
			sessionKey: null,
			unknown: true,
		});
	}
	const state = {
		tediId: "stored-tedi",
		orgId: "stored-org",
		slug: "stored-slug",
		sessionKey: "stored-session",
		messages: ["PRIVATE-CONTENT"],
		config: { token: "NEVER-EXPOSE" },
	};
	p.db.run("INSERT OR REPLACE INTO cf_agents_state VALUES (?,?)", [
		"cf_state_row_id",
		JSON.stringify(state),
	]);
	const owner = (await inventoryPiStateCutover(p.instance)).storedOwner;
	assert.deepEqual(owner, {
		tediId: "stored-tedi",
		orgId: "stored-org",
		slug: "stored-slug",
		sessionKey: "stored-session",
		unknown: false,
	});
	assert.doesNotMatch(
		JSON.stringify(await inventoryPiStateCutover(p.instance)),
		/PRIVATE-CONTENT|NEVER-EXPOSE/,
	);
	assert.equal(p.writes(), 0);
	assert.equal(
		(
			p.db.query("SELECT state FROM cf_agents_state").all()[0] as {
				state: string;
			}
		).state,
		JSON.stringify(state),
	);
}
assert.equal(await cutoverHash({ a: 1 }), await cutoverHash({ a: 1 }));
assert.notEqual(await cutoverHash({ a: 1 }), await cutoverHash({ a: 2 }));
console.log(
	"Cutover metadata inventory, pagination, schema/unknown-state fencing and nonmutation passed",
);
