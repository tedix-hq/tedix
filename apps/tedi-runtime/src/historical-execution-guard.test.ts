import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { HistoricalExecutionGuard } from "./historical-execution-guard";
import { HistoricalLiabilityCustody } from "./historical-liability-custody";
import { RuntimeAdmission } from "./runtime-admission";
const db = new Database(":memory:"),
	kv = new Map<string, unknown>();
const storage = {
	sql: {
		exec(sql: string, ...values: SqlStorageValue[]) {
			const rows = db
				.query(sql)
				.all(
					...values.map((v) =>
						v instanceof ArrayBuffer ? new Uint8Array(v) : v,
					),
				) as Record<string, SqlStorageValue>[];
			return { toArray: () => rows };
		},
	},
	kv: {
		get: (k: string) => kv.get(k),
		list: (options: SyncKvListOptions = {}) =>
			[...kv]
				.filter(
					([key]) =>
						(options.prefix === undefined || key.startsWith(options.prefix)) &&
						(options.start === undefined ||
							Buffer.compare(Buffer.from(key), Buffer.from(options.start)) >=
								0) &&
						(options.end === undefined ||
							Buffer.compare(Buffer.from(key), Buffer.from(options.end)) < 0) &&
						(options.startAfter === undefined ||
							Buffer.compare(
								Buffer.from(key),
								Buffer.from(options.startAfter),
							) > 0),
				)
				.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
				.slice(0, options.limit)
				.values(),
	},
	transactionSync: <T>(fn: () => T): T =>
		(() => {
			db.run("SAVEPOINT test_transaction");
			try {
				const result = fn();
				db.run("RELEASE test_transaction");
				return result;
			} catch (error) {
				db.run("ROLLBACK TO test_transaction");
				db.run("RELEASE test_transaction");
				throw error;
			}
		})(),
} as unknown as Pick<DurableObjectStorage, "sql" | "kv" | "transactionSync">;

const guard = new HistoricalExecutionGuard(storage, "physical");
// No historical store: do not read or reinterpret older SDK schemas.
storage.sql.exec("CREATE TABLE cf_agents_fibers(old_column TEXT)");
assert.equal(guard.requiresRawStartup(), false);
storage.sql.exec("DROP TABLE cf_agents_fibers");
const owner = { objectId: "physical", tediId: "tedi", orgId: "org" };
new RuntimeAdmission(storage, owner, () => {
	throw new Error("unexpected verifier");
}).initialize({
	operationId: "quarantine",
	state: "quarantined",
	reason: "unknown",
});
storage.sql.exec(
	"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
);
storage.sql.exec(
	"INSERT INTO cf_agents_state VALUES ('cf_state_row_id',?)",
	JSON.stringify(owner),
);
storage.sql.exec(
	"CREATE TABLE cf_agents_workflows(id TEXT PRIMARY KEY,workflow_id TEXT,workflow_name TEXT,status TEXT)",
);
storage.sql.exec(
	"INSERT INTO cf_agents_workflows VALUES ('tracking','old-workflow','CHAT_TURN_WORKFLOW','queued')",
);
storage.sql.exec(
	"CREATE TABLE cf_agents_fibers(fiber_id TEXT PRIMARY KEY,idempotency_key TEXT,status TEXT)",
);
storage.sql.exec(
	"INSERT INTO cf_agents_fibers VALUES ('old-fiber','old-key','interrupted')",
);
kv.set("wfctx:old-workflow", { runId: "old-run" });
let calls = 0;
let getBoundary = () => {};
class Instance {
	constructor(readonly id: string) {}
	private native() {
		assert.ok(this instanceof Instance);
		calls++;
	}
	restart() {
		this.native();
		return Promise.resolve();
	}
	resume() {
		this.native();
		return Promise.resolve();
	}
	sendEvent() {
		this.native();
		return Promise.resolve();
	}
	status() {
		assert.ok(this instanceof Instance);
		return Promise.resolve({ status: "queued" });
	}
	pause() {
		this.native();
		return Promise.resolve();
	}
	terminate() {
		this.native();
		return Promise.resolve();
	}
}
class Binding {
	create(options?: { id?: string }) {
		assert.ok(this instanceof Binding);
		calls++;
		return Promise.resolve(new Instance(options?.id ?? "generated"));
	}
	createBatch(batch: Array<{ id?: string }>) {
		assert.ok(this instanceof Binding);
		calls++;
		return Promise.resolve(batch.map((o) => new Instance(o.id ?? "generated")));
	}
	async get(id: string) {
		assert.ok(this instanceof Binding);
		await Promise.resolve();
		getBoundary();
		return new Instance(id);
	}
}
const native = new Binding(),
	other = {},
	env = { CHAT_TURN_WORKFLOW: native, OTHER: other };
const guarded = guard.environment(env);
assert.equal(env.CHAT_TURN_WORKFLOW, native);
assert.equal(guarded.OTHER, other);
assert.ok(guarded.CHAT_TURN_WORKFLOW instanceof Binding);
await guarded.CHAT_TURN_WORKFLOW.create({ id: "fresh" });
const custody = new HistoricalLiabilityCustody(storage, "physical"),
	input = { expectedGeneration: 1 };
getBoundary = () => {
	const source = custody.inspectSnapshot(input);
	custody.captureSnapshot({ ...input, expectedSourceHash: source.sourceHash });
	getBoundary = () => {};
};
const oldInstance = await guarded.CHAT_TURN_WORKFLOW.get("old-workflow");
const before = calls;
await assert.rejects(
	() => guarded.CHAT_TURN_WORKFLOW.create({ id: "old-workflow" }),
	/permanently sealed/,
);
await assert.rejects(
	() =>
		guarded.CHAT_TURN_WORKFLOW.createBatch([
			{ id: "fresh2" },
			{ id: "old-workflow" },
		]),
	/permanently sealed/,
);
await assert.rejects(
	() =>
		guard
			.environment({
				CHAT_TURN_WORKFLOW: native as unknown as Workflow<unknown>,
			})
			.CHAT_TURN_WORKFLOW.create({
				id: "fresh3",
				params: { runId: "old-run" },
			}),
	/permanently sealed/,
);
for (let i = 0; i < 2; i++)
	for (const fn of [
		() => oldInstance.restart(),
		() => oldInstance.resume(),
		() => oldInstance.sendEvent(),
	])
		await assert.rejects(fn, /permanently sealed/);
assert.equal(calls, before);
assert.deepEqual(await oldInstance.status(), { status: "queued" });
await oldInstance.pause();
await oldInstance.terminate();
assert.throws(() => guard.startFiber("old-fiber"), /permanently sealed/);
assert.throws(
	() => guard.startFiber(undefined, "old-key"),
	/permanently sealed/,
);
let callback = 0;
const fn = guard.fiber(async () => {
	callback++;
});
assert.throws(
	() =>
		fn({
			id: "old-fiber",
			signal: new AbortController().signal,
			stash() {},
			snapshot: null,
		}),
	/permanently sealed/,
);
await fn({
	id: "new-fiber",
	signal: new AbortController().signal,
	stash() {},
	snapshot: null,
});
assert.equal(callback, 1);
assert.equal(guard.requiresRawStartup(), true);
assert.throws(() => guard.assertRun("old-run"), /permanently sealed/);
assert.equal(custody.hasSnapshot(), true);
custody.assertNotSealedAll([]);
storage.sql.exec(
	"DELETE FROM historical_replay_seals WHERE identity=(SELECT identity FROM historical_replay_seals LIMIT 1)",
);
assert.throws(() => custody.assertNotSealedAll([]), /compact links/);
assert.equal(guard.requiresRawStartup(), true);
console.log("historical execution guard source assertions passed");
