import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import {
	SessionStatePreservation,
	SessionPreservationIntentSchema,
} from "./session-state-preservation";
import {
	qualifySessionArchive,
	reduceSessionTables,
	SESSION_REHYDRATION_BYTES,
	SESSION_REHYDRATION_ROWS,
	SessionSemanticBudget,
} from "./session-state-rehydration";
import {
	TediSessionRepo,
	pathToRoot,
	projectBranch,
} from "@tedix/tedi-session/session-repo";
import { SessionPreservationTableNames } from "@tedix/api-contract/schemas/tedi";
const KEY = Buffer.alloc(32, 7).toString("base64");
const intent = SessionPreservationIntentSchema.parse({
	kind: "session-preservation-capture-v1",
	operationId: "fixture",
	rootId: "a".repeat(64),
	objectId: "a".repeat(64),
	tediId: "00000000-0000-4000-8000-000000000003",
	orgId: "org",
	objectName: "local",
	physicalName: "local",
	className: "AgentTediDO",
	targetPath: [],
	generation: 1,
});
function fixture() {
	const db = new Database(":memory:") as unknown as {
		exec(sql: string): void;
		transaction<T>(fn: () => T): () => T;
		query(sql: string): {
			all(...args: unknown[]): unknown[];
			get(...args: unknown[]): Record<string, unknown> | null;
			run(...args: unknown[]): unknown;
		};
	};
	let writes = 0;
	const sql = {
		exec(query: string, ...args: SqlStorageValue[]) {
			if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(query)) writes++;
			const rows = db
				.query(query)
				.all(
					...(args.map((v) =>
						v instanceof ArrayBuffer ? new Uint8Array(v) : v,
					) as never[]),
				);
			return {
				[Symbol.iterator]: () => rows[Symbol.iterator](),
				toArray: () => rows,
			};
		},
	};
	const storage = {
		sql,
		kv: { get: () => undefined, list: () => [][Symbol.iterator]() },
		transactionSync: <T>(f: () => T) => db.transaction(f)(),
	} as unknown as Pick<DurableObjectStorage, "sql" | "kv" | "transactionSync">;
	const engine = (verify = async () => {}) =>
		new SessionStatePreservation(storage, intent, () => {}, verify);
	const repo = new TediSessionRepo({
		sql: <T>(
			strings: TemplateStringsArray,
			...args: (string | number | boolean | null)[]
		) =>
			db
				.query(strings.join("?"))
				.all(
					...args.map((v) => (typeof v === "boolean" ? Number(v) : v)),
				) as T[],
		readDurable: async () => ({ entries: [], compaction: null }),
	});
	return { db, engine, repo, writes: () => writes };
}
async function capture(f: ReturnType<typeof fixture>) {
	const plan = await f.engine().inspect(KEY);
	await f.engine().capture(KEY, plan.archiveId, plan.proof);
	const header = JSON.parse(
		(
			f.db.query("SELECT header FROM session_preservation_snapshot").get() as {
				header: string;
			}
		).header,
	);
	const parts = (
		f.db
			.query("SELECT chunk FROM session_preservation_parts ORDER BY part")
			.all() as { chunk: Uint8Array }[]
	).map((r) => r.chunk);
	return { plan, header, parts };
}
let cases = 0;
{
	const f = fixture();
	assert.equal(
		await f.engine().prepareQualification(KEY, crypto.randomUUID()).result,
		null,
	);
	assert.equal(f.writes(), 0);
	const { plan, header, parts } = await capture(f);
	const before = f.writes();
	const result = await f.engine().prepareQualification(KEY, plan.archiveId)
		.result;
	assert.equal(result!.qualification.parentLocal.status, "absent");
	assert.equal(result!.qualification.sdk7.status, "absent");
	assert.equal(f.writes(), before);
	assert.deepEqual(
		{
			...qualifySessionArchive(
				parts,
				header.metadata,
				header.selectorVersion,
				header.intent,
			),
			archiveAuthenticated: true,
		},
		result!.qualification,
	);
	cases++;
}
{
	const f = fixture();
	f.repo.appendTurn(
		{ sessionKey: "root", role: "user", content: "PRIVATE\n\0Original", ts: 1 },
		"original:1",
	);
	f.repo.appendTurn(
		{
			sessionKey: "root",
			role: "assistant",
			content: "PRIVATE_MODEL",
			ts: 2,
			modelIdentity: { provider: "original", model: "original-model" },
		},
		"original:2",
	);
	const branch = f.repo.getBranch("root");
	f.repo.appendCompaction("root", {
		summary: "PRIVATE_SUMMARY",
		firstKeptEntryId: branch[1]!.id,
		tokensBefore: 99,
	});
	f.db.exec("UPDATE session_entries SET ts=3 WHERE type='compaction'");
	const { plan } = await capture(f),
		before = f.writes();
	const result = await f.engine().prepareQualification(KEY, plan.archiveId)
		.result;
	assert.equal(result!.qualification.parentLocal.status, "supported");
	assert.equal(result!.qualification.parentLocal.messages, 2);
	assert.equal(result!.qualification.parentLocal.compactions, 1);
	assert.equal(
		result!.qualification.canonicalLedgerCorrespondence,
		"not_queried",
	);
	assert.equal(result!.qualification.adoptionReady, false);
	assert.equal(f.writes(), before);
	assert(!JSON.stringify(result).includes("PRIVATE"));
	const tables = Object.fromEntries(
		SessionPreservationTableNames.map((name) => ({
			name,
			present: !!f.db
				.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
				.get(name),
		})).map(({ name, present }) => [
			name,
			{
				present,
				schema: present
					? f.db
							.query(
								"SELECT type,name,tbl_name,rootpage,sql FROM sqlite_master WHERE tbl_name=? ORDER BY type,name",
							)
							.all(name)
					: [],
				columns: present ? f.db.query(`PRAGMA table_xinfo(${name})`).all() : [],
				rows: present
					? (
							f.db.query(`SELECT * FROM ${name}`).all() as Record<
								string,
								unknown
							>[]
						).map((r) =>
							Object.fromEntries(
								Object.entries(r).map(([k, v]) => [
									k,
									typeof v === "number" ? String(v) : v,
								]),
							),
						)
					: [],
			},
		]),
	) as Parameters<typeof reduceSessionTables>[0];
	const reduced = reduceSessionTables(tables);
	const entries = f.repo.getBranch("root");
	assert.deepEqual(
		reduced.privateParent[0]!.context,
		projectBranch(pathToRoot(entries, entries.at(-1)!.id)),
	);
	cases++;
}
{
	const f = fixture();
	f.repo.appendTurn(
		{ sessionKey: "root", role: "user", content: "x", ts: 1 },
		"original:1",
	);
	f.db.exec("ALTER TABLE session_entries ADD COLUMN future INTEGER");
	f.db.exec("UPDATE session_entries SET future=9007199254740993");
	const { plan } = await capture(f);
	const result = await f.engine().prepareQualification(KEY, plan.archiveId)
		.result;
	assert.equal(result!.qualification.parentLocal.reason, "unsupported_schema");
	cases++;
}
{
	const f = fixture(),
		{ header, parts } = await capture(f);
	for (const bound of ["sourceBytes"] as const) {
		const metadata = {
			...header.metadata,
			[bound]:
				bound === "sourceBytes"
					? SESSION_REHYDRATION_BYTES + 1
					: SESSION_REHYDRATION_ROWS + 1,
		};
		let consumed = false;
		const result = qualifySessionArchive(
			{
				*[Symbol.iterator]() {
					consumed = true;
					yield parts[0]!;
				},
			},
			metadata,
			header.selectorVersion,
			header.intent,
		);
		assert.equal(result.parentLocal.reason, "budget_unavailable");
		assert.equal(consumed, false);
	}
	cases++;
	const whole = Buffer.concat(parts);
	for (const bad of [
		whole.subarray(0, whole.length - 1),
		Buffer.concat([whole, Buffer.from("extra")]),
		Buffer.from(whole.toString().replace('"absent"', '"present"')),
	])
		assert.throws(() =>
			qualifySessionArchive(
				[bad],
				header.metadata,
				header.selectorVersion,
				header.intent,
			),
		);
	for (let split = 1; split < whole.length; split += 19) {
		const chunked = [whole.subarray(0, split), whole.subarray(split)];
		assert.equal(
			qualifySessionArchive(
				chunked,
				header.metadata,
				header.selectorVersion,
				header.intent,
			).parentLocal.status,
			"absent",
		);
	}
	cases++;
}
{
	const f = fixture();
	f.repo.appendTurn(
		{ sessionKey: "root", role: "user", content: "ORIGINAL", ts: 1 },
		"original:1",
	);
	const { plan } = await capture(f);
	const original = f.db
		.query("SELECT header FROM session_preservation_snapshot")
		.get();
	await assert.rejects(
		f
			.engine(async () => {
				f.db.exec("UPDATE session_entries SET content='CHANGED'");
			})
			.prepareQualification(KEY, plan.archiveId).result,
	);
	assert.deepEqual(
		f.db.query("SELECT header FROM session_preservation_snapshot").get(),
		original,
	);
	cases++;
}
console.log(`PASS session-state-rehydration ${cases}`);

// Exact semantic-record boundary, using original descriptor/raw/trailer accounting.
{
	const descriptor = (v: unknown) => Buffer.from(JSON.stringify(v) + "\n"),
		selector = "a".repeat(64);
	const build = (rows: number) => {
		const parts: Uint8Array[] = [
			descriptor([
				"format",
				"session-state-archive-v1",
				"selector",
				selector,
				"intent",
				intent,
			]),
			descriptor(["table", "session_entries", "present"]),
			descriptor([
				"schema",
				"session_entries",
				{
					type: "table",
					name: "session_entries",
					tbl_name: "session_entries",
					rootpage: 1,
					sql: "CREATE TABLE session_entries(future TEXT)",
				},
			]),
			descriptor([
				"column",
				"session_entries",
				{
					cid: 0,
					name: "future",
					type: "TEXT",
					notnull: 0,
					dflt_value: null,
					pk: 0,
					hidden: 0,
				},
			]),
		];
		for (let i = 0; i < rows; i++)
			parts.push(
				descriptor(["row", "session_entries", i]),
				descriptor(["cell", "future", "text", 0]),
				Buffer.from("\n"),
			);
		for (const name of SessionPreservationTableNames.slice(1))
			parts.push(descriptor(["table", name, "absent"]));
		return {
			parts,
			metadata: {
				sourceBytes: parts.reduce((n, b) => n + b.length, 0),
				recordCount: parts.length,
				tables: SessionPreservationTableNames.map((table, i) => ({
					table,
					present: i === 0,
					rows: i === 0 ? rows : 0,
				})),
			},
		};
	};
	const at = build(6663);
	assert.equal(at.metadata.recordCount, 20_000);
	assert.equal(
		qualifySessionArchive(at.parts, at.metadata, selector, intent).budget
			.exhausted,
		"semantic_work",
	);
	const over = build(6664);
	assert.equal(
		qualifySessionArchive(over.parts, over.metadata, selector, intent).budget
			.exhausted,
		"semantic_work",
	);
}
// The owning archived stream authenticates at the byte boundary, then the reader never writes.
{
	const f = fixture();
	f.repo.appendTurn(
		{ sessionKey: "bytes", role: "user", content: "x", ts: 1 },
		"byte:1",
	);
	const small = await f.engine().inspect(KEY);
	const payload = "x".repeat(
		SESSION_REHYDRATION_BYTES - small.metadata.sourceBytes,
	);
	f.db.query("UPDATE session_entries SET content=?").run(payload);
	let p = await f.engine().inspect(KEY);
	const correction = SESSION_REHYDRATION_BYTES - p.metadata.sourceBytes;
	f.db
		.query("UPDATE session_entries SET content=?")
		.run(payload + "x".repeat(Math.max(correction, 0)));
	if (correction < 0)
		f.db
			.query("UPDATE session_entries SET content=?")
			.run(payload.slice(0, correction));
	p = await f.engine().inspect(KEY);
	assert.equal(p.metadata.sourceBytes, SESSION_REHYDRATION_BYTES);
	await f.engine().capture(KEY, p.archiveId, p.proof);
	const before = f.writes();
	assert.equal(
		(await f.engine().prepareQualification(KEY, p.archiveId).result)!
			.qualification.budget.exhausted,
		"retained_bytes",
	);
	assert.equal(f.writes(), before);
}

// The row threshold and semantic-work limit are independent; authentic metadata never clips.
{
	const f = fixture();
	f.db.exec(
		"CREATE TABLE cf_agents_session_config (session_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY (session_id,key)) WITHOUT ROWID",
	);
	for (let i = 0; i < 20000; i++)
		f.db
			.query("INSERT INTO cf_agents_session_config VALUES(?,?,?)")
			.run("s", String(i), "v");
	const { plan } = await capture(f);
	const observed = (await f.engine().prepareQualification(KEY, plan.archiveId)
		.result)!.qualification;
	assert.equal(observed.budget.selectedRows, 20000);
	assert.equal(observed.budget.exhausted, "semantic_work");
	assert(observed.budget.processedRows < 20000);
	assert.equal(observed.parentLocal.reason, "budget_unavailable");
	const other = fixture();
	other.db.exec(
		"CREATE TABLE cf_agents_session_config (session_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY (session_id,key)) WITHOUT ROWID",
	);
	for (let i = 0; i < 20001; i++)
		other.db
			.query("INSERT INTO cf_agents_session_config VALUES(?,?,?)")
			.run("s", String(i), "v");
	const next = await capture(other);
	const over = (await other
		.engine()
		.prepareQualification(KEY, next.plan.archiveId).result)!.qualification;
	assert.equal(over.budget.selectedRows, 20001);
	assert.equal(over.budget.exhausted, "selected_rows");
	assert.equal(over.budget.processedRows, 0);
	assert.equal(over.budget.workUnits, 0);
	console.log(
		"PASS authenticated20k row threshold/charged work exhaustion;20001 preflight",
		observed.budget.processedRows,
		observed.budget.workUnits,
	);
}
{
	const b = new SessionSemanticBudget(0, 0, 10, () => 0);
	b.charge(0, 199999);
	assert.throws(() => b.charge(0, 2));
	assert.equal(b.witness.exhausted, "semantic_work");
	assert.equal(b.witness.workUnits, 199999);
	assert.equal(b.witness.attemptedCharge, 2);
	assert.throws(() => b.charge(99999999));
	assert.equal(b.witness.exhausted, "semantic_work");
	const retained = new SessionSemanticBudget(0, 0);
	retained.charge(0, 0, 8388608);
	retained.release(2);
	assert.throws(() => retained.charge(0, 0, 3));
	assert.equal(retained.witness.retainedAtFailure, 8388606);
	assert.equal(retained.witness.retainedBytes, 8388608);
	const deadline = new SessionSemanticBudget(0, 0, 1, () => 2);
	assert.throws(() => deadline.check());
	assert.equal(deadline.witness.exhausted, "time");
	assert.equal(deadline.witness.clockExpired, true);
	const parser = new SessionSemanticBudget(0, 0);
	assert.throws(() => parser.parse("[".repeat(129) + "0" + "]".repeat(129)));
	assert.equal(parser.witness.exhausted, null);
	console.log("PASS exact witness/first failure/depth preflight");
}

{
	const b = new SessionSemanticBudget(0, 0, 100, () => 0);
	b.charge(0, 199997);
	const values = ["a", "b"];
	assert.throws(() => new Set(b.indexInput(values)));
	assert.equal(b.witness.exhausted, "semantic_work");
	assert.ok(b.witness.attemptedCharge! > 0);
	const text = "🌒".repeat(20000),
		bytes = new TextEncoder().encode(text);
	let ticks = 0;
	const utf8 = new SessionSemanticBudget(0, 0, 1e9, () => {
		ticks++;
		return 0;
	});
	assert.equal(utf8.decodeText(bytes), text);
	assert.ok(ticks >= 5);
	const parsed = new SessionSemanticBudget(0, 0);
	parsed.charge(0, 0, 8388600);
	assert.throws(() => parsed.parse('"payload"'));
	assert.equal(parsed.witness.exhausted, "retained_bytes");
	assert.equal(parsed.witness.retainedAtFailure, 8388600);
	console.log(
		"Index insertion precharge, bounded Unicode decode and overlapping parsed retention passed",
	);
}
