import { env } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { getAgentByName } from "agents";
import { expect, it } from "vite-plus/test";
import type { DiagnosticParent } from "./worker";
function namespace() {
	return (
		env as unknown as { TEDI_AGENT: DurableObjectNamespace<DiagnosticParent> }
	).TEDI_AGENT;
}
const tables = [
	"cf_agents_session_messages",
	"cf_agents_session_message_chunks",
	"cf_agents_session_compactions",
	"cf_agents_session_config",
	"cf_agents_session_attachment_meta",
	"cf_agents_session_attachment_chunks",
	"cf_agents_session_attachment_refs",
	"assistant_messages",
	"assistant_compactions",
	"assistant_sessions",
	"assistant_fts",
];
function snapshot(ctx: DurableObjectState) {
	return {
		sql: tables.map((table) => ({
			table,
			rows: ctx.storage.sql
				.exec(`SELECT * FROM ${table} ORDER BY 1,2`)
				.toArray(),
		})),
		kv: ctx.storage.kv.get("fixture:private-history"),
		marker: ctx.storage.kv.get("cf_agents:sessions_schema_version"),
	};
}
it("actual parent SDK startup and diagnostics create no Sessions schema or migration marker", async () => {
	const stub = await getAgentByName(namespace(), crypto.randomUUID());
	const diag = await stub.diagnostic();
	expect(diag).toMatchObject({
		ok: true,
		privateHistoryReads: 0,
		queue: { depth: 0 },
		schedules: { count: 0 },
		state: { recentTurns: 0 },
		artifacts: null,
	});
	expect(diag).not.toHaveProperty("compaction");
	await runInDurableObject(stub, (_instance, ctx) => {
		expect(ctx.storage.kv.get("fixture:started")).toBe(true);
		expect(
			ctx.storage.sql
				.exec(
					"SELECT name FROM sqlite_master WHERE name LIKE 'cf_agents_session_%' OR name LIKE 'cf_agents_attachment_%'",
				)
				.toArray(),
		).toEqual([]);
		expect(
			ctx.storage.kv.get("cf_agents:sessions_schema_version"),
		).toBeUndefined();
	});
});
it("preserves original private history/chunks/compactions and assistant tables across native eviction", async () => {
	const name = crypto.randomUUID();
	let stub = await getAgentByName(namespace(), name);
	await stub.diagnostic();
	const before = await runInDurableObject(stub, (_instance, ctx) => {
		// Actual pinned Sessions WITHOUT ROWID layouts, including native private bytes.
		const ddl = [
			"CREATE TABLE cf_agents_session_messages(session_id TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,parent_id TEXT,type TEXT NOT NULL DEFAULT 'message',role TEXT NOT NULL,content TEXT NOT NULL,content_chunks INTEGER NOT NULL DEFAULT 0,token_estimate INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,content_hash TEXT,PRIMARY KEY(session_id,id)) WITHOUT ROWID",
			"CREATE TABLE cf_agents_session_message_chunks(session_id TEXT NOT NULL,id TEXT NOT NULL,idx INTEGER NOT NULL,content TEXT NOT NULL,PRIMARY KEY(session_id,id,idx)) WITHOUT ROWID",
			"CREATE TABLE cf_agents_session_compactions(session_id TEXT NOT NULL,id TEXT NOT NULL,seq INTEGER NOT NULL,summary TEXT NOT NULL,from_message_id TEXT NOT NULL,to_message_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(session_id,id)) WITHOUT ROWID",
			"CREATE TABLE cf_agents_session_config(session_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(session_id,key)) WITHOUT ROWID",
			"CREATE TABLE cf_agents_session_attachment_meta(hash TEXT PRIMARY KEY,bytes INTEGER NOT NULL,media_type TEXT NOT NULL,chunks INTEGER NOT NULL) WITHOUT ROWID",
			"CREATE TABLE cf_agents_session_attachment_chunks(hash TEXT NOT NULL,idx INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(hash,idx)) WITHOUT ROWID",
			"CREATE TABLE cf_agents_session_attachment_refs(session_id TEXT NOT NULL,message_id TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(session_id,message_id,hash)) WITHOUT ROWID",
			"CREATE TABLE assistant_messages(session_id TEXT,id TEXT PRIMARY KEY,parent_id TEXT,role TEXT,content TEXT,created_at TEXT)",
			"CREATE TABLE assistant_compactions(session_id TEXT,id TEXT PRIMARY KEY,summary TEXT,from_message_id TEXT,to_message_id TEXT,created_at TEXT)",
			"CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY,content TEXT)",
			"CREATE TABLE assistant_fts(id TEXT PRIMARY KEY,content TEXT)",
		];
		for (const sql of ddl) ctx.storage.sql.exec(sql);
		for (const sql of [
			"INSERT INTO cf_agents_session_messages VALUES ('','message',1,NULL,'message','user','private message',1,8,1,NULL)",
			"INSERT INTO cf_agents_session_message_chunks VALUES ('','message',1,'private chunk')",
			"INSERT INTO cf_agents_session_compactions VALUES ('','compact',2,'private summary','message','message',2)",
			"INSERT INTO cf_agents_session_config VALUES ('','private','original')",
			"INSERT INTO cf_agents_session_attachment_meta VALUES ('hash',4,'image/png',1)",
			"INSERT INTO cf_agents_session_attachment_refs VALUES ('','message','hash')",
			"INSERT INTO assistant_messages VALUES ('','legacy',NULL,'user','private legacy','2026-10-04')",
			"INSERT INTO assistant_compactions VALUES ('','legacy-compact','legacy summary','legacy','legacy','2026-10-04')",
			"INSERT INTO assistant_sessions VALUES ('legacy','private session')",
			"INSERT INTO assistant_fts VALUES ('legacy','private search')",
		])
			ctx.storage.sql.exec(sql);
		ctx.storage.sql.exec(
			"INSERT INTO cf_agents_session_attachment_chunks VALUES ('hash',0,?)",
			new Uint8Array([0, 255, 1, 128]).buffer,
		);

		ctx.storage.kv.put("fixture:private-history", {
			private: "original",
			bytes: new Uint8Array([255, 0]),
		});
		return snapshot(ctx);
	});
	expect(await stub.proveReadGuard()).toBe(true);
	expect(await stub.diagnostic()).not.toHaveProperty("compaction");
	await abortAllDurableObjects();
	stub = await getAgentByName(namespace(), name);
	expect(await stub.diagnostic()).toMatchObject({
		ok: true,
		privateHistoryReads: 0,
		queue: { depth: 0 },
		state: { recentTurns: 0 },
	});
	expect(
		await runInDurableObject(stub, (_instance, ctx) => snapshot(ctx)),
	).toEqual(before);
});
