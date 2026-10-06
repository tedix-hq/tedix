import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { encryptTediSecret } from "@tedix/db/utils/secrets-encryption";
import { createHash, randomUUID } from "node:crypto";
import {
	SdkStatePreservation,
	SdkPreservationIntentSchema,
} from "./sdk-state-preservation";
import { HistoricalLiabilityCustody } from "./historical-liability-custody";
import { RuntimeAdmission } from "./runtime-admission";
import { NativeStatePreservation } from "./native-state-preservation";
import { SessionStatePreservation } from "./session-state-preservation";
import { compareCutoverWorkflowIds } from "@tedix/api-contract/schemas/tedi";
const KEY = Buffer.alloc(32, 7).toString("base64"),
	ID = "a".repeat(64);
const intent = SdkPreservationIntentSchema.parse({
	kind: "sdk-work-preservation-capture-v1",
	operationId: "original",
	rootId: ID,
	objectId: ID,
	tediId: "00000000-0000-4000-8000-000000000003",
	orgId: "00000000-0000-4000-8000-000000000004",
	objectName: "original",
	physicalName: "original",
	className: "AgentTediDO",
	targetPath: [],
	generation: 1,
});
function fixture() {
	const db = new Database(":memory:") as unknown as {
			exec(sql: string): void;
			transaction<T>(fn: () => T): () => T;
			query(sql: string): {
				all(...values: unknown[]): Record<string, unknown>[];
				get(...values: unknown[]): unknown;
				run(...values: unknown[]): unknown;
			};
		},
		kv = new Map<string, unknown>();
	let writes = 0;
	let inject: ((sql: string) => void) | undefined;
	const storage = {
		sql: {
			exec(sql: string, ...values: SqlStorageValue[]) {
				if (/^(?:CREATE|INSERT|UPDATE|DELETE)/i.test(sql)) writes++;
				inject?.(sql);
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
			list: (q: {
				prefix?: string;
				start?: string;
				end?: string;
				limit: number;
				startAfter?: string;
			}) => {
				assert.equal(q.limit, 1);
				return [...kv]
					.filter(
						([k]) =>
							(!q.prefix || k.startsWith(q.prefix)) &&
							(!q.start || compareCutoverWorkflowIds(k, q.start) >= 0) &&
							(!q.end || compareCutoverWorkflowIds(k, q.end) < 0) &&
							(q.startAfter === undefined ||
								compareCutoverWorkflowIds(k, q.startAfter) > 0),
					)
					.sort(([a], [b]) => compareCutoverWorkflowIds(a, b))
					.slice(0, 1)
					[Symbol.iterator]();
			},
		},
		transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
	} as unknown as Pick<DurableObjectStorage, "sql" | "kv" | "transactionSync">;
	const rawEngine = (recheck = () => {}, verifyCanonical = async () => {}) =>
		new SdkStatePreservation(storage, intent, recheck, verifyCanonical);
	const consume = async <T>(operation: {
		result: Promise<T>;
		assertContinuity: () => void;
		assertReady: () => void;
	}) => {
		let value;
		try {
			value = await operation.result;
		} finally {
			operation.assertContinuity();
		}
		operation.assertReady();
		return value;
	};
	const engine = (recheck = () => {}, verifyCanonical = async () => {}) => {
		const owner = rawEngine(recheck, verifyCanonical);
		return {
			inspect: async (key: string) => consume(owner.inspect(key)),
			capture: async (key: string, id: string, proof: string) =>
				consume(owner.capture(key, id, proof)),
			audit: async (key: string, id: string) => consume(owner.audit(key, id)),
		};
	};
	const present = () =>
		!!db
			.query(
				"SELECT name FROM sqlite_master WHERE name='sdk_work_preservation_snapshot'",
			)
			.get();
	return {
		db,
		kv,
		storage,
		engine,
		rawEngine,
		present,
		get writes() {
			return writes;
		},
		inject: (fn: (sql: string) => void) => {
			inject = fn;
		},
	};
}
let cases = 0;
{
	const f = fixture();
	f.db.exec(
		"CREATE TABLE cf_agents_jobs(id INTEGER PRIMARY KEY,callback TEXT,payload TEXT,attempts INTEGER,status TEXT)",
	);
	f.db
		.query("INSERT INTO cf_agents_jobs VALUES(1,?,?,3,'running')")
		.run("private-callback", "PRIVATE_TOKEN");
	for (const [key, v] of [
		[
			"future-key",
			{
				secret: "PRIVATE_SECRET",
				sparse: Object.assign(Array(2), { 1: undefined }),
				n: -0,
			},
		],
		["\uE000", undefined],
		["\u{10000}", new Uint8Array(500000)],
	])
		f.kv.set(key as string, v);
	const p = await f.engine().inspect(KEY);
	assert.equal(f.writes, 0);
	assert.equal(p.metadata.tables.length, 43);
	assert.equal(p.metadata.kvEntries, 3);
	assert.equal(p.alarmCovered, false);
	assert.equal(p.alarmConsistency, "UNKNOWN");
	assert.ok(!JSON.stringify(p).includes("PRIVATE"));
	const a = await f.engine().capture(KEY, p.archiveId, p.proof);
	assert.deepEqual(await f.engine().audit(KEY, p.archiveId), a);
	assert.deepEqual(await f.engine().capture(KEY, p.archiveId, p.proof), a);
	assert.equal(
		(
			f.db.query("SELECT status FROM cf_agents_jobs WHERE id=1").get() as {
				status: string;
			}
		).status,
		"running",
	);
	cases++;
}
for (const ddl of [
	"CREATE TABLE assistant_fts_data(id INTEGER)",
	"CREATE VIEW cf_agents_jobs AS SELECT 1 AS id",
	"CREATE TABLE cf_agents_jobs(a TEXT,b TEXT GENERATED ALWAYS AS (a) STORED)",
	"CREATE TABLE cf_agents_jobs(a TEXT,b TEXT GENERATED ALWAYS AS (a) VIRTUAL)",
]) {
	const f = fixture();
	f.db.exec(ddl);
	await assert.rejects(f.engine().inspect(KEY));
	assert.equal(f.writes, 0);
	assert.equal(f.present(), false);
	cases++;
}
for (const value of [
	new Date(),
	new Map(),
	BigInt(1),
	new Uint8Array(800000),
	"\n".repeat(600000),
	(() => {
		const o: any = {};
		o.self = o;
		return o;
	})(),
]) {
	const f = fixture();
	f.kv.set("unknown", value);
	await assert.rejects(f.engine().inspect(KEY));
	assert.equal(f.writes, 0);
	assert.equal(f.present(), false);
	cases++;
}
for (const mutation of ["kv", "source", "schema", "owner"]) {
	const f = fixture();
	f.db.exec("CREATE TABLE cf_agents_jobs(id INTEGER PRIMARY KEY,payload TEXT)");
	f.db.exec("INSERT INTO cf_agents_jobs VALUES(1,'original')");
	const p = await f.engine().inspect(KEY);
	await assert.rejects(
		f
			.engine(
				() => {},
				async () => {
					if (mutation === "kv") f.kv.set("appeared", undefined);
					else if (mutation === "source")
						f.db.exec("UPDATE cf_agents_jobs SET payload='changed'");
					else if (mutation === "schema")
						f.db.exec("CREATE TABLE unrelated(id INTEGER)");
					else throw Error("canonical changed");
				},
			)
			.capture(KEY, p.archiveId, p.proof),
	);
	assert.equal(f.present(), false);
	cases++;
}
{
	const f = fixture();
	const p = await f.engine().inspect(KEY);
	const now = Date.now;
	try {
		await assert.rejects(
			f
				.engine(
					() => {},
					async () => {
						Date.now = () => now() + 300001;
					},
				)
				.capture(KEY, p.archiveId, p.proof),
		);
		assert.equal(f.present(), false);
	} finally {
		Date.now = now;
	}
	cases++;
}
{
	const f = fixture();
	f.kv.set("present-undefined", undefined);
	const p = await f.engine().inspect(KEY);
	f.kv.delete("present-undefined");
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	assert.equal(f.present(), false);
	cases++;
}
for (const at of ["part", "header"]) {
	const f = fixture();
	const p = await f.engine().inspect(KEY);
	f.inject((q) => {
		if (
			q.startsWith(
				at === "part"
					? "INSERT INTO sdk_work_preservation_parts"
					: "INSERT INTO sdk_work_preservation_snapshot",
			)
		)
			throw Error("synthetic SQL failure");
	});
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	assert.equal(f.present(), false);
	cases++;
}
{
	const f = fixture();
	f.db.exec("CREATE TABLE cf_agents_jobs(id INTEGER PRIMARY KEY,payload TEXT)");
	f.db.exec("INSERT INTO cf_agents_jobs VALUES(1,'original')");
	const p = await f.engine().inspect(KEY);
	let done = false;
	f.inject((q) => {
		if (!done && q.startsWith("INSERT INTO sdk_work_preservation_parts")) {
			done = true;
			f.db.exec(
				"UPDATE cf_agents_jobs SET payload='mutated inside transaction'",
			);
		}
	});
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	assert.equal(f.present(), false);
	assert.equal(
		(
			f.db.query("SELECT payload FROM cf_agents_jobs").get() as {
				payload: string;
			}
		).payload,
		"original",
	);
	cases++;
}
{
	const f = fixture();
	f.kv.set("a", Buffer.from("private"));
	const p = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	f.db.exec("UPDATE sdk_work_preservation_parts SET chunk=X'00'");
	await assert.rejects(f.engine().audit(KEY, p.archiveId));
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	cases++;
}
{
	const f = fixture(),
		native = new NativeStatePreservation(
			f.storage,
			{ ...intent, kind: "native-preservation-capture-v1" },
			() => {},
			async () => {},
		);
	const n = await native.inspect(KEY);
	await native.capture(KEY, n.archiveId, n.proof);
	const session = new SessionStatePreservation(
		f.storage,
		{ ...intent, kind: "session-preservation-capture-v1" },
		() => {},
		async () => {},
	);
	const s = await session.inspect(KEY);
	await session.capture(KEY, s.archiveId, s.proof);
	const p = await f.engine().inspect(KEY);
	assert.deepEqual(p.priorArchives, {
		historical: "absent",
		native: "present",
		session: "present",
	});
	await f.engine().capture(KEY, p.archiveId, p.proof);
	assert.ok(await native.audit(KEY, n.archiveId));
	assert.ok(await session.audit(KEY, s.archiveId));
	cases++;
}

for (const name of [
	"CF_AGENTS_JOBS",
	"ASSISTANT_FTS_DATA",
	"SDK_WORK_PRESERVATION_SNAPSHOT",
	"NATIVE_PRESERVATION_SNAPSHOT",
	"HISTORICAL_REPLAY_SEALS",
]) {
	const f = fixture();
	f.db.exec(`CREATE TABLE ${name}(id INTEGER)`);
	await assert.rejects(f.engine().inspect(KEY));
	await assert.rejects(f.engine().audit(KEY, randomUUID()));
	assert.equal(f.writes, 0);
	cases++;
}
{
	const f = fixture();
	f.kv.set("", undefined);
	f.kv.set("next", null);
	const p = await f.engine().inspect(KEY);
	assert.equal(p.metadata.kvEntries, 2);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	cases++;
}
{
	const f = fixture(),
		now = Date.now;
	try {
		await assert.rejects(
			f
				.engine(
					() => {},
					async () => {
						Date.now = () => now() + 300001;
					},
				)
				.inspect(KEY),
		);
		assert.equal(f.writes, 0);
	} finally {
		Date.now = now;
	}
	cases++;
}
{
	const f = fixture(),
		p = await f.engine().inspect(KEY),
		now = Date.now;
	try {
		f.inject((q) => {
			if (q.startsWith("INSERT INTO sdk_work_preservation_parts"))
				Date.now = () => now() + 300001;
		});
		await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
		assert.equal(f.present(), false);
	} finally {
		Date.now = now;
	}
	cases++;
}
{
	const f = fixture();
	f.db.exec(`CREATE TABLE unrelated(x TEXT DEFAULT '${"x".repeat(70000)}')`);
	let full = false;
	f.inject((q) => {
		if (
			q.startsWith(
				"SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master WHERE",
			)
		)
			full = true;
	});
	await assert.rejects(f.engine().inspect(KEY));
	assert.equal(full, false);
	assert.equal(f.writes, 0);
	cases++;
}
{
	const f = fixture(),
		p = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	f.db.exec("UPDATE sdk_work_preservation_parts SET chunk=zeroblob(1000001)");
	let read = false;
	f.inject((q) => {
		if (q.startsWith("SELECT chunk FROM sdk_work_preservation_parts"))
			read = true;
	});
	await assert.rejects(f.engine().audit(KEY, p.archiveId));
	assert.equal(read, false);
	cases++;
}
for (const action of ["encrypt", "decrypt"] as const) {
	const f = fixture(),
		p = action === "decrypt" ? await f.engine().inspect(KEY) : null;
	const subtle = crypto.subtle,
		original = subtle[action].bind(subtle);
	Object.defineProperty(subtle, action, {
		configurable: true,
		value: (...args: Parameters<typeof original>) => {
			const result = (original as (...a: unknown[]) => Promise<ArrayBuffer>)(
				...args,
			);
			queueMicrotask(() => f.kv.set("changed-in-crypto", undefined));
			return result;
		},
	});
	try {
		await assert.rejects(
			p
				? f.engine().capture(KEY, p.archiveId, p.proof)
				: f.engine().inspect(KEY),
		);
		assert.equal(f.present(), false);
	} finally {
		Object.defineProperty(subtle, action, {
			configurable: true,
			value: original,
		});
	}
	cases++;
}
{
	const f = fixture();
	f.db.exec(
		"CREATE TABLE cf_agents_jobs(id INTEGER PRIMARY KEY);CREATE TRIGGER cf_agents_jobs AFTER INSERT ON cf_agents_jobs BEGIN SELECT 1;END",
	);
	const p = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	cases++;
}
{
	const f = fixture();
	f.db.exec(
		"CREATE TABLE other(id INTEGER);CREATE INDEX SDK_WORK_PRESERVATION_SNAPSHOT ON other(id)",
	);
	await assert.rejects(f.engine().inspect(KEY));
	assert.equal(f.writes, 0);
	cases++;
}

async function duringCrypto(
	action: "encrypt" | "decrypt",
	mutate: () => void,
	run: () => Promise<unknown>,
) {
	const subtle = crypto.subtle,
		original = subtle[action].bind(subtle);
	let fired = false;
	Object.defineProperty(subtle, action, {
		configurable: true,
		value: (...args: Parameters<typeof original>) => {
			const p = (original as (...a: unknown[]) => Promise<ArrayBuffer>)(
				...args,
			);
			if (!fired) {
				fired = true;
				queueMicrotask(mutate);
			}
			return p;
		},
	});
	try {
		await run();
		assert.equal(fired, true);
	} finally {
		Object.defineProperty(subtle, action, {
			configurable: true,
			value: original,
		});
	}
}
function historicalFixture() {
	const f = fixture(),
		owner = { objectId: ID, tediId: intent.tediId, orgId: intent.orgId };
	new RuntimeAdmission(f.storage, owner, () => {
		throw Error("unexpected verifier");
	}).initialize({
		operationId: "hold",
		state: "quarantined",
		reason: "fixture",
	});
	f.db.exec("CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)");
	f.db
		.query("INSERT INTO cf_agents_state VALUES('cf_state_row_id',?)")
		.run(JSON.stringify(owner));
	const old = new HistoricalLiabilityCustody(f.storage, ID),
		observed = old.inspectSnapshot({ expectedGeneration: 1 });
	old.captureSnapshot({
		expectedGeneration: 1,
		expectedSourceHash: observed.sourceHash,
	});
	return { ...f, old };
}
{
	const f = historicalFixture(),
		before = f.db.query("SELECT * FROM historical_custody_snapshot").all(),
		p = await f.engine().inspect(KEY);
	assert.equal(p.priorArchives.historical, "present");
	await f.engine().capture(KEY, p.archiveId, p.proof);
	assert.ok(await f.engine().audit(KEY, p.archiveId));
	assert.deepEqual(
		f.db.query("SELECT * FROM historical_custody_snapshot").all(),
		before,
	);
	assert.ok(f.old.audit());
	cases++;
}
for (const target of ["header", "part", "ref", "seal"]) {
	const f = historicalFixture(),
		p = await f.engine().inspect(KEY),
		snapshot = f.old.audit()!.snapshotId;
	await duringCrypto(
		"decrypt",
		() => {
			if (target === "header")
				f.db.exec(
					"UPDATE historical_custody_snapshot SET header_hash='changed'",
				);
			if (target === "part")
				f.db.exec("UPDATE historical_custody_parts SET chunk=X'00FF'");
			if (target === "ref")
				f.db
					.query("INSERT INTO historical_liability_refs VALUES(?,?,?)")
					.run("a".repeat(64), snapshot, "b".repeat(64));
			if (target === "seal")
				f.db
					.query("INSERT INTO historical_replay_seals VALUES(?,?,?)")
					.run("original-replay", snapshot, "b".repeat(64));
		},
		() => assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof)),
	);
	assert.equal(f.present(), false);
	cases++;
}
for (const family of ["native", "session"] as const)
	for (const target of ["header", "part", "absent"]) {
		const f = fixture(),
			engine =
				family === "native"
					? new NativeStatePreservation(
							f.storage,
							{ ...intent, kind: "native-preservation-capture-v1" },
							() => {},
							async () => {},
						)
					: new SessionStatePreservation(
							f.storage,
							{ ...intent, kind: "session-preservation-capture-v1" },
							() => {},
							async () => {},
						),
			old = await engine.inspect(KEY);
		await engine.capture(KEY, old.archiveId, old.proof);
		const p = await f.engine().inspect(KEY);
		await duringCrypto(
			"decrypt",
			() => {
				if (target === "header")
					f.db.exec(
						`UPDATE ${family}_preservation_snapshot SET header_hash='changed'`,
					);
				if (target === "part")
					f.db.exec(`UPDATE ${family}_preservation_parts SET chunk=X'00FF'`);
				if (target === "absent")
					f.db.exec(
						`DROP TABLE ${family}_preservation_parts;DROP TABLE ${family}_preservation_snapshot`,
					);
			},
			() => assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof)),
		);
		assert.equal(f.present(), false);
		cases++;
	}

{
	const f = fixture(),
		p = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	const row = f.db
		.query("SELECT header FROM sdk_work_preservation_snapshot")
		.get() as { header: string };
	const header = JSON.parse(row.header);
	header.planProof = await encryptTediSecret(
		KEY,
		intent.tediId,
		JSON.stringify({ purpose: "unrelated-valid-ciphertext" }),
	);
	const text = JSON.stringify(header);
	f.db
		.query("UPDATE sdk_work_preservation_snapshot SET header=?,header_hash=?")
		.run(text, createHash("sha256").update(text).digest("hex"));
	await assert.rejects(f.engine().audit(KEY, p.archiveId));
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	cases++;
}
for (const name of [
	"historical_custody_snapshot",
	"native_preservation_snapshot",
	"session_preservation_snapshot",
]) {
	const f = fixture();
	f.db.exec(`CREATE VIEW ${name} AS SELECT 1 AS id`);
	await assert.rejects(f.engine().inspect(KEY));
	assert.equal(f.writes, 0);
	cases++;
}
{
	const f = fixture();
	f.db.exec(
		`CREATE TABLE cf_agents_jobs(x TEXT DEFAULT '${"x".repeat(70000)}')`,
	);
	let full = false;
	f.inject((q) => {
		if (
			q.includes("SELECT type,name,tbl_name,rootpage,sql") ||
			q.startsWith("PRAGMA table_xinfo")
		)
			full = true;
	});
	await assert.rejects(f.engine().inspect(KEY));
	assert.equal(full, false);
	assert.equal(f.writes, 0);
	cases++;
}

// Absence of the new archive never bypasses owning authentication of retained V1.
{
	const f = historicalFixture();
	assert.equal(await f.engine().audit(KEY, crypto.randomUUID()), null);
	f.db.exec("UPDATE historical_custody_parts SET chunk=X'00FF'");
	await assert.rejects(f.engine().audit(KEY, crypto.randomUUID()));
	assert.equal(f.present(), false);
	cases++;
}
// The synchronous publisher check belongs to this operation, including null observations.
for (const change of ["kv", "store", "custody"]) {
	const f = fixture();
	let held = true;
	const operation = f
		.rawEngine(() => {
			if (!held) throw Error("original custody changed");
		})
		.audit(KEY, crypto.randomUUID());
	assert.equal(await operation.result, null);
	await new Promise<void>((resolve) =>
		queueMicrotask(() => {
			if (change === "kv") f.kv.set("after-result", "PRIVATE");
			if (change === "store")
				f.db.exec("CREATE TABLE sdk_work_preservation_snapshot(id INTEGER)");
			if (change === "custody") held = false;
			resolve();
		}),
	);
	assert.throws(operation.assertReady);
	cases++;
}
{
	const f = fixture();
	f.kv.set("unsupported", new Date());
	assert.throws(() => f.rawEngine().audit(KEY, crypto.randomUUID()));
	assert.equal(f.writes, 0);
	cases++;
}
for (const change of ["kv", "store"]) {
	const f = fixture();
	const operation = f
		.rawEngine(
			() => {},
			async () => {
				if (change === "kv") f.kv.set("await-change", "PRIVATE");
				else
					f.db.exec("CREATE TABLE sdk_work_preservation_snapshot(id INTEGER)");
			},
		)
		.audit(KEY, crypto.randomUUID());
	await assert.rejects(operation.result);
	assert.throws(operation.assertContinuity);
	assert.throws(operation.assertReady);
	cases++;
}
{
	const f = fixture();
	const rejected = f
		.rawEngine(
			() => {},
			async () => {
				throw Error("canonical unavailable");
			},
		)
		.audit(KEY, crypto.randomUUID());
	await assert.rejects(rejected.result, /canonical unavailable/);
	rejected.assertContinuity();
	assert.throws(rejected.assertReady);
	assert.equal(f.writes, 0);
	cases++;
}
{
	const f = fixture();
	const owner = f.rawEngine();
	const first = owner.audit(KEY, crypto.randomUUID());
	assert.equal(await first.result, null);
	f.kv.set("later-operation", "PRIVATE");
	const second = owner.audit(KEY, crypto.randomUUID());
	assert.equal(await second.result, null);
	second.assertReady();
	assert.throws(first.assertReady);
	cases++;
}
{
	const f = fixture();
	const op = f.rawEngine().inspect(KEY);
	await op.result;
	f.kv.set("inspect-result-change", "PRIVATE");
	assert.throws(op.assertReady);
	assert.equal(f.writes, 0);
	cases++;
}
{
	const f = fixture();
	const p = await f.engine().inspect(KEY);
	const op = f.rawEngine().capture(KEY, p.archiveId, p.proof);
	const archive = await op.result;
	op.assertReady();
	assert.equal(archive.archiveId, p.archiveId);
	assert.equal(f.present(), true);
	f.kv.set("after-valid-commit", "PRIVATE");
	assert.throws(op.assertReady);
	// The completed transaction is preserved; publication refusal does not imply rollback.
	assert.equal(f.present(), true);
	cases++;
}
for (const mode of ["inspect", "capture"]) {
	const f = fixture();
	const original = Date.now;
	let now = original();
	Date.now = () => now;
	try {
		const p = await f.engine().inspect(KEY);
		const op =
			mode === "inspect"
				? f.rawEngine().inspect(KEY)
				: f.rawEngine().capture(KEY, p.archiveId, p.proof);
		await op.result;
		now += 300000;
		assert.throws(op.assertReady);
		assert.equal(f.present(), mode === "capture");
		cases++;
	} finally {
		Date.now = original;
	}
}
console.log("SDK selected preservation", cases, "owning cases PASS");
