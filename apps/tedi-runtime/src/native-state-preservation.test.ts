import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import {
	NativeStatePreservation,
	NATIVE_PRESERVATION_TABLES,
	NATIVE_PRESERVATION_PROOF_LIMIT,
} from "./native-state-preservation";
import {
	decryptTediSecret,
	encryptTediSecret,
} from "@tedix/db/utils/secrets-encryption";
import {
	compareCutoverWorkflowIds,
	TediRuntimeCutoverOperationQuerySchema,
	TediRuntimeNativePreservationResponseSchema,
} from "@tedix/api-contract/schemas/tedi";
const KEY = Buffer.alloc(32, 7).toString("base64"),
	ID = "a".repeat(64),
	TEDI = "00000000-0000-4000-8000-000000000003",
	ORG = "00000000-0000-4000-8000-000000000004";
const intent = {
	kind: "native-preservation-capture-v1" as const,
	operationId: "original",
	rootId: ID,
	objectId: ID,
	tediId: TEDI,
	orgId: ORG,
	objectName: "original",
	physicalName: "original",
	className: "AgentTediDO",
	targetPath: [],
	generation: 1,
};
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
							(!q.startAfter || compareCutoverWorkflowIds(k, q.startAfter) > 0),
					)
					.sort(([a], [b]) => compareCutoverWorkflowIds(a, b))
					.slice(0, 1)
					[Symbol.iterator]();
			},
		},
		transactionSync: <T>(fn: () => T): T => db.transaction(fn)(),
	} as unknown as Pick<DurableObjectStorage, "sql" | "kv" | "transactionSync">;
	const engine = (recheck = () => {}, verifyCanonical = async () => {}) =>
		new NativeStatePreservation(storage, intent, recheck, verifyCanonical);
	const present = () =>
		!!db
			.query(
				"SELECT name FROM sqlite_master WHERE name='native_preservation_snapshot'",
			)
			.get();
	return {
		db,
		kv,
		storage,
		engine,
		present,
		get writes() {
			return writes;
		},
		inject: (fn: (sql: string) => void) => {
			inject = fn;
		},
	};
}
{
	const f = fixture(),
		p = await f.engine().inspect(KEY);
	assert.equal(f.writes, 0);
	assert.equal(f.present(), false);
	assert.equal(p.metadata.tables.length, 23);
	assert.equal(p.legacyArchive.state, "absent");
	assert.equal(p.projectionDigest, null);
	const h = await f.engine().capture(KEY, p.archiveId, p.proof);
	assert.equal(h.archiveId, p.archiveId);
	assert.deepEqual(await f.engine().audit(KEY, p.archiveId), h);
	assert.deepEqual(
		await new NativeStatePreservation(
			f.storage,
			{ ...intent, operationId: "fresh-audit" },
			() => {},
			async () => {},
		).audit(KEY, p.archiveId),
		h,
	);
	assert.deepEqual(await f.engine().capture(KEY, p.archiveId, p.proof), h);
	const response = TediRuntimeNativePreservationResponseSchema.parse({
		ok: true,
		id: ID,
		targetObjectId: ID,
		operationId: "original",
		generation: 1,
		state: "held",
		receiver: "raw-cutover-v1",
		command: "inspect_native_preservation",
		archive: h,
		proof: p.proof,
	});
	assert.equal(JSON.stringify(response).includes('"sourceHash"'), false);
	assert.equal(JSON.stringify(response).includes('"schemaHash"'), false);
}
{
	const f = fixture();
	for (const table of NATIVE_PRESERVATION_TABLES)
		f.db.exec(
			table === "cf_agents_state"
				? "CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)"
				: `CREATE TABLE ${table}(id INTEGER PRIMARY KEY,token TEXT,future BLOB)`,
		);
	for (let i = 0; i < 300; i++)
		f.db
			.query("INSERT INTO pi_entries VALUES(?,?,?)")
			.run(i, "private-token-" + "x".repeat(32_000), Buffer.from([0, 1, 255]));
	f.db.exec("CREATE INDEX native_future_idx ON pi_entries(token)");
	f.db.exec(
		"CREATE TRIGGER native_future_trigger AFTER UPDATE ON pi_entries BEGIN SELECT 1; END",
	);
	f.kv.set("pi-accounting:pending", {
		status: "reserved",
		token: "private-not-settled",
	});
	f.kv.set("tedix:pi:maintenance:effect:unknown", { status: "uncertain" });
	const p = await f.engine().inspect(KEY);
	assert.ok(p.metadata.sourceBytes > 8 * 1024 * 1024);
	assert.equal(p.metadata.tables.filter((r) => r.present).length, 23);
	const h = await f.engine().capture(KEY, p.archiveId, p.proof);
	assert.deepEqual(await f.engine().audit(KEY, p.archiveId), h);
	const sizes = f.db
		.query("SELECT length(chunk) AS n FROM native_preservation_parts")
		.all() as { n: number }[];
	assert.ok(sizes.length > 8);
	assert.ok(sizes.every((r) => r.n <= 1_000_000));
	const bytes = Buffer.concat(
		(
			f.db
				.query("SELECT chunk FROM native_preservation_parts ORDER BY part")
				.all() as { chunk: Uint8Array }[]
		).map((r) => r.chunk),
	).toString();
	assert.ok(bytes.includes("native_future_trigger"));
	assert.ok(bytes.includes("native_future_idx"));
	assert.ok(bytes.includes("private-not-settled"));
	assert.ok(bytes.includes("reserved"));
	assert.ok(!JSON.stringify(h).includes("private"));
}
for (const value of [
	"x".repeat(1_000_001),
	new ArrayBuffer(800_000),
	Object.assign(["private"], { length: 1_000_000_000 }),
]) {
	const f = fixture();
	f.kv.set("pi-ui-entry:oversized", value);
	await assert.rejects(f.engine().inspect(KEY));
	assert.equal(f.writes, 0);
	assert.equal(f.present(), false);
}
{
	const f = fixture();
	f.db.exec("CREATE TABLE pi_documents(id INTEGER,value TEXT)");
	f.db.query("INSERT INTO pi_documents VALUES(1,?)").run("x".repeat(1_000_001));
	await assert.rejects(f.engine().inspect(KEY));
	assert.equal(f.writes, 0);
	f.db.exec("DELETE FROM pi_documents");
	f.db.exec("ALTER TABLE pi_documents ADD COLUMN blob BLOB");
	f.db
		.query("INSERT INTO pi_documents VALUES(1,NULL,?)")
		.run(Buffer.alloc(800_000));
	await assert.rejects(f.engine().inspect(KEY));
	assert.equal(f.writes, 0);
}
{
	const f = fixture();
	f.kv.set("pi-ui-entry:type", new ArrayBuffer(3));
	const p = await f.engine().inspect(KEY);
	f.kv.set("pi-ui-entry:type", new Uint8Array(3));
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	assert.equal(f.present(), false);
}
for (const mutate of [
	(f: ReturnType<typeof fixture>) =>
		f.kv.set("pi-accounting:private", { token: "changed" }),
	(f: ReturnType<typeof fixture>) =>
		f.db.exec("CREATE TABLE runtime_admission_operations(future TEXT)"),
	(f: ReturnType<typeof fixture>) =>
		f.db.exec("CREATE TABLE historical_replay_seals(identity TEXT)"),
]) {
	const f = fixture(),
		p = await f.engine().inspect(KEY);
	mutate(f);
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	assert.equal(f.present(), false);
}
{
	const f = fixture();
	f.kv.set("pi-accounting:private", { token: "original" });
	const p = await f.engine().inspect(KEY);
	queueMicrotask(() => f.kv.set("pi-accounting:private", { token: "changed" }));
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	assert.equal(f.present(), false);
}
{
	const f = fixture();
	f.db.exec("CREATE TABLE pi_entries(value TEXT)");
	f.db.exec("INSERT INTO pi_entries VALUES('original')");
	const p = await f.engine().inspect(KEY);
	let once = false;
	f.inject((sql) => {
		if (!once && sql.startsWith("INSERT INTO native_preservation_parts")) {
			once = true;
			f.db.exec("UPDATE pi_entries SET value='changed'");
		}
	});
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	assert.equal(f.present(), false);
	assert.equal(
		(f.db.query("SELECT value FROM pi_entries").get() as { value: string })
			.value,
		"original",
	);
}
{
	const f = fixture();
	const p = await f.engine().inspect(KEY);
	f.inject((sql) => {
		if (sql.startsWith("INSERT INTO native_preservation_parts"))
			throw new Error("private-provider-failure");
	});
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	assert.equal(f.present(), false);
}
{
	const f = fixture(),
		p = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	f.db.exec(
		"CREATE TRIGGER unsafe_archive_trigger AFTER INSERT ON native_preservation_parts BEGIN SELECT 1; END",
	);
	await assert.rejects(f.engine().audit(KEY, p.archiveId));
}
for (const field of [
	"purpose",
	"expiresAt",
	"header.intent.orgId",
	"header.intent.generation",
	"header.intent.operationId",
	"header.intent.targetPath",
	"header.selectorVersion",
]) {
	const f = fixture(),
		p = await f.engine().inspect(KEY),
		v = JSON.parse(await decryptTediSecret(KEY, TEDI, p.proof));
	const parts = field.split(".");
	let owner = v;
	for (const key of parts.slice(0, -1)) owner = owner[key];
	const key = parts.at(-1)!;
	owner[key] =
		field === "expiresAt"
			? 0
			: field.endsWith("generation")
				? 2
				: field.endsWith("targetPath")
					? [{}]
					: "changed";
	const forged = await encryptTediSecret(KEY, TEDI, JSON.stringify(v));
	await assert.rejects(f.engine().capture(KEY, p.archiveId, forged));
	assert.equal(f.writes, 0);
}
{
	const f = fixture();
	await assert.rejects(
		f
			.engine()
			.capture(
				KEY,
				crypto.randomUUID(),
				"x".repeat(NATIVE_PRESERVATION_PROOF_LIMIT + 1),
			),
	);
	assert.equal(f.writes, 0);
	const q = {
		routeTediId: TEDI,
		objectId: ID,
		custodyTediId: TEDI,
		operationId: "original",
		expectedGeneration: 1,
		command: "inspect_native_preservation",
	};
	assert.ok(TediRuntimeCutoverOperationQuerySchema.safeParse(q).success);
	for (const extra of [
		{ expectedHash: "a".repeat(64) },
		{ candidateObjectNames: ["private"] },
		{ provider: "forged" },
		{ proof: "unneeded" },
	])
		assert.equal(
			TediRuntimeCutoverOperationQuerySchema.safeParse({ ...q, ...extra })
				.success,
			false,
		);
}
console.log("native preservation unit PASS");

// Exact-key undefined is present state, not absence; canonical denial precedes any archive DDL.
for (const initiallyPresent of [true, false]) {
	const f = fixture();
	if (initiallyPresent) f.kv.set("facet-pending-submission", undefined);
	const plan = await f.engine().inspect(KEY);
	if (initiallyPresent) f.kv.delete("facet-pending-submission");
	else f.kv.set("facet-pending-submission", undefined);
	await assert.rejects(f.engine().capture(KEY, plan.archiveId, plan.proof));
	assert.equal(f.present(), false);
}
{
	const f = fixture();
	f.kv.set("facet-pending-submission", undefined);
	const p = await f.engine().inspect(KEY);
	const a = await f.engine().capture(KEY, p.archiveId, p.proof);
	assert.equal(a.metadata.kvEntries, 1);
	await f.engine().audit(KEY, p.archiveId);
	const raw = f.db
		.query("SELECT chunk FROM native_preservation_parts")
		.all()
		.map((r: any) => Buffer.from(r.chunk).toString())
		.join("");
	assert.ok(raw.includes("facet-pending-submission"));
	assert.ok(raw.includes("undefined"));
}
{
	const f = fixture();
	const p = await f.engine().inspect(KEY);
	await assert.rejects(
		f
			.engine(
				() => {},
				async () => {
					throw new Error("Canonical custody changed");
				},
			)
			.capture(KEY, p.archiveId, p.proof),
	);
	assert.equal(f.present(), false);
	assert.equal(f.writes, 0);
}

// Existing stored encrypted proof cannot be replaced even with a recomputed private header hash.
{
	const f = fixture();
	const p = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	const row = f.db
		.query("SELECT header FROM native_preservation_snapshot")
		.get() as { header: string };
	const h = JSON.parse(row.header);
	h.planProof = p.proof.slice(0, -4) + "AAAA";
	const text = JSON.stringify(h);
	const { createHash } = await import("node:crypto");
	f.db
		.query("UPDATE native_preservation_snapshot SET header=?,header_hash=?")
		.run(text, createHash("sha256").update(text).digest("hex"));
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
}
{
	const f = fixture();
	const p = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	let checks = 0;
	await assert.rejects(
		f
			.engine(
				() => {},
				async () => {
					if (++checks === 2)
						f.db.exec(
							"UPDATE native_preservation_parts SET chunk_hash='invalid'",
						);
				},
			)
			.inspect(KEY),
	);
}

for (const value of [
	Object.assign(new ArrayBuffer(1), { private: "x" }),
	Object.assign(new Uint8Array(1), { private: "x" }),
	Object.setPrototypeOf(
		new ArrayBuffer(1),
		Object.create(ArrayBuffer.prototype),
	),
]) {
	const f = fixture();
	f.kv.set("pi-ui-entry:unsupported", value);
	await assert.rejects(f.engine().inspect(KEY));
	assert.equal(f.writes, 0);
}

{
	const f = fixture();
	const p = await f.engine().inspect(KEY);
	const time = Date.now;
	try {
		await assert.rejects(
			f
				.engine(
					() => {},
					async () => {
						Date.now = () => time() + 300001;
					},
				)
				.capture(KEY, p.archiveId, p.proof),
		);
		assert.equal(f.writes, 0);
		assert.equal(f.present(), false);
	} finally {
		Date.now = time;
	}
}

// Expiry crossed inside a provider write rolls back the whole new archive transaction.
{
	const f = fixture();
	const p = await f.engine().inspect(KEY);
	const time = Date.now;
	try {
		f.inject((sql) => {
			if (sql.startsWith("INSERT INTO native_preservation_parts"))
				Date.now = () => time() + 300001;
		});
		await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
		assert.equal(f.present(), false);
		assert.equal(
			f.db
				.query(
					"SELECT name FROM sqlite_master WHERE name='native_preservation_parts'",
				)
				.all().length,
			0,
		);
	} finally {
		Date.now = time;
	}
}

{
	const f = fixture();
	f.db.exec("CREATE TABLE pi_documents(value INTEGER)");
	f.db.exec("INSERT INTO pi_documents VALUES (9007199254740993)");
	await assert.rejects(f.engine().inspect(KEY));
	assert.equal(f.writes, 0);
	assert.equal(f.present(), false);
}
// KV doubles retain their actual structured-clone number, independently of SQL integer coercion.
{
	const f = fixture();
	f.kv.set("pi-ui-entry:double", 9007199254740992);
	const p = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	await f.engine().audit(KEY, p.archiveId);
}

// Equal JS numeric values with different SQLite storage classes are distinct private source.
{
	const f = fixture();
	f.db.exec("CREATE TABLE pi_documents(value)");
	f.db.exec("INSERT INTO pi_documents VALUES (1)");
	const p = await f.engine().inspect(KEY);
	f.db.exec("UPDATE pi_documents SET value=CAST(value AS REAL)");
	await assert.rejects(f.engine().capture(KEY, p.archiveId, p.proof));
	assert.equal(f.present(), false);
}

// Extraction retains native archive framing, including structured-clone distinctions.
{
	const f = fixture();
	f.kv.set("pi-ui-entry:codec", {
		sparse: Object.assign(Array(3), { 1: -0, 2: undefined }),
		bytes: new Uint8Array([0, 255]),
	});
	const p = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	const bytes = Buffer.concat(
		f.db
			.query("SELECT chunk FROM native_preservation_parts ORDER BY part")
			.all()
			.map((r: unknown) => Buffer.from((r as { chunk: Uint8Array }).chunk)),
	);
	assert.ok(bytes.includes('["uint8-array","AP8="]'));
	assert.ok(bytes.includes('["hole"]'));
	assert.ok(bytes.includes('["number","-0"]'));
	assert.ok(bytes.includes('["undefined"]'));
}
