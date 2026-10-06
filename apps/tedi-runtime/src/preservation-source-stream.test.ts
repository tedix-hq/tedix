import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	streamSqlTable,
	encodePrivateKvValue,
} from "./preservation-source-stream";
const refuse = (): never => {
	throw Error("owning refusal");
};
assert.equal(
	Buffer.from(encodePrivateKvValue(undefined, refuse)).toString(),
	'["undefined"]\n',
);
assert.equal(
	Buffer.from(
		encodePrivateKvValue(
			{ x: Object.assign(Array(3), { 1: -0, 2: undefined }) },
			refuse,
		),
	).toString(),
	'["object",[["x",["array",[["hole"],["present",["number","-0"]],["present",["undefined"]]]]]]]\n',
);
assert.equal(
	Buffer.from(
		encodePrivateKvValue(new Uint8Array([0, 255]), refuse),
	).toString(),
	'["uint8-array","AP8="]\n',
);
assert.notDeepEqual(
	encodePrivateKvValue(new Uint8Array([0, 255]), refuse),
	encodePrivateKvValue(new Uint8Array([0, 255]).buffer, refuse),
);
for (const v of [
	new Date(),
	new Map(),
	BigInt(1),
	new Uint8Array(800000),
	Object.setPrototypeOf([], {}),
])
	assert.throws(() => encodePrivateKvValue(v, refuse));
const db = new Database(":memory:") as unknown as {
	exec(q: string): void;
	query(q: string): {
		all(...v: unknown[]): Record<string, unknown>[];
		run(...v: unknown[]): unknown;
	};
};
const storage = {
	sql: {
		exec: (q: string, ...args: unknown[]) => {
			const rows = db
				.query(q)
				.all(
					...args.map((v: any) =>
						v instanceof ArrayBuffer ? new Uint8Array(v) : v,
					),
				);
			return { [Symbol.iterator]: () => rows[Symbol.iterator]() };
		},
	},
} as unknown as Pick<DurableObjectStorage, "sql">;
db.exec(
	"CREATE TABLE fixture(a TEXT,b BLOB,c INTEGER,d REAL,e TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID",
);
db.query("INSERT INTO fixture VALUES(?,?,9223372036854775807,1.25,NULL)").run(
	"private\0unicode🌒" + "x".repeat(1100000),
	new Uint8Array([0, 255]),
);
// The large composite locator deliberately refuses; the same large payload under a bounded locator streams.
assert.throws(() => [...streamSqlTable(storage, "fixture", refuse)]);
db.exec(
	"CREATE TABLE payload(id INTEGER PRIMARY KEY,a TEXT,b BLOB,c INTEGER,d REAL,e TEXT)",
);
db.query("INSERT INTO payload VALUES(1,?,?,9223372036854775807,1.25,NULL)").run(
	"private\0unicode🌒" + "x".repeat(1100000),
	new Uint8Array(1100000),
);
const frames = [...streamSqlTable(storage, "payload", refuse)];
const combined = Buffer.concat(frames);
assert.ok(
	combined.includes(
		Buffer.from('["cell","c","integer","9223372036854775807"]\n'),
	),
);
assert.ok(combined.includes(Buffer.from('["cell","d","real",8]\n')));
assert.ok(combined.includes(Buffer.from('["cell","e","null",0]\n')));
assert.ok(frames.every((f) => f.byteLength <= 65536));
// Independently reproduced from original 20a581 Session8 tableFrames.
const digest = createHash("sha256").update(combined).digest("hex");
assert.equal(
	digest,
	"79411687313bf2b105a0cbb40c00066bba749d5e5fbce423ef8512676279fe8f",
);
console.log("shared live SQL and native KV exact frame goldens PASS");

// Composite locators retain exact INTEGER boundaries and bounded payload reads.
db.exec(
	"CREATE TABLE bounded(a TEXT,b BLOB,c INTEGER,d REAL,e TEXT,PRIMARY KEY(a,b)) WITHOUT ROWID",
);
db.query(
	"INSERT INTO bounded VALUES(?,?, -9223372036854775808, -1.25,NULL)",
).run("unicode🌒", new Uint8Array([0, 255]));
const bounded = Buffer.concat([...streamSqlTable(storage, "bounded", refuse)]);
assert.ok(
	bounded.includes(
		Buffer.from('["cell","c","integer","-9223372036854775808"]\n'),
	),
);
const real = Buffer.alloc(8);
real.writeDoubleBE(-1.25);
assert.ok(
	bounded.includes(
		Buffer.concat([Buffer.from('["cell","d","real",8]\n'), real]),
	),
);

// The descriptor must still be yielded before the TEXT/BLOB payload is read.
db.exec("CREATE TABLE ordering(id INTEGER PRIMARY KEY,payload BLOB)");
db.query("INSERT INTO ordering VALUES(1,?)").run(new Uint8Array([1, 2]));
const iterator = streamSqlTable(storage, "ordering", refuse);
let payload: Uint8Array | undefined;
for (const frame of iterator) {
	if (Buffer.from(frame).toString() === '["cell","payload","blob",2]\n') {
		db.query("UPDATE ordering SET payload=? WHERE id=1").run(
			new Uint8Array([3, 4]),
		);
		payload = iterator.next().value;
		break;
	}
}
assert.deepEqual(payload, new Uint8Array([3, 4]));
iterator.return(undefined);
const failedStorage = {
	sql: {
		exec(q: string, ...args: SqlStorageValue[]) {
			if (q.startsWith("SELECT substr"))
				throw new Error("provider read refused");
			return storage.sql.exec(q, ...args);
		},
	},
} as Pick<DurableObjectStorage, "sql">;
assert.throws(
	() => [...streamSqlTable(failedStorage, "ordering", refuse)],
	/provider read refused/,
);
console.log(
	"Composite scalar boundaries, payload yield ordering and provider refusal PASS",
);
