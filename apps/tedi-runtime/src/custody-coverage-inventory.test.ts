import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import {
	prepareCustodyCoverage,
	type CustodyCoverageIdentity,
} from "./custody-coverage-inventory";
import {
	decryptTediSecret,
	encryptTediSecret,
} from "@tedix/db/utils/secrets-encryption";
const key = Buffer.alloc(32, 7).toString("base64");
const identity: CustodyCoverageIdentity = {
	rootPhysicalId: "a".repeat(64),
	targetPhysicalId: "a".repeat(64),
	organizationId: "00000000-0000-4000-8000-000000000001",
	tediId: "00000000-0000-4000-8000-000000000002",
	operationId: "fictional-inventory",
	namespaceClass: "AgentTediDO",
	targetName: "fictional-root",
	targetPath: [],
	generation: 1,
	receiver: "raw-cutover-v1",
};
function fixture() {
	const db = new Database(":memory:") as unknown as {
		exec(sql: string): void;
		query(sql: string): {
			all(...args: unknown[]): unknown[];
			run(...args: unknown[]): unknown;
		};
	};
	let writes = 0,
		fullDDL = 0;
	const storage = {
		sql: {
			exec(sql: string, ...args: SqlStorageValue[]) {
				if (/^(CREATE|INSERT|UPDATE|DELETE)/i.test(sql)) writes++;
				if (sql.startsWith("SELECT type,name,tbl_name,sql")) fullDDL++;
				const rows = db.query(sql).all(...(args as never[]));
				return {
					toArray: () => rows,
					[Symbol.iterator]: () => rows[Symbol.iterator](),
				};
			},
		},
		kv: {
			get: () => {
				throw Error("Unexpected KV value");
			},
			list: () => {
				throw Error("Unexpected KV enumeration");
			},
		},
	} as unknown as Pick<DurableObjectStorage, "sql">;
	const namespace = {
		idFromName: () => ({ toString: () => "b".repeat(64) }),
	} as unknown as Pick<DurableObjectNamespace, "idFromName">;
	const run = (
		extra: Partial<Parameters<typeof prepareCustodyCoverage>[0]> = {},
	) =>
		prepareCustodyCoverage({
			storage,
			identity,
			namespace,
			masterKey: key,
			deadline: performance.now() + 30000,
			recheck: () => {},
			verifyCanonical: async () => {},
			...extra,
		});
	return { db, storage, run, writes: () => writes, fullDDL: () => fullDDL };
}
let cases = 0;
{
	const f = fixture();
	f.db.exec(
		"CREATE TABLE session_entries(id TEXT PRIMARY KEY,content TEXT);INSERT INTO session_entries VALUES('private','SECRET_PAYLOAD');CREATE TABLE future_state(id INTEGER);CREATE INDEX future_index ON future_state(id);CREATE VIEW future_view AS SELECT * FROM future_state;CREATE TRIGGER future_trigger AFTER INSERT ON future_state BEGIN SELECT 1;END;CREATE TABLE generated(a INTEGER,b INTEGER GENERATED ALWAYS AS(a+1));CREATE TABLE SESSION_MESSAGES(id TEXT)",
	);
	const p = f.run(),
		r = await p.result;
	p.assertReady();
	const sql = r.items.filter((x) => x.domain === "sql");
	assert(
		sql.some(
			(x) =>
				x.name === "session_entries" &&
				x.memberships.includes("session8") &&
				x.classification === "declared",
		),
	);
	assert(
		sql.some(
			(x) => x.name === "future_state" && x.classification === "uncovered",
		),
	);
	assert(
		sql.some(
			(x) =>
				x.name === "future_view" &&
				x.shape === "view" &&
				x.classification === "unsupported",
		),
	);
	assert(sql.some((x) => x.name === "generated" && x.shape === "generated"));
	assert(!JSON.stringify(r).includes("SECRET_PAYLOAD"));
	assert.equal(f.writes(), 0);
	assert.equal(r.kv.complete, false);
	assert.equal(r.kv.keyCount, null);
	assert.equal(r.wholePreservationReady, false);
	cases++;
	f.db.exec("CREATE TABLE later(id INTEGER)");
	assert.throws(p.assertContinuity);
	cases++;
}
{
	const f = fixture();
	f.db.exec("CREATE VIRTUAL TABLE search USING fts5(content)");
	const r = await f.run().result;
	assert(
		r.items.some(
			(x) => x.domain === "sql" && x.name === "search" && x.shape === "virtual",
		),
	);
	assert(r.items.some((x) => x.domain === "sql" && x.shape === "shadow"));
	assert.equal(f.writes(), 0);
	cases++;
}
{
	const f = fixture();
	f.db.exec(
		"CREATE TABLE cf_agents_sub_agents(class TEXT,name TEXT,identity_version TEXT,identity_name TEXT)",
	);
	f.db
		.query("INSERT INTO cf_agents_sub_agents VALUES(?,?,?,?)")
		.run("ConversationFacet", "registered", "path-v2", "exact-physical");
	const r = await f.run().result;
	assert.equal(r.registeredTargets, 1);
	const child = r.items.find((x) => x.domain === "registry");
	assert(child && child.domain === "registry");
	assert.equal(child.identityName, "exact-physical");
	assert.equal(child.localOwner, "UNKNOWN");
	assert.equal(child.childGeneration, null);
	assert.equal(child.routingCustody, "not_queried");
	assert.equal("registryHash" in child, false);
	assert.equal(child.registryMetadataHash, r.registryHash);
	cases++;
}
{
	const f = fixture();
	for (let i = 0; i < 205; i++)
		f.db.exec(`CREATE TABLE table_${i}(id INTEGER)`);
	const r = await f.run().result;
	assert.equal(r.items.length, 200);
	assert(r.continuation);
	const plaintext = await decryptTediSecret(
		key,
		identity.tediId,
		r.continuation,
	);
	const cursor = JSON.parse(plaintext);
	assert.equal(cursor.expiresAt - cursor.issuedAt, 300000);
	assert.equal(cursor.purpose, "custody-coverage-metadata-page-v1");
	const next = await f.run({
		continuation: r.continuation,
		coverageHash: r.coverageHash,
	}).result;
	assert.equal(next.offset, 200);
	assert.equal(next.issuedAt, r.issuedAt);
	assert.equal(next.expiresAt, r.expiresAt);
	assert.equal(next.continuation, null);
	assert.equal(next.metadataEnumerationComplete, true);
	cases++;
	for (const change of [
		{ purpose: "other" },
		{ nextOffset: 1 },
		{ expiresAt: cursor.expiresAt + 1 },
		{ issuedAt: Date.now() + 1000000 },
		{ registryHash: "e".repeat(64) },
		{ identity: { ...cursor.identity, operationId: "other" } },
	]) {
		const c = await encryptTediSecret(
			key,
			identity.tediId,
			JSON.stringify({ ...cursor, ...change }),
		);
		await assert.rejects(
			f.run({ continuation: c, coverageHash: r.coverageHash }).result,
		);
		cases++;
	}
	f.db.exec("CREATE TABLE added(id INTEGER)");
	await assert.rejects(
		f.run({ continuation: r.continuation, coverageHash: r.coverageHash })
			.result,
	);
	cases++;
	await assert.rejects(
		f.run({ continuation: "x".repeat(131073), coverageHash: r.coverageHash })
			.result,
	);
	cases++;
}
{
	const f = fixture();
	f.db.exec(`CREATE TABLE oversized(id TEXT DEFAULT '${"x".repeat(65536)}')`);
	assert.throws(() => f.run());
	assert.equal(f.fullDDL(), 0);
	cases++;
}
{
	const f = fixture();
	const p = f.run({
		verifyCanonical: async () => {
			f.db.exec("CREATE TABLE mutated(id INTEGER)");
		},
	});
	await assert.rejects(p.result);
	assert.throws(p.assertReady);
	cases++;
}
{
	const f = fixture();
	const p = f.run({
		verifyCanonical: async () => {
			f.db.exec("CREATE TABLE mutated(id INTEGER)");
			throw Error("PRIVATE_ERROR");
		},
	});
	await assert.rejects(p.result, /Custody coverage unavailable/);
	cases++;
}
{
	const f = fixture();
	const p = f.run({
		deadline: performance.now() + 15,
		verifyCanonical: () => new Promise(() => {}),
	});
	await assert.rejects(p.result);
	assert.throws(p.assertReady);
	cases++;
}
{
	const f = fixture();
	const now = Date.now,
		base = now();
	Date.now = () => base;
	try {
		const p = f.run({
			verifyCanonical: async () => {
				Date.now = () => base + 300001;
			},
		});
		await assert.rejects(p.result);
	} finally {
		Date.now = now;
	}
	cases++;
}
{
	const f = fixture();
	f.db.exec("CREATE TABLE original(id INTEGER)");
	const carrier = {
		storage: f.storage,
		identity: { ...identity, targetPath: [] },
		namespace: {
			idFromName: () => ({ toString: () => "b".repeat(64) }),
		} as unknown as Pick<DurableObjectNamespace, "idFromName">,
		masterKey: key,
		deadline: performance.now() + 30000,
		recheck: () => {},
		verifyCanonical: async () => {},
		continuation: undefined as string | undefined,
		coverageHash: undefined as string | undefined,
	};
	carrier.verifyCanonical = async () => {
		await Promise.resolve();
		carrier.masterKey = "changed";
		carrier.deadline = 0;
		carrier.continuation = "not-a-cursor";
		carrier.coverageHash = "0".repeat(64);
		carrier.verifyCanonical = async () => {
			throw Error("changed callback");
		};
		carrier.recheck = () => {
			throw Error("changed guard");
		};
		carrier.identity.operationId = "changed";
	};
	const p = prepareCustodyCoverage(carrier),
		r = await p.result;
	p.assertReady();
	assert.equal(r.metadataEnumerationComplete, true);
	cases++;
}
{
	// Each metadata snapshot individually fits; retaining the original while
	// recapturing must refuse the aggregate overlap, rather than reset its budget.
	let overlap = false;
	for (let count = 70; count <= 150 && !overlap; count += 10) {
		const f = fixture();
		for (let i = 0; i < count; i++)
			f.db.exec(
				`CREATE TABLE sizable_${i}(id TEXT DEFAULT '${"x".repeat(5000)}')`,
			);
		let p: ReturnType<typeof prepareCustodyCoverage>;
		try {
			p = f.run();
		} catch {
			continue;
		}
		try {
			await p.result;
		} catch {
			overlap = true;
			assert.throws(p.assertReady);
		}
	}
	assert(
		overlap,
		"A retained-original/current-snapshot overlap must be charged",
	);
	cases++;
}
{
	const f = fixture();
	f.db.exec("CREATE TABLE _cf_KV(key TEXT,value BLOB)");
	const exec = f.storage.sql.exec;
	let columns = 0;
	f.storage.sql.exec = ((sql: string, ...args: SqlStorageValue[]) => {
		if (sql.includes("pragma_table_xinfo") && args[0] === "_cf_KV") {
			columns++;
			throw Error("provider private");
		}
		return exec.call(f.storage.sql, sql, ...args);
	}) as typeof exec;
	const r = await f.run().result;
	assert(
		r.items.some(
			(x) =>
				x.domain === "sql" &&
				x.name === "_cf_KV" &&
				x.shape === "provider_private" &&
				x.columnsHash === null &&
				x.classification === "unsupported",
		),
	);
	assert.equal(columns, 0);
	cases++;
	f.db.exec("CREATE TABLE ordinary(id TEXT)");
	f.storage.sql.exec = ((sql: string, ...args: SqlStorageValue[]) => {
		if (sql.includes("pragma_table_xinfo") && args[0] === "ordinary")
			throw Error("unrelated SQL failure");
		return exec.call(f.storage.sql, sql, ...args);
	}) as typeof exec;
	assert.throws(() => f.run(), /unrelated SQL failure/);
	cases++;
}

{
	const f = fixture();
	for (let i = 0; i < 205; i++)
		f.db.exec(`CREATE TABLE crypt_${i}(id INTEGER)`);
	const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
	let calls = 0;
	crypto.subtle.encrypt = (async (...args: Parameters<typeof encrypt>) => {
		calls++;
		const pending = encrypt(...args);
		queueMicrotask(() => f.db.exec("CREATE TABLE during_encrypt(id INTEGER)"));
		return await pending;
	}) as typeof crypto.subtle.encrypt;
	try {
		await assert.rejects(f.run().result);
		assert.equal(calls, 1);
	} finally {
		crypto.subtle.encrypt = encrypt;
	}
	cases++;
}
{
	const f = fixture();
	for (let i = 0; i < 205; i++)
		f.db.exec(`CREATE TABLE decrypt_${i}(id INTEGER)`);
	const first = await f.run().result;
	assert(first.continuation);
	const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
	let calls = 0;
	crypto.subtle.decrypt = (async (...args: Parameters<typeof decrypt>) => {
		calls++;
		const pending = decrypt(...args);
		queueMicrotask(() => f.db.exec("CREATE TABLE during_decrypt(id INTEGER)"));
		return await pending;
	}) as typeof crypto.subtle.decrypt;
	try {
		await assert.rejects(
			f.run({
				continuation: first.continuation,
				coverageHash: first.coverageHash,
			}).result,
		);
		assert.equal(calls, 1);
	} finally {
		crypto.subtle.decrypt = decrypt;
	}
	cases++;
}
{
	const f = fixture();
	for (let i = 0; i < 205; i++)
		f.db.exec(`CREATE TABLE expiry_${i}(id INTEGER)`);
	const encrypt = crypto.subtle.encrypt.bind(crypto.subtle),
		now = Date.now,
		base = now();
	let calls = 0;
	Date.now = () => base;
	crypto.subtle.encrypt = (async (...args: Parameters<typeof encrypt>) => {
		calls++;
		const pending = encrypt(...args);
		queueMicrotask(() => {
			Date.now = () => base + 300001;
		});
		return await pending;
	}) as typeof crypto.subtle.encrypt;
	try {
		await assert.rejects(f.run().result);
		assert.equal(calls, 1);
	} finally {
		crypto.subtle.encrypt = encrypt;
		Date.now = now;
	}
	cases++;
}
console.log(
	`Custody coverage owning cases ${cases} PASS; no writes/KV enumeration`,
);
