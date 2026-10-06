import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { HistoricalLiabilityCustody } from "./historical-liability-custody";
import { HistoricalTrackingRetirement } from "./historical-tracking-retirement";
import { HistoricalExecutionGuard } from "./historical-execution-guard";
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
			return {
				toArray: () => rows,
				[Symbol.iterator]: () => rows[Symbol.iterator](),
			};
		},
	},
	kv: {
		get: (k: string) => kv.get(k),
		list: (
			options: {
				prefix?: string;
				start?: string;
				end?: string;
				startAfter?: string;
				limit?: number;
			} = {},
		) => {
			assert.equal(options.limit, 1, "selected enumeration hydrates one value");
			return Array.from(kv)
				.filter(
					([key]) =>
						(!options.prefix || key.startsWith(options.prefix)) &&
						(!options.start || key >= options.start) &&
						(!options.end || key < options.end) &&
						(!options.startAfter || key > options.startAfter),
				)
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
				.slice(0, options.limit)
				[Symbol.iterator]();
		},
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

const objectId = "a".repeat(64),
	owner = {
		objectId,
		tediId: "00000000-0000-4000-8000-000000000003",
		orgId: "00000000-0000-4000-8000-000000000004",
	};
function fixture(runId = "fiber") {
	for (const row of db
		.query("SELECT name FROM sqlite_master WHERE type='table'")
		.all() as { name: string }[])
		db.run(`DROP TABLE ${row.name}`);
	kv.clear();
	new RuntimeAdmission(storage, owner, () => {
		throw new Error("unexpected verifier");
	}).initialize({
		operationId: "hold",
		state: "quarantined",
		reason: "unknown",
	});
	storage.sql.exec(
		"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
	);
	storage.sql.exec(
		"INSERT INTO cf_agents_state VALUES('cf_state_row_id',?)",
		JSON.stringify(owner),
	);
	storage.sql.exec(
		"CREATE TABLE cf_agents_workflows(id TEXT PRIMARY KEY,workflow_id TEXT,workflow_name TEXT,status TEXT,metadata TEXT,error_name TEXT,error_message TEXT,created_at INTEGER,updated_at INTEGER,completed_at INTEGER)",
	);
	storage.sql.exec(
		"INSERT INTO cf_agents_workflows(id,workflow_id,workflow_name,status) VALUES('row','provider','CHAT_TURN_WORKFLOW','queued')",
	);
	storage.sql.exec(
		"CREATE TABLE cf_agents_fibers(fiber_id TEXT PRIMARY KEY,idempotency_key TEXT,name TEXT,status TEXT,snapshot TEXT,metadata_json TEXT,error_message TEXT,created_at INTEGER,started_at INTEGER,completed_at INTEGER)",
	);
	storage.sql.exec(
		"INSERT INTO cf_agents_fibers(fiber_id,idempotency_key,name,status) VALUES('fiber','key','old','interrupted')",
	);
	storage.sql.exec(
		"CREATE TABLE cf_agents_runs(id TEXT PRIMARY KEY,name TEXT,snapshot TEXT,created_at INTEGER,completed_at INTEGER,outcome TEXT,error_message TEXT)",
	);
	storage.sql.exec(
		"INSERT INTO cf_agents_runs(id,name,snapshot,created_at) VALUES(?,'old',?,123)",
		runId,
		JSON.stringify({ private: "original" }),
	);
	kv.set("wfctx:provider", { runId: "run-original" });
	kv.set("think-accounting:unknown", {
		reserved: 123,
		measurement: null,
		private: new Uint8Array([0, 255]),
	});
	const archive = new HistoricalLiabilityCustody(storage, objectId),
		summary = archive.inspectSnapshot({ expectedGeneration: 1 });
	archive.captureSnapshot({
		expectedGeneration: 1,
		expectedSourceHash: summary.sourceHash,
	});
	return {
		archive,
		summary,
		input: {
			operationId: "retire",
			expectedGeneration: 1,
			snapshotId: summary.snapshotId,
			sourceHash: summary.sourceHash,
		},
		retirement: new HistoricalTrackingRetirement(storage, objectId),
	};
}
const tableRows = (table: string) =>
	storage.sql.exec(`SELECT * FROM ${table}`).toArray();
let f = fixture();
const archived = tableRows("historical_custody_parts"),
	facts = structuredClone(kv.get("think-accounting:unknown"));
const receipt = f.retirement.retire(f.input);
assert.equal(receipt.workflowCount, 1);
assert.equal(receipt.fiberCount, 1);
assert.equal(receipt.runCount, 1);
for (const table of [
	"cf_agents_workflows",
	"cf_agents_fibers",
	"cf_agents_runs",
])
	assert.deepEqual(tableRows(table), []);
assert.deepEqual(tableRows("historical_custody_parts"), archived);
assert.deepEqual(kv.get("think-accounting:unknown"), facts);
assert.deepEqual(f.archive.audit(), f.summary);
assert.deepEqual(
	new HistoricalTrackingRetirement(storage, objectId).retire(f.input),
	receipt,
);
assert.throws(() =>
	f.archive.captureSnapshot({
		expectedGeneration: 1,
		expectedSourceHash: f.summary.sourceHash,
	}),
);
for (const id of [
	{ kind: "workflow", binding: "CHAT_TURN_WORKFLOW", id: "provider" },
	{ kind: "fiber", id: "fiber" },
	{ kind: "fiber_key", id: "key" },
	{ kind: "run", id: "run-original" },
] as const)
	assert.throws(() => f.archive.assertNotSealed(id));
assert.equal(
	new HistoricalExecutionGuard(storage, objectId).requiresRawStartup(),
	false,
);
assert.throws(() =>
	f.retirement.retire({ ...f.input, operationId: "different" }),
);
const forged = { ...receipt, runCount: 0 };
storage.sql.exec(
	"UPDATE historical_tracking_retirement SET receipt=?,receipt_hash=?",
	JSON.stringify(forged),
	createHash("sha256").update(JSON.stringify(forged)).digest("hex"),
);
assert.throws(() => f.retirement.retire(f.input));
f = fixture("unmanaged");
assert.throws(() => f.retirement.retire(f.input));
assert.equal(tableRows("cf_agents_runs").length, 1);
f = fixture();
storage.sql.exec("UPDATE cf_agents_workflows SET status='running'");
assert.throws(() => f.retirement.retire(f.input));
f = fixture();
storage.sql.exec(
	"DELETE FROM historical_replay_seals WHERE identity=(SELECT identity FROM historical_replay_seals LIMIT 1)",
);
assert.throws(() => f.retirement.retire(f.input));
for (const sql of [
	"CREATE TABLE cf_agents_jobs(id TEXT); INSERT INTO cf_agents_jobs VALUES('wake')",
	"CREATE TABLE cf_agents_facet_runs(run_id TEXT); INSERT INTO cf_agents_facet_runs VALUES('child')",
	"CREATE TABLE cf_agent_tool_runs(status TEXT); INSERT INTO cf_agent_tool_runs VALUES('running')",
	"CREATE TABLE cf_agents_task_runs(state TEXT,generation TEXT,next_at INTEGER,settled_at INTEGER); INSERT INTO cf_agents_task_runs VALUES('pending',NULL,NULL,NULL)",
	"CREATE TABLE pi_tasks(status TEXT); INSERT INTO pi_tasks VALUES('terminal')",
	"CREATE TABLE cf_think_submissions(status TEXT,result_status TEXT); INSERT INTO cf_think_submissions VALUES('completed','retry')",
]) {
	f = fixture();
	db.run(sql);
	assert.throws(() => f.retirement.retire(f.input));
	assert.equal(tableRows("cf_agents_workflows").length, 1);
}
f = fixture();
const originalExec = storage.sql.exec.bind(storage.sql);
let injected = false;
Object.defineProperty(storage.sql, "exec", {
	configurable: true,
	value: (sql: string, ...values: SqlStorageValue[]) => {
		const result = originalExec(sql, ...values);
		if (
			sql.startsWith("INSERT INTO historical_tracking_retirement") &&
			!injected
		) {
			injected = true;
			originalExec(
				"INSERT INTO cf_agents_runs(id,name,snapshot,created_at) VALUES('fiber','old','late',123)",
			);
		}
		return result;
	},
});
assert.throws(() => f.retirement.retire(f.input));
Object.defineProperty(storage.sql, "exec", {
	configurable: true,
	value: originalExec,
});
assert.equal(injected, true);
assert.equal(
	tableRows("cf_agents_runs")[0]!.snapshot,
	JSON.stringify({ private: "original" }),
);
assert.equal(
	db
		.query(
			"SELECT name FROM sqlite_master WHERE name='historical_tracking_retirement'",
		)
		.all().length,
	0,
);
f = fixture();
f.retirement.retire(f.input);
storage.sql.exec(
	"INSERT INTO cf_agents_runs(id,name,snapshot,created_at) VALUES('fiber','old',NULL,123)",
);
assert.throws(() => f.retirement.retire(f.input));
f = fixture();
const initial = f.retirement.retire(f.input);
kv.set("think-accounting:unknown", { changed: true });
const changed = f.archive.inspectSnapshot({ expectedGeneration: 1 });
const forgedPost = { ...initial, postRetirementSourceHash: changed.sourceHash };
storage.sql.exec(
	"UPDATE historical_tracking_retirement SET receipt=?,receipt_hash=?",
	JSON.stringify(forgedPost),
	createHash("sha256").update(JSON.stringify(forgedPost)).digest("hex"),
);
assert.throws(() => f.retirement.retire(f.input));
f = fixture();
f.retirement.retire(f.input);
storage.sql.exec(
	"ALTER TABLE cf_agents_runs ADD COLUMN unsupported_recovery TEXT",
);
assert.throws(() => f.retirement.retire(f.input));
console.log("Historical tracking retirement source tests passed");

// A new native archive neither rewrites V1 bytes/seals nor supplies its retirement proof.
const { NativeStatePreservation } = await import("./native-state-preservation");
f = fixture();
const oldTables = [
	"historical_custody_snapshot",
	"historical_custody_parts",
	"historical_liability_refs",
	"historical_replay_seals",
];
const oldBytes = oldTables.map(tableRows),
	oldAudit = f.archive.audit();
const nativeIntent = {
	kind: "native-preservation-capture-v1" as const,
	operationId: "native",
	rootId: objectId,
	objectId,
	tediId: owner.tediId,
	orgId: owner.orgId,
	objectName: "original",
	physicalName: "original",
	className: "AgentTediDO",
	targetPath: [],
	generation: 1,
};
const key = Buffer.alloc(32, 7).toString("base64"),
	native = new NativeStatePreservation(
		storage,
		nativeIntent,
		() => {},
		async () => {},
	);
const plan = await native.inspect(key);
assert.equal(plan.legacyArchive.state, "present");
const saved = await native.capture(key, plan.archiveId, plan.proof);
assert.deepEqual(await native.audit(key, plan.archiveId), saved);
assert.deepEqual(oldTables.map(tableRows), oldBytes);
assert.deepEqual(f.archive.audit(), oldAudit);
assert.throws(() =>
	f.retirement.retire({
		...f.input,
		snapshotId: plan.archiveId,
		sourceHash: plan.metadataDigest,
	}),
);
// Even a changed old replay seal with the same old public summary must invalidate the plan.
f = fixture();
const sealPlan = await new NativeStatePreservation(
	storage,
	nativeIntent,
	() => {},
	async () => {},
).inspect(key);
storage.sql.exec(
	"UPDATE historical_replay_seals SET link_hash=?",
	"b".repeat(64),
);
await assert.rejects(
	new NativeStatePreservation(
		storage,
		nativeIntent,
		() => {},
		async () => {},
	).capture(key, sealPlan.archiveId, sealPlan.proof),
);
assert.equal(
	db
		.query(
			"SELECT name FROM sqlite_master WHERE name='native_preservation_snapshot'",
		)
		.all()[0] ?? null,
	null,
);
