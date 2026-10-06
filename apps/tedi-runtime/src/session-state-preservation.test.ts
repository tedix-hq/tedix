import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	SessionStatePreservation,
	SessionPreservationIntentSchema,
} from "./session-state-preservation";
import {
	decryptTediSecret,
	encryptTediSecret,
} from "@tedix/db/utils/secrets-encryption";
import { HistoricalLiabilityCustody } from "./historical-liability-custody";
import { RuntimeAdmission } from "./runtime-admission";
import { NativeStatePreservation } from "./native-state-preservation";
const KEY = Buffer.alloc(32, 7).toString("base64"),
	ID = "a".repeat(64);
const intent = SessionPreservationIntentSchema.parse({
	kind: "session-preservation-capture-v1",
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
			all(...values: unknown[]): unknown[];
			get(...values: unknown[]): Record<string, unknown> | null;
			run(...values: unknown[]): unknown;
		};
	};
	let writes = 0,
		hook: ((sql: string) => void) | undefined;
	const storage = {
		sql: {
			exec(sql: string, ...args: SqlStorageValue[]) {
				if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(sql)) writes++;
				hook?.(sql);
				const rows = db
					.query(sql)
					.all(
						...args.map((v) =>
							v instanceof ArrayBuffer ? new Uint8Array(v) : v,
						),
					) as Record<string, SqlStorageValue>[];
				return {
					toArray: () => rows,
					[Symbol.iterator]: () => rows[Symbol.iterator](),
				};
			},
		},
		kv: { get: () => undefined, list: () => [][Symbol.iterator]() },
		transactionSync: <T>(fn: () => T) => db.transaction(fn)(),
	} as unknown as Pick<DurableObjectStorage, "sql" | "kv" | "transactionSync">;
	const engine = (
		verify = async () => {},
		recheck = () => {},
		input = intent,
	) => new SessionStatePreservation(storage, input, recheck, verify);
	const exists = () =>
		!!db
			.query(
				"SELECT name FROM sqlite_master WHERE name='session_preservation_snapshot'",
			)
			.get();
	return {
		db,
		storage,
		engine,
		exists,
		writes: () => writes,
		hook: (f: (sql: string) => void) => {
			hook = f;
		},
	};
}
const schema = (f: ReturnType<typeof fixture>) => {
	f.db.exec(
		"CREATE TABLE session_entries(id TEXT PRIMARY KEY,content TEXT,blob BLOB,exact INTEGER,nullable TEXT)",
	);
	f.db
		.query(
			"INSERT INTO session_entries VALUES ('root','PRIVATE_TEXT',?,9007199254740993,NULL)",
		)
		.run(new Uint8Array([0, 255, 1]));
};
let cases = 0;
{
	const f = fixture();
	const before = f.writes();
	assert.equal(await f.engine().audit(KEY, crypto.randomUUID()), null);
	const p = await f.engine().inspect(KEY);
	assert.equal(f.exists(), false);
	assert.equal(f.writes(), before);
	assert.equal(p.metadata.tables.length, 8);
	assert.equal(
		p.metadata.tables.every((t) => !t.present),
		true,
	);
	cases++;
}
{
	const f = fixture();
	schema(f);
	f.db.exec(
		"CREATE INDEX private_index ON session_entries(content);CREATE TRIGGER private_trigger AFTER UPDATE ON session_entries BEGIN SELECT 1;END",
	);
	const before = f.db
		.query(
			"SELECT CAST(exact AS TEXT) AS exact,content,blob FROM session_entries",
		)
		.all();
	const p = await f.engine().inspect(KEY);
	const a = await f.engine().capture(KEY, p.archiveId, p.proof);
	assert.deepEqual(await f.engine().audit(KEY, p.archiveId), a);
	assert.deepEqual(await f.engine().capture(KEY, p.archiveId, p.proof), a);
	assert.deepEqual(
		f.db
			.query(
				"SELECT CAST(exact AS TEXT) AS exact,content,blob FROM session_entries",
			)
			.all(),
		before,
	);
	const bytes = Buffer.concat(
		f.db
			.query("SELECT chunk FROM session_preservation_parts ORDER BY part")
			.all()
			.map((r) => Buffer.from((r as { chunk: Uint8Array }).chunk)),
	);
	assert(bytes.includes("9007199254740993"));
	assert(bytes.includes("private_trigger"));
	assert(bytes.includes("PRIVATE_TEXT"));
	assert(!JSON.stringify(a).includes("PRIVATE_TEXT"));
	assert(!JSON.stringify(a).includes("sourceHash"));
	assert.equal(a.projectionDigest, null);
	cases++;
}
{
	const f = fixture();
	schema(f);
	const text = "😀é\0終".repeat(150000),
		blob = Buffer.alloc(1200000, 251);
	f.db.query("UPDATE session_entries SET content=?,blob=?").run(text, blob);
	for (let i = 0; i < 8; i++)
		f.db
			.query("INSERT INTO session_entries VALUES (?, ?,NULL,1,NULL)")
			.run(String(i), "x".repeat(1000000));
	const p = await f.engine().inspect(KEY);
	assert(p.metadata.sourceBytes > 8 * 1024 * 1024);
	const a = await f.engine().capture(KEY, p.archiveId, p.proof);
	assert.deepEqual(await f.engine().audit(KEY, p.archiveId), a);
	const parts = f.db
		.query("SELECT chunk FROM session_preservation_parts ORDER BY part")
		.all()
		.map((r) => Buffer.from((r as { chunk: Uint8Array }).chunk));
	assert(parts.every((p) => p.length <= 1000000));
	const all = Buffer.concat(parts);
	assert(all.includes(Buffer.from(text)));
	assert(all.includes(blob));
	assert(parts.length > 8);
	cases++;
}
{
	const f = fixture();
	f.db.exec(
		"CREATE TABLE cf_agents_session_message_chunks(session TEXT,id TEXT,idx INTEGER,content TEXT,PRIMARY KEY(session,id,idx)) WITHOUT ROWID",
	);
	for (const id of ["one", "two"])
		f.db
			.query(
				"INSERT INTO cf_agents_session_message_chunks VALUES ('session',?,9223372036854775807,'same')",
			)
			.run(id);
	const p = await f.engine().inspect(KEY);
	assert.equal(p.metadata.tables[2]!.rows, 2);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	const all = Buffer.concat(
		f.db
			.query("SELECT chunk FROM session_preservation_parts ORDER BY part")
			.all()
			.map((r) => Buffer.from((r as { chunk: Uint8Array }).chunk)),
	);
	assert(all.includes("9223372036854775807"));
	assert(all.includes("one"));
	assert(all.includes("two"));
	cases++;
}
for (const change of [
	"UPDATE session_entries SET content='changed'",
	"ALTER TABLE session_entries ADD COLUMN future BLOB",
	"CREATE TABLE native_preservation_snapshot(header TEXT)",
]) {
	const f = fixture();
	schema(f);
	const p = await f.engine().inspect(KEY);
	await assert.rejects(
		f
			.engine(async () => {
				f.db.exec(change);
			})
			.capture(KEY, p.archiveId, p.proof),
	);
	assert.equal(f.exists(), false);
	cases++;
}
{
	const f = fixture();
	schema(f);
	const p = await f.engine().inspect(KEY);
	const plaintext = JSON.parse(
		await decryptTediSecret(KEY, intent.tediId, p.proof),
	);
	for (const mutate of [
		(v: typeof plaintext) => {
			v.purpose = "native-state-preservation-plan-v1";
		},
		(v: typeof plaintext) => {
			v.header.intent.operationId = "other";
		},
		(v: typeof plaintext) => {
			v.header.archiveId = crypto.randomUUID();
		},
		(v: typeof plaintext) => {
			v.expiresAt = v.issuedAt - 1;
		},
	]) {
		const v = structuredClone(plaintext);
		mutate(v);
		const bad = await encryptTediSecret(KEY, intent.tediId, JSON.stringify(v));
		await assert.rejects(f.engine().capture(KEY, p.archiveId, bad));
		assert.equal(f.exists(), false);
		cases++;
	}
	await assert.rejects(
		f.engine().capture(KEY, p.archiveId, "a".repeat(131073)),
	);
	assert.equal(f.exists(), false);
	cases++;
}
{
	const f = fixture();
	schema(f);
	const p = await f.engine().inspect(KEY);
	let clock = Date.now();
	const original = Date.now;
	try {
		Date.now = () => clock;
		await assert.rejects(
			f
				.engine(async () => {
					clock += 300001;
				})
				.capture(KEY, p.archiveId, p.proof),
		);
		assert.equal(f.exists(), false);
	} finally {
		Date.now = original;
	}
	cases++;
}
{
	const f = fixture();
	schema(f);
	const p = await f.engine().inspect(KEY);
	f.hook((sql) => {
		if (sql.startsWith("INSERT INTO session_preservation_parts"))
			throw Error("SQL allocation failure");
	});
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	assert.equal(f.exists(), false);
	assert.equal(
		f.db.query("SELECT content FROM session_entries").get()!.content,
		"PRIVATE_TEXT",
	);
	cases++;
}
{
	const f = fixture();
	schema(f);
	const p = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	const row = f.db
		.query("SELECT header FROM session_preservation_snapshot")
		.get() as { header: string };
	const h = JSON.parse(row.header);
	h.planProof = "a".repeat(40);
	const text = JSON.stringify(h);
	f.db
		.query("UPDATE session_preservation_snapshot SET header=?,header_hash=?")
		.run(text, createHash("sha256").update(text).digest("hex"));
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	await assert.rejects(f.engine().audit(KEY, p.archiveId));
	cases++;
}
{
	const f = fixture();
	schema(f);
	const native = new NativeStatePreservation(
		f.storage,
		{ ...intent, kind: "native-preservation-capture-v1" },
		() => {},
		async () => {},
	);
	const old = await native.inspect(KEY);
	await native.capture(KEY, old.archiveId, old.proof);
	const oldBytes = f.db
		.query("SELECT header,header_hash FROM native_preservation_snapshot")
		.all();
	const p = await f.engine().inspect(KEY);
	assert.equal(p.priorArchives.native, "present");
	await f.engine().capture(KEY, p.archiveId, p.proof);
	assert.deepEqual(
		f.db
			.query("SELECT header,header_hash FROM native_preservation_snapshot")
			.all(),
		oldBytes,
	);
	assert(await f.engine().audit(KEY, p.archiveId));
	cases++;
}
{
	const f = fixture();
	f.db.exec("CREATE TABLE session_entries(rowid TEXT,_rowid_ TEXT,oid TEXT)");
	await assert.rejects(f.engine().inspect(KEY));
	assert.equal(f.exists(), false);
	cases++;
}
{
	const f = fixture();
	f.db.exec(
		"CREATE TABLE cf_agents_session_config(k TEXT PRIMARY KEY,v TEXT) WITHOUT ROWID",
	);
	f.db
		.query("INSERT INTO cf_agents_session_config VALUES (?, 'private')")
		.run("x".repeat(8193));
	await assert.rejects(f.engine().inspect(KEY));
	assert.equal(f.exists(), false);
	cases++;
}

async function duringCrypto(
	method: "encrypt" | "decrypt",
	change: () => void,
	run: () => Promise<unknown>,
) {
	const own = Object.getOwnPropertyDescriptor(crypto.subtle, method),
		original = crypto.subtle[method];
	let mutated = false;
	Object.defineProperty(crypto.subtle, method, {
		configurable: true,
		value: async (...args: unknown[]) => {
			const result = await Reflect.apply(original, crypto.subtle, args);
			if (!mutated) {
				mutated = true;
				queueMicrotask(change);
			}
			return result;
		},
	});
	try {
		await run();
		assert.equal(mutated, true);
	} finally {
		if (own) Object.defineProperty(crypto.subtle, method, own);
		else Reflect.deleteProperty(crypto.subtle, method);
	}
}
for (const method of ["encrypt", "decrypt"] as const) {
	const f = fixture();
	schema(f);
	const p = await f.engine().inspect(KEY);
	await duringCrypto(
		method,
		() => f.db.exec("UPDATE session_entries SET blob=X'00FF'"),
		() =>
			assert.rejects(
				method === "encrypt"
					? f.engine().inspect(KEY)
					: f.engine().capture(KEY, p.archiveId, p.proof),
			),
	);
	assert.equal(f.exists(), false);
	cases++;
}
for (const pin of ["name", "owner", "generation"]) {
	const f = fixture();
	schema(f);
	let value = "original",
		changed = false;
	const originalError = Error("original " + pin + " changed"),
		recheck = () => {
			if (changed) throw originalError;
		};
	const p = await f.engine(async () => {}, recheck).inspect(KEY);
	await duringCrypto(
		"decrypt",
		() => {
			value = "changed";
			changed = true;
		},
		() =>
			assert.rejects(
				f.engine(async () => {}, recheck).capture(KEY, p.archiveId, p.proof),
				(e) => e === originalError,
			),
	);
	assert.equal(value, "changed");
	assert.equal(f.exists(), false);
	cases++;
}
{
	const f = fixture();
	schema(f);
	const p = await f.engine().inspect(KEY);
	const original = Date.now;
	let clock = Date.now();
	f.hook((sql) => {
		if (sql.startsWith("INSERT INTO session_preservation_parts"))
			clock += 300001;
	});
	try {
		Date.now = () => clock;
		await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
		assert.equal(f.exists(), false);
		assert.equal(
			f.db.query("SELECT count(*) AS n FROM session_entries").get()!.n,
			1,
		);
	} finally {
		Date.now = original;
	}
	cases++;
}
for (const damage of [
	"UPDATE session_preservation_parts SET chunk=X'00'",
	"UPDATE session_preservation_snapshot SET header_hash='bad'",
]) {
	const f = fixture();
	schema(f);
	const p = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	f.db.exec(damage);
	await assert.rejects(f.engine().audit(KEY, p.archiveId));
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	cases++;
}
{
	const f = fixture();
	schema(f);
	f.db.exec(
		"INSERT INTO session_entries VALUES(NULL,'duplicate',NULL,-9223372036854775808,NULL),(NULL,'duplicate',NULL,9223372036854775807,NULL)",
	);
	const p = await f.engine().inspect(KEY);
	assert.equal(p.metadata.tables[0]!.rows, 3);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	const all = Buffer.concat(
		f.db
			.query("SELECT chunk FROM session_preservation_parts ORDER BY part")
			.all()
			.map((r) => Buffer.from((r as { chunk: Uint8Array }).chunk)),
	);
	assert(all.includes("-9223372036854775808"));
	assert(all.includes("9223372036854775807"));
	cases++;
}
function legacyFixture() {
	const f = fixture();
	schema(f);
	const owner = { objectId: ID, tediId: intent.tediId, orgId: intent.orgId };
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
	const f = legacyFixture();
	const before = f.db.query("SELECT * FROM historical_custody_snapshot").all();
	const p = await f.engine().inspect(KEY);
	assert.equal(p.priorArchives.historical, "present");
	const a = await f.engine().capture(KEY, p.archiveId, p.proof);
	assert.deepEqual(await f.engine().audit(KEY, p.archiveId), a);
	assert.deepEqual(
		f.db.query("SELECT * FROM historical_custody_snapshot").all(),
		before,
	);
	assert(f.old.audit());
	cases++;
}
for (const table of [
	"historical_custody_parts",
	"historical_liability_refs",
	"historical_replay_seals",
]) {
	const f = legacyFixture();
	const p = await f.engine().inspect(KEY);
	// A schema/value change in any exact prior table is pinned even if the public audit summary is unchanged.
	await duringCrypto(
		"decrypt",
		() => f.db.exec(`ALTER TABLE ${table} ADD COLUMN future TEXT`),
		() => assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof)),
	);
	assert.equal(f.exists(), false);
	cases++;
}

for (const mutate of [
	(f: ReturnType<typeof legacyFixture>) =>
		f.db.exec("UPDATE historical_custody_parts SET chunk=X'00FF'"),
	(f: ReturnType<typeof legacyFixture>) =>
		f.db.exec("UPDATE historical_custody_snapshot SET header_hash='changed'"),
	(f: ReturnType<typeof legacyFixture>) =>
		f.db
			.query("INSERT INTO historical_liability_refs VALUES(?,?,?)")
			.run("a".repeat(64), f.old.audit()!.snapshotId, "b".repeat(64)),
	(f: ReturnType<typeof legacyFixture>) =>
		f.db
			.query("INSERT INTO historical_replay_seals VALUES(?,?,?)")
			.run("original-replay", f.old.audit()!.snapshotId, "b".repeat(64)),
]) {
	const f = legacyFixture(),
		p = await f.engine().inspect(KEY);
	await duringCrypto(
		"decrypt",
		() => mutate(f),
		() => assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof)),
	);
	assert.equal(f.exists(), false);
	cases++;
}
for (const target of ["header", "part"]) {
	const f = fixture();
	schema(f);
	const p = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	if (target === "header")
		f.db
			.query("UPDATE session_preservation_snapshot SET header=?")
			.run("x".repeat(300000));
	else
		f.db
			.query("UPDATE session_preservation_parts SET chunk=?")
			.run(Buffer.alloc(1200000));
	let fullReads = 0;
	f.hook((query) => {
		if (
			target === "header"
				? query.startsWith(
						"SELECT header,header_hash FROM session_preservation_snapshot",
					)
				: query.startsWith("SELECT chunk FROM session_preservation_parts")
		)
			fullReads++;
	});
	await assert.rejects(f.engine().audit(KEY, p.archiveId));
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	assert.equal(
		fullReads,
		0,
		"oversized stored cell refused before materializing payload",
	);
	cases++;
}
console.log(`Session preservation ${cases} owning cases passed`);

// The qualifier uses original Session8 purpose/UUID authentication, never native archive substitution.
{
	const f = fixture();
	schema(f);
	const p = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	const before = f.writes();
	const observed = await f.engine().prepareQualification(KEY, p.archiveId)
		.result;
	assert.equal(
		observed!.qualification.parentLocal.reason,
		"unsupported_schema",
	);
	assert.equal(observed!.qualification.executionEligible, false);
	assert.equal(f.writes(), before);
	await assert.rejects(
		f.engine().prepareQualification(KEY, crypto.randomUUID()).result,
	);
	const header = (
		f.db.query("SELECT header FROM session_preservation_snapshot").get() as {
			header: string;
		}
	).header;
	await assert.rejects(
		f
			.engine(async () => {
				const h = JSON.parse(header);
				h.planProof = "tampered";
				const body = JSON.stringify(h);
				f.db
					.query(
						"UPDATE session_preservation_snapshot SET header=?,header_hash=?",
					)
					.run(body, createHash("sha256").update(body).digest("hex"));
			})
			.prepareQualification(KEY, p.archiveId).result,
	);
}

// The delegated table stream retains the original literal large-cell frame golden.
{
	const f = fixture();
	f.db.exec(
		"CREATE TABLE fixture(a TEXT,b BLOB,c INTEGER,d REAL,e TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID",
	);
	f.db
		.query("INSERT INTO fixture VALUES(?,?,9223372036854775807,1.25,NULL)")
		.run("private\0unicode🌒" + "x".repeat(1100000), new Uint8Array([0, 255]));
	f.db.exec(
		"CREATE TABLE payload(id INTEGER PRIMARY KEY,a TEXT,b BLOB,c INTEGER,d REAL,e TEXT)",
	);
	f.db
		.query("INSERT INTO payload VALUES(1,?,?,9223372036854775807,1.25,NULL)")
		.run("private\0unicode🌒" + "x".repeat(1100000), new Uint8Array(1100000));
	const frames = [
		...(
			f.engine() as unknown as {
				tableFrames(table: string): Iterable<Uint8Array>;
			}
		).tableFrames("payload"),
	];
	assert.equal(
		createHash("sha256").update(Buffer.concat(frames)).digest("hex"),
		"79411687313bf2b105a0cbb40c00066bba749d5e5fbce423ef8512676279fe8f",
	);
}

{
	const f = fixture();
	let canonical = 0;
	const prepared = f
		.engine(async () => {
			canonical++;
		})
		.prepareQualification(KEY, crypto.randomUUID());
	assert.equal(await prepared.result, null);
	assert.equal(canonical, 1);
	prepared.assertReady();
	f.db.exec("CREATE TABLE session_entries(future TEXT)");
	assert.throws(prepared.assertReady, /verification rejected/);
	assert.equal(f.writes(), 0);
}
{
	const f = fixture();
	let release!: () => void;
	const prepared = f
		.engine(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		)
		.prepareQualification(KEY, crypto.randomUUID());
	while (!release)
		await new Promise<void>((resolve) => queueMicrotask(resolve));
	f.db.exec("CREATE TABLE session_entries(future TEXT)");
	release();
	await assert.rejects(prepared.result, /verification rejected/);
	assert.throws(prepared.assertContinuity, /verification rejected/);
	assert.equal(f.writes(), 0);
}
{
	const f = fixture(),
		timer = globalThis.setTimeout;
	let requested = 0;
	globalThis.setTimeout = ((
		callback: (...args: unknown[]) => void,
		delay?: number,
		...args: unknown[]
	) => {
		requested = delay ?? 0;
		return timer(callback, 0, ...args);
	}) as typeof setTimeout;
	try {
		const prepared = f
			.engine(() => new Promise<void>(() => {}))
			.prepareQualification(
				KEY,
				crypto.randomUUID(),
				performance.now() + 30000,
			);
		await assert.rejects(prepared.result, /deadline/);
		assert.ok(requested > 0 && requested <= 30000);
		assert.equal(f.writes(), 0);
	} finally {
		globalThis.setTimeout = timer;
	}
}
console.log(
	"Prepared absence, rejected-yield custody and pending canonical deadline passed",
);

// A producer can reject synchronously before checked() observes its argument.
// The original source rejection must win without leaving that promise unhandled.
{
	const f = fixture();
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const operation = f
			.engine(async () => {
				f.db.exec("CREATE TABLE session_entries(future TEXT)");
				throw new Error("private producer failure");
			})
			.prepareQualification(KEY, crypto.randomUUID());
		await assert.rejects(operation.result, /verification rejected/);
		assert.throws(operation.assertReady, /verification rejected/);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(unhandled, []);
		assert.equal(f.writes(), 0);
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
}

{
	const f = fixture();
	schema(f);
	const p = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	const original = crypto.subtle.decrypt;
	let invalidated = false,
		decrypts = 0;
	const first = new Error("original custody changed during authentication"),
		before = f.writes();
	crypto.subtle.decrypt = (async (...args: Parameters<typeof original>) => {
		const plaintext = await Reflect.apply(original, crypto.subtle, args);
		decrypts++;
		queueMicrotask(() => {
			invalidated = true;
		});
		return plaintext;
	}) as typeof original;
	try {
		const operation = f
			.engine(
				async () => {},
				() => {
					if (invalidated) throw first;
				},
			)
			.prepareQualification(KEY, p.archiveId);
		await assert.rejects(operation.result, (error) => error === first);
		assert.ok(decrypts > 0);
		invalidated = false;
		assert.throws(operation.assertContinuity, (error) => error === first);
		assert.equal(f.writes(), before);
	} finally {
		crypto.subtle.decrypt = original;
	}
}
{
	const f = fixture(),
		own = Object.getOwnPropertyDescriptor(performance, "now");
	let clock = 0;
	Object.defineProperty(performance, "now", {
		configurable: true,
		value: () => clock,
	});
	try {
		const operation = f
			.engine(async () => {
				clock = 30001;
			})
			.prepareQualification(KEY, crypto.randomUUID());
		await assert.rejects(operation.result, /deadline/);
		assert.equal(f.writes(), 0);
		assert.throws(operation.assertReady, /deadline/);
	} finally {
		if (own) Object.defineProperty(performance, "now", own);
		else Reflect.deleteProperty(performance, "now");
	}
}
console.log(
	"Actual decrypt queued custody mutation preserves first error; original canonical clock expires before decoding",
);
