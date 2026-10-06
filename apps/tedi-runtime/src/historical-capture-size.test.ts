import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import {
	decryptTediSecret,
	encryptTediSecret,
} from "@tedix/db/utils/secrets-encryption";
import {
	inspectHistoricalCaptureSize,
	captureSqlSizes,
} from "./historical-capture-size";
import {
	HISTORICAL_CAPTURE_SELECTORS,
	historicalCaptureItemBytes,
	historicalCaptureSelectorVersion,
} from "./historical-liability-custody";
const sql = new Database(":memory:");
sql.run("CREATE TABLE cf_agents_fibers(a TEXT,b BLOB,c INTEGER,n TEXT)");
sql.run("INSERT INTO cf_agents_fibers VALUES (?,?,?,NULL)", [
	"😀",
	new Uint8Array([1, 2, 3]),
	-123,
]);
const kv = new Map<string, unknown>([
	["PRIVATE:irrelevant", "x".repeat(1_000_000)],
	["wfctx:PRIVATE_FIRST", { private: "😀" }],
	["wfctx:PRIVATE_SECOND", new Uint8Array([3, 2, 1])],
]);
for (let i = 0; i < 32; i++)
	kv.set(`wfctx:ZZ_PRIVATE_${String(i).padStart(2, "0")}`, { index: i });
const selected = [...kv]
	.filter(([key]) => key.startsWith("wfctx:"))
	.sort(([a], [b]) => (a < b ? -1 : 1));
const encodedBytes = (pairs: Array<[string, unknown]>) =>
	pairs.reduce((sum, pair) => sum + historicalCaptureItemBytes(pair), 0);
const requests: SyncKvListOptions[] = [];
const storage = {
	sql: {
		exec(q: string, ...args: SqlStorageValue[]) {
			const rows = sql.query(q).all(...(args as never[]));
			return { toArray: () => rows };
		},
	},
	kv: {
		get(k: string) {
			assert(!k.startsWith("PRIVATE:"));
			return kv.get(k);
		},
		list(options?: SyncKvListOptions) {
			assert(options?.prefix);
			assert.equal(options.limit, 1);
			requests.push(options);
			return [...kv]
				.filter(
					([key]) =>
						key.startsWith(options.prefix!) &&
						(!options.start || key >= options.start) &&
						(!options.end || key < options.end) &&
						(!options.startAfter || key > options.startAfter),
				)
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.slice(0, 1)
				.values();
		},
	},
} as unknown as Pick<DurableObjectStorage, "sql" | "kv">;
const identity = {
	objectId: "a".repeat(64),
	tediId: crypto.randomUUID(),
	orgId: crypto.randomUUID(),
	objectName: "root",
	generation: 0,
};
const masterKey = Buffer.alloc(32, 7).toString("base64");
const input = { storage, identity, masterKey, recheck: () => {} };
const measured = captureSqlSizes(storage).find(
	(row) => row.category === "sdk" && row.selector === 1,
)!;
assert.deepEqual(measured, {
	category: "sdk",
	selector: 1,
	present: true,
	rows: 1,
	castValueBytes: 11,
	maxRowCastValueBytes: 11,
});
const snapshot = () => ({
	tables: sql.query("SELECT name,sql FROM sqlite_master").all(),
	rows: sql.query("SELECT * FROM cf_agents_fibers").all(),
	kv: [...kv],
});
const original = snapshot();
let page = await inspectHistoricalCaptureSize(input);
assert.equal(page.kv.entries, 32);
assert.equal(page.kv.canonicalItemBytes, encodedBytes(selected.slice(0, 32)));
assert.equal(page.complete, false);
assert(!JSON.stringify(page).includes("PRIVATE"));
assert.equal(page.selectorVersion, historicalCaptureSelectorVersion());
assert.equal(
	page.sql.length,
	HISTORICAL_CAPTURE_SELECTORS.factTables.length +
		HISTORICAL_CAPTURE_SELECTORS.historyTables.length +
		2,
);
const cursor = page.continuation!;
page = await inspectHistoricalCaptureSize({ ...input, continuation: cursor });
assert.equal(page.kv.entries, 2);
assert.deepEqual(page.sql, []);
assert.equal(page.kv.canonicalItemBytes, encodedBytes(selected.slice(32)));
assert.equal(page.complete, true);
assert.equal(page.continuation, undefined);
assert.deepEqual(snapshot(), original);
for (const changed of [
	{ generation: 1 },
	{ objectId: "b".repeat(64) },
	{ orgId: crypto.randomUUID() },
	{ objectName: "foreign" },
	{ tediId: crypto.randomUUID() },
])
	await assert.rejects(
		inspectHistoricalCaptureSize({
			...input,
			identity: { ...identity, ...changed },
			continuation: cursor,
		}),
	);
await assert.rejects(
	inspectHistoricalCaptureSize({ ...input, continuation: "PRIVATE" }),
);
const payload = JSON.parse(
	await decryptTediSecret(masterKey, identity.tediId, cursor),
);
for (const changed of [
	{ purpose: "foreign" },
	{ selectorVersion: "foreign" },
	{ position: 99999 },
	{ startAfter: "PRIVATE:foreign" },
	{ extra: "PRIVATE" },
]) {
	const token = await encryptTediSecret(
		masterKey,
		identity.tediId,
		JSON.stringify({ ...payload, ...changed }),
	);
	await assert.rejects(
		inspectHistoricalCaptureSize({ ...input, continuation: token }),
	);
}
let checks = 0;
await assert.rejects(
	inspectHistoricalCaptureSize({
		...input,
		continuation: cursor,
		recheck: () => {
			if (++checks === 1) throw Error("owner changed during decrypt");
		},
	}),
);
checks = 0;
await assert.rejects(
	inspectHistoricalCaptureSize({
		...input,
		recheck: () => {
			if (++checks === 2) throw Error("owner changed during encrypt");
		},
	}),
);
assert(requests.every((request) => request.limit === 1 && request.prefix));
console.log("historical capture size source proof passed");

// New native preservation selectors never redefine existing immutable selector digests.
const frozenSelector = historicalCaptureSelectorVersion();
const { NATIVE_PRESERVATION_TABLES } =
	await import("./native-state-preservation");
assert.equal(NATIVE_PRESERVATION_TABLES.length, 23);
assert(
	!HISTORICAL_CAPTURE_SELECTORS.factTables.includes(
		"runtime_admission_operations" as never,
	),
);
assert.equal(historicalCaptureSelectorVersion(), frozenSelector);
