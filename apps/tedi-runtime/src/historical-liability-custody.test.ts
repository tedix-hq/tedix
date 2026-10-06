import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	CanonicalReader,
	CanonicalKVValue,
	StreamArray,
	StreamObject,
	writeCanonical,
} from "./historical-liability-stream-codec";
import {
	historicalCaptureItemBytes,
	HistoricalLiabilityCustody,
} from "./historical-liability-custody";
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
const objectId = "physical",
	owner = { objectId, tediId: "tedi", orgId: "org" };
const store = new HistoricalLiabilityCustody(storage, objectId);
const names = () =>
	storage.sql
		.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")
		.toArray();
assert.equal(store.read({ liabilityId: "a".repeat(64) }), null);
assert.equal(store.audit(), null);
store.assertNotSealed({ kind: "run", id: "unknown" });
assert.deepEqual(names(), []);
assert.throws(
	() => store.inspectSnapshot({ expectedGeneration: 1 }),
	/missing custody/,
);
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
	"CREATE TABLE cf_agents_fibers(fiber_id TEXT PRIMARY KEY,idempotency_key TEXT,name TEXT,status TEXT,metadata_json TEXT)",
);
for (let i = 0; i < 20; i++)
	storage.sql.exec(
		"INSERT INTO cf_agents_fibers VALUES (?,?,'original','interrupted',?)",
		`fiber${i}`,
		`key${i}`,
		JSON.stringify({ runId: "not-run-proof" }),
	);
const input = { expectedGeneration: 1 },
	inspected = store.inspectSnapshot(input);
assert.equal(inspected.fiberCount, 20);
assert.equal(inspected.identityCount, 40);
assert.throws(
	() => store.inspectSnapshot({ ...input, completion: true } as typeof input),
	/invalid fields/,
);
assert.throws(
	() => store.inspectSnapshot({ expectedGeneration: 2 }),
	/non-active/,
);
assert.throws(
	() => store.captureSnapshot({ ...input, expectedSourceHash: "a".repeat(64) }),
	/source changed/,
);
assert.equal(
	names().some((r) => r.name.startsWith("historical_")),
	false,
);
const captured = store.captureSnapshot({
	...input,
	expectedSourceHash: inspected.sourceHash,
});
assert.deepEqual(captured, inspected);
assert.deepEqual(
	store.captureSnapshot({ ...input, expectedSourceHash: inspected.sourceHash }),
	captured,
);
assert.deepEqual(store.audit(), captured);
const ref = storage.sql
	.exec<{ liability_id: string }>(
		"SELECT liability_id FROM historical_liability_refs ORDER BY liability_id",
	)
	.toArray()[0]!;
const r = store.read({ liabilityId: ref.liability_id })!;
assert.equal(r.exposure.providerUsage, "unknown");
assert.equal(r.exposure.estimatesAreBounds, false);
assert.equal(r.exposure.financialFacts, "not_observed");
assert.throws(
	() => store.assertNotSealed({ kind: "fiber", id: "fiber0" }),
	/permanently sealed/,
);
store.assertNotSealed({ kind: "run", id: "not-run-proof" });
storage.sql.exec(
	"UPDATE cf_agents_fibers SET status='running' WHERE fiber_id='fiber0'",
);
assert.throws(
	() =>
		store.captureSnapshot({
			...input,
			expectedSourceHash: inspected.sourceHash,
		}),
	/source changed/,
);
assert.throws(
	() =>
		store.captureSnapshot({
			...input,
			expectedSourceHash: store.inspectSnapshot(input).sourceHash,
		}),
	/immutable snapshot/,
);
assert.equal(
	store.read({ liabilityId: ref.liability_id })!.sdkRow.status,
	"interrupted",
);
storage.sql.exec(
	"DELETE FROM historical_replay_seals WHERE identity=(SELECT identity FROM historical_replay_seals LIMIT 1)",
);
assert.throws(
	() => store.assertNotSealed({ kind: "run", id: "never-seen" }),
	/compact links/,
);
assert.throws(
	() => store.read({ liabilityId: "b".repeat(64) }),
	/compact links/,
);
kv.set("computer-effect:é", { value: 1 });
kv.set("computer-effect:é", { value: 2 });
const ordered = store.inspectSnapshot(input).sourceHash;
kv.delete("computer-effect:é");
kv.delete("computer-effect:é");
kv.set("computer-effect:é", { value: 2 });
kv.set("computer-effect:é", { value: 1 });
assert.equal(store.inspectSnapshot(input).sourceHash, ordered);
kv.set("computer-effect:binary", new Uint8Array([1, 2]).buffer);
const binary = store.inspectSnapshot(input).sourceHash;
kv.set("computer-effect:binary", { bytes: [1, 2] });
assert.notEqual(store.inspectSnapshot(input).sourceHash, binary);
kv.set("computer-effect:array", Object.assign([1], { extra: "private" }));
assert.throws(
	() => store.inspectSnapshot(input),
	/unsupported source array properties/,
);
kv.delete("computer-effect:array");
kv.set("computer-effect:date", new Date());
assert.throws(() => store.inspectSnapshot(input), /unsupported source object/);
console.log("historical bulk snapshot source assertions passed");

// Fixed original-format bytes, including whole backing-buffer provenance and JSON surrogate spelling.
const value = {
	a: [null, true, -0, "😀\ud800"],
	b: new Uint16Array(new Uint8Array([9, 0, 1, 0, 2, 0]).buffer, 2, 2),
};
const golden = JSON.stringify([
	"object",
	"plain",
	[
		[
			"a",
			[
				"array",
				[["null"], ["boolean", true], ["number", "-0"], ["string", "😀\ud800"]],
			],
		],
		["b", ["view", "Uint16Array", [9, 0, 1, 0, 2, 0], 2, 4]],
	],
]);
const parts: Uint8Array[] = [];
const written = writeCanonical(value, (part) => parts.push(part.slice()));
assert.equal(new TextDecoder().decode(Buffer.concat(parts)), golden);
assert.equal(written.hash, createHash("sha256").update(golden).digest("hex"));
assert.deepEqual(new CanonicalReader(parts).value(), value);
const large = "😀é\ud800".repeat(250000),
	chunks: Uint8Array[] = [];
const largeWritten = writeCanonical(large, (bytes) =>
	chunks.push(bytes.slice()),
);
const largeGolden = JSON.stringify(["string", large]);
assert.equal(
	largeWritten.hash,
	createHash("sha256").update(largeGolden).digest("hex"),
);
assert.equal(largeWritten.bytes, new TextEncoder().encode(largeGolden).length);
assert.ok(chunks.length > 2);
assert.ok(chunks.slice(0, -1).every((chunk) => chunk.length === 1_000_000));
const largeReader = new CanonicalReader(chunks);
assert.equal(largeReader.value(), large);
largeReader.finish();
const shared = { private: "same" };
assert.throws(
	() => writeCanonical(new StreamArray(() => [shared, shared])),
	/reference topology/,
);
assert.throws(
	() => writeCanonical(new StreamObject({ a: shared, b: shared })),
	/reference topology/,
);
for (const malformed of [
	'["view","Uint16Array",[1,2,3],0,3]',
	'["view","Uint16Array",[1,2,3,4],1,2]',
	'["object","plain",[["a",["null"]],["a",["null"]]]]',
	'["string","\\u0061"]',
	'["number",-0]',
	'["buffer",[256]]',
])
	assert.throws(
		() => new CanonicalReader([new TextEncoder().encode(malformed)]).value(),
		/Historical liability/,
	);
console.log(
	"historical streaming codec golden and corruption assertions passed",
);

// The opt-in boundary is one selected KV value; old unaliased bytes are exactly unchanged.
function kvEncoding(value: unknown): string {
	const chunks: Uint8Array[] = [];
	writeCanonical(new CanonicalKVValue(value), (bytes) =>
		chunks.push(bytes.slice()),
	);
	return new TextDecoder().decode(Buffer.concat(chunks));
}
assert.equal(kvEncoding(value), golden);
const dag = { a: shared, b: shared };
const dagGolden =
	'["graph",1,["def",0,["object","plain",[["a",["def",1,["object","plain",[["private",["string","same"]]]]]],["b",["ref",1]]]]]]';
assert.equal(kvEncoding(dag), dagGolden);
assert.equal(kvEncoding({ b: shared, a: shared }), dagGolden);
const restored = new CanonicalReader([
	new TextEncoder().encode(dagGolden),
]).value(true) as typeof dag;
assert.equal(restored.a, restored.b);
assert.equal(kvEncoding(restored), dagGolden);
assert.notEqual(kvEncoding({ a: { ...shared }, b: { ...shared } }), dagGolden);
assert.throws(
	() => new CanonicalReader([new TextEncoder().encode(dagGolden)]).value(),
	/graph scope/,
);
const emptyProto = Object.assign(
	Object.create(null) as Record<string, unknown>,
	{ __proto__: "private" },
);
Object.defineProperty(emptyProto, "__proto__", {
	value: "private",
	enumerable: true,
});
const nestedDag = { a: [emptyProto, emptyProto], b: [shared, shared] };
const nestedRestored = new CanonicalReader([
	new TextEncoder().encode(kvEncoding(nestedDag)),
]).value(true) as typeof nestedDag;
assert.equal(nestedRestored.a[0], nestedRestored.a[1]);
assert.equal(Object.getPrototypeOf(nestedRestored.a[0]), null);
assert.equal(
	(nestedRestored.a[0] as Record<string, unknown>)["__proto__"],
	"private",
);
assert.equal(nestedRestored.b[0], nestedRestored.b[1]);
assert.equal(kvEncoding(nestedRestored), kvEncoding(nestedDag));
for (const malformed of [
	'["graph",2,["null"]]',
	'["graph",1,["ref",0]]',
	'["graph",1,["def",1,["array",[]]]]',
	'["graph",1,["def",0,["array",[["ref",0]]]]]',
	'["graph",1,["def",0,["array",[]]]]',
	'["graph",1,["def",0,["array",[["def",1,["array",[]]],["def",1,["array",[]]]]]]]',
	'["graph",1,["def",0,["array",[["ref",1],["def",1,["array",[]]]]]]]',
	'["graph",1,["def",0,["array",[["def",1,["buffer",[1]]],["ref",1]]]]]',
	'["graph",1,["def",0,["def",1,["array",[]]]]]',
	'["graph",1,["def",0,["array",[["array",[]]]]]]',
	'["graph",1,["def",0,["array",[["graph",1,["null"]]]]]]',
	'["graph",1,["def",0,["object","plain",[["b",["def",1,["array",[]]]],["a",["ref",1]]]]]]',
])
	assert.throws(
		() =>
			new CanonicalReader([new TextEncoder().encode(malformed)]).value(true),
		/Historical liability/,
	);
const cyclic: { self?: unknown } = {};
cyclic.self = cyclic;
const sameBuffer = new ArrayBuffer(4);
for (const unsupported of [
	cyclic,
	{ a: new Uint8Array(sameBuffer), b: new Uint8Array(sameBuffer, 1, 2) },
	{ a: sameBuffer, b: sameBuffer },
	{ a: shared, b: shared, c: new Date() },
	Object.assign([shared, shared], { extra: "private" }),
]) {
	assert.throws(() => kvEncoding(unsupported), /Historical liability/);
}
// A scope cannot reference an earlier KV value. Supported independent items still retain V1 framing.
const scopedParts: Uint8Array[] = [];
writeCanonical(
	new StreamArray(() => [
		["one", new CanonicalKVValue(dag)],
		["two", new CanonicalKVValue(dag)],
	]),
	(bytes) => scopedParts.push(bytes.slice()),
);
const scoped: Array<[string, typeof dag]> = [];
const scopedReader = new CanonicalReader(scopedParts);
scopedReader.array(() => {
	let key = "",
		value: typeof dag;
	scopedReader.array((index) => {
		if (index === 0) key = scopedReader.value() as string;
		else value = scopedReader.value(true) as typeof dag;
	});
	scoped.push([key, value!]);
});
scopedReader.finish();
assert.equal(scoped[0]![1].a, scoped[0]![1].b);
assert.equal(scoped[1]![1].a, scoped[1]![1].b);
assert.notEqual(scoped[0]![1].a, scoped[1]![1].a);
console.log(
	"historical per-KV DAG bytes, alias identity and malformed-scope assertions passed",
);

// Opt-in permits a graph at the value root, never arbitrary nested graph wrappers in an old tree.
assert.throws(
	() =>
		new CanonicalReader([
			new TextEncoder().encode('["array",[' + dagGolden + "]]"),
		]).value(true),
	/graph scope/,
);

for (const oldSupported of [
	null,
	false,
	-0,
	"😀\ud800",
	[],
	{},
	Object.create(null),
	new Uint8Array([1, 2]).buffer,
	new DataView(new Uint8Array([9, 1, 2, 8]).buffer, 1, 2),
	new BigInt64Array([1n, -1n]),
]) {
	const plainParts: Uint8Array[] = [];
	writeCanonical(oldSupported, (part) => plainParts.push(part.slice()));
	assert.equal(
		kvEncoding(oldSupported),
		new TextDecoder().decode(Buffer.concat(plainParts)),
	);
}
const binaryLeaf = new Uint16Array(
	new Uint8Array([9, 0, 1, 0, 2, 0]).buffer,
	2,
	2,
);
const dagWithBinary = { a: shared, b: shared, c: binaryLeaf };
const binaryRestored = new CanonicalReader([
	new TextEncoder().encode(kvEncoding(dagWithBinary)),
]).value(true) as typeof dagWithBinary;
assert.equal(binaryRestored.a, binaryRestored.b);
assert.equal(binaryRestored.c.byteOffset, 2);
assert.deepEqual(
	Array.from(new Uint8Array(binaryRestored.c.buffer)),
	[9, 0, 1, 0, 2, 0],
);
assert.equal(kvEncoding(binaryRestored), kvEncoding(dagWithBinary));

const itemParts: Uint8Array[] = [];
const itemWritten = writeCanonical(
	["actual-key", new CanonicalKVValue(dag)],
	(bytes) => itemParts.push(bytes.slice()),
);
assert.equal(
	historicalCaptureItemBytes(["actual-key", dag]),
	itemWritten.bytes,
);
assert.equal(
	new TextDecoder().decode(Buffer.concat(itemParts)),
	'["array",[["string","actual-key"],' + dagGolden + "]]",
);
for (const invalidItem of [
	null,
	dag,
	[1, dag],
	["key"],
	["key", dag, "extra"],
	Object.assign(["key", dag], { private: true }),
])
	assert.throws(
		() => historicalCaptureItemBytes(invalidItem),
		/invalid source KV fields/,
	);
const viewParent = { nested: { view: new Uint8Array([1, 2]) } };
assert.throws(
	() => kvEncoding({ a: viewParent, b: viewParent }),
	/reference topology/,
);
const binaryRef =
	'["graph",1,["def",0,["array",[["def",1,["object","plain",[["view",["view","Uint8Array",[1,2],0,2]]]]],["ref",1]]]]]';
assert.throws(
	() => new CanonicalReader([new TextEncoder().encode(binaryRef)]).value(true),
	/graph reference/,
);

// Original legacy/registry facts influence the source; they do not become SDK replay identities.
kv.delete("computer-effect:date");
for (const table of [
	"assistant_messages",
	"assistant_compactions",
	"assistant_sessions",
	"assistant_fts",
	"cf_agents_sub_agents",
]) {
	const before = store.inspectSnapshot(input).sourceHash;
	storage.sql.exec(
		`CREATE TABLE ${table}(id TEXT PRIMARY KEY,content BLOB,unknown TEXT)`,
	);
	storage.sql.exec(
		`INSERT INTO ${table} VALUES ('original',?,NULL)`,
		new Uint8Array([0, 255, 1]).buffer,
	);
	const original = store.inspectSnapshot(input).sourceHash;
	assert.notEqual(original, before);
	storage.sql.exec(`UPDATE ${table} SET unknown='changed' WHERE id='original'`);
	assert.notEqual(store.inspectSnapshot(input).sourceHash, original);
	storage.sql.exec(`UPDATE ${table} SET unknown=NULL WHERE id='original'`);
	assert.equal(store.inspectSnapshot(input).sourceHash, original);
}
console.log(
	"historical original assistant and registry source sensitivity assertions passed",
);
