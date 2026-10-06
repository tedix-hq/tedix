import { env } from "cloudflare:workers";
import { runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { describe, it, expect } from "vite-plus/test";
import { createHash } from "node:crypto";
import {
	historicalCaptureItemBytes,
	HistoricalLiabilityCustody,
	HISTORICAL_CAPTURE_SELECTORS,
} from "../../src/historical-liability-custody";
import { captureSqlSizes } from "../../src/historical-capture-size";
import { RuntimeAdmission } from "../../src/runtime-admission";
import type { PiCutoverEarlyReturnFixture } from "./worker";
// Same sorted JSON hash shape as the original Raw observation producer, independent of archive tags.
function observationJSON(value: unknown): string {
	return JSON.stringify(value, (_key, child: unknown) =>
		child && typeof child === "object" && !Array.isArray(child)
			? Object.fromEntries(
					Object.keys(child)
						.sort()
						.map((key) => [key, (child as Record<string, unknown>)[key]]),
				)
			: child,
	);
}
function fixture() {
	const ns = (
		env as unknown as {
			PI_CUTOVER_EARLY: DurableObjectNamespace<PiCutoverEarlyReturnFixture>;
		}
	).PI_CUTOVER_EARLY;
	return ns.get(ns.idFromName(crypto.randomUUID()));
}
function seed(ctx: DurableObjectState, anonymous = false) {
	const owner = {
		objectId: ctx.id.toString(),
		tediId: anonymous ? null : "actual-tedi",
		orgId: anonymous ? null : "actual-org",
	};
	const gate = new RuntimeAdmission(ctx.storage, owner, () => {
		throw new Error("unexpected admission verification");
	});
	gate.initialize({
		operationId: "explicit-quarantine",
		state: "quarantined",
		reason: "unknown_history",
	});
	ctx.storage.sql.exec(
		"CREATE TABLE cf_agents_state(id TEXT PRIMARY KEY,state TEXT)",
	);
	ctx.storage.sql.exec(
		"INSERT INTO cf_agents_state VALUES ('cf_state_row_id',?)",
		JSON.stringify({ tediId: owner.tediId, orgId: owner.orgId }),
	);
	ctx.storage.sql.exec(
		"CREATE TABLE cf_agents_workflows(id TEXT PRIMARY KEY NOT NULL,workflow_id TEXT NOT NULL UNIQUE,workflow_name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('queued','running','paused','errored','terminated','complete','waiting','waitingForPause','unknown')),metadata TEXT,error_name TEXT,error_message TEXT,created_at INTEGER NOT NULL DEFAULT (unixepoch()),updated_at INTEGER NOT NULL DEFAULT (unixepoch()),completed_at INTEGER)",
	);
	ctx.storage.sql.exec(
		"INSERT INTO cf_agents_workflows(id,workflow_id,workflow_name,status,metadata,created_at) VALUES ('tracking','workflow','CHAT_TURN_WORKFLOW','queued',?,123)",
		JSON.stringify({ runId: "metadata-is-not-proof" }),
	);
	ctx.storage.sql.exec(
		"CREATE TABLE cf_agents_fibers(fiber_id TEXT PRIMARY KEY,idempotency_key TEXT UNIQUE,name TEXT NOT NULL,status TEXT NOT NULL,snapshot TEXT,metadata_json TEXT,error_message TEXT,created_at INTEGER NOT NULL,started_at INTEGER,completed_at INTEGER)",
	);
	ctx.storage.sql.exec(
		"INSERT INTO cf_agents_fibers(fiber_id,idempotency_key,name,status,metadata_json,snapshot,created_at) VALUES ('fiber','original-key','old-original','interrupted',NULL,?,123)",
		JSON.stringify({ private: "original checkpoint" }),
	);
	ctx.storage.sql.exec(
		"CREATE TABLE cf_agents_runs(id TEXT PRIMARY KEY,name TEXT,completed_at INTEGER)",
	);
	ctx.storage.sql.exec(
		"CREATE TABLE inference_step_usage(turn_id TEXT,step_id TEXT,day TEXT,estimated_tokens INTEGER,actual_tokens INTEGER)",
	);
	ctx.storage.sql.exec(
		"INSERT INTO inference_step_usage VALUES ('original-run','attempt','2026-01-02',100,NULL)",
	);
	ctx.storage.sql.exec(
		"CREATE TABLE cf_agents_session_messages(id TEXT PRIMARY KEY,content TEXT)",
	);
	ctx.storage.sql.exec(
		"INSERT INTO cf_agents_session_messages VALUES ('message','private historical content')",
	);
	ctx.storage.kv.put("runtime-workflow-observation:v1:callback", {
		workflowId: "workflow",
		status: "instance_not_found",
		providerOutcome: "unknown",
		runId: "observation-is-not-run-authority",
	});
	ctx.storage.kv.put("wfctx:workflow", {
		runId: "original-run",
		workflowInstanceId: "workflow",
	});
	ctx.storage.kv.put("ledger-outbox:original-event", {
		runId: "original-run",
		kind: "tool.started",
	});
	ctx.storage.kv.put("pi-accounting:original-run", {
		runId: "original-run",
		attempts: [
			{ id: "attempt", phase: "unknown", usage: null, effectsSealed: false },
		],
	});
	return new HistoricalLiabilityCustody(ctx.storage, ctx.id.toString());
}
function originalSnapshot(ctx: DurableObjectState) {
	const tables = ctx.storage.sql
		.exec<{ name: string }>(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'historical_*' AND name NOT GLOB '_cf_*' ORDER BY name",
		)
		.toArray();
	return {
		sql: tables.map(({ name }) => [
			name,
			ctx.storage.sql.exec(`SELECT * FROM ${name}`).toArray(),
		]),
		kv: Array.from(ctx.storage.kv.list()),
	};
}

function capture(store: HistoricalLiabilityCustody) {
	const summary = store.inspectSnapshot({ expectedGeneration: 1 });
	return store.captureSnapshot({
		expectedGeneration: 1,
		expectedSourceHash: summary.sourceHash,
	});
}
function refs(ctx: DurableObjectState) {
	return ctx.storage.sql
		.exec<{ liability_id: string }>(
			"SELECT liability_id FROM historical_liability_refs ORDER BY liability_id",
		)
		.toArray();
}
function seedLegacyFacts(ctx: DurableObjectState) {
	ctx.storage.sql.exec(
		"CREATE TABLE assistant_messages(id TEXT PRIMARY KEY,session_id TEXT,parent_id TEXT,role TEXT,content BLOB,created_at TEXT)",
	);
	ctx.storage.sql.exec(
		"INSERT INTO assistant_messages VALUES ('original-message','',NULL,'user',?,NULL)",
		new Uint8Array([0, 255, 1, 0]).buffer,
	);
	ctx.storage.sql.exec(
		"CREATE TABLE assistant_compactions(id TEXT PRIMARY KEY,session_id TEXT,summary TEXT,from_message_id TEXT,to_message_id TEXT,created_at TEXT)",
	);
	ctx.storage.sql.exec(
		"INSERT INTO assistant_compactions VALUES ('original-compaction','','original summary','unselected-branch',NULL,NULL)",
	);
	ctx.storage.sql.exec(
		"CREATE TABLE assistant_sessions(id TEXT PRIMARY KEY,content TEXT)",
	);
	ctx.storage.sql.exec(
		"INSERT INTO assistant_sessions VALUES ('original-session',NULL)",
	);
	ctx.storage.sql.exec(
		"CREATE VIRTUAL TABLE assistant_fts USING fts5(content)",
	);
	ctx.storage.sql.exec(
		"INSERT INTO assistant_fts(content) VALUES ('original private search')",
	);
	ctx.storage.sql.exec(
		"CREATE TABLE cf_agents_sub_agents(class TEXT NOT NULL,name TEXT NOT NULL,identity_version TEXT,identity_name TEXT,PRIMARY KEY(class,name))",
	);
	ctx.storage.sql.exec(
		"INSERT INTO cf_agents_sub_agents VALUES ('RetiredClass','unselected-original',NULL,NULL)",
	);
	return [
		"assistant_messages",
		"assistant_compactions",
		"assistant_sessions",
		"assistant_fts",
		"cf_agents_sub_agents",
	].map(
		(table) =>
			[
				table,
				ctx.storage.sql.exec(`SELECT * FROM ${table}`).toArray(),
			] as const,
	);
}
describe("immutable bulk historical custody", () => {
	it("preserves original assistant rows, virtual search and registry facts through native archive and cold retry", async () => {
		const stub = fixture();
		const saved = await runInDurableObject(stub, async (_raw, ctx) => {
			const store = seed(ctx);
			const original = seedLegacyFacts(ctx);
			const before = originalSnapshot(ctx);
			const sizes = captureSqlSizes(ctx.storage);
			for (const [table] of original) {
				const selector = HISTORICAL_CAPTURE_SELECTORS.factTables.indexOf(
					table as (typeof HISTORICAL_CAPTURE_SELECTORS.factTables)[number],
				);
				expect(
					sizes.find(
						(row) => row.category === "fact" && row.selector === selector,
					),
				).toMatchObject({ present: true, rows: 1 });
			}
			const summary = capture(store),
				id = refs(ctx)[0]!.liability_id;
			const read = store.read({ liabilityId: id })!;
			for (const [table, rows] of original)
				expect(
					read.sourceFacts.sql.find(([name]) => name === table)?.[1],
				).toEqual(rows);
			expect(read.exposure.inventoryScope).toBe("fixed_whitelist_partial");
			expect(read.exposure.providerUsage).toBe("unknown");
			expect(store.audit()).toEqual(summary);
			expect(originalSnapshot(ctx)).toEqual(before);
			return { summary, id, original, before };
		});
		await abortAllDurableObjects();
		const ns = (
			env as unknown as {
				PI_CUTOVER_EARLY: DurableObjectNamespace<PiCutoverEarlyReturnFixture>;
			}
		).PI_CUTOVER_EARLY;
		await runInDurableObject(ns.get(stub.id), async (_raw, ctx) => {
			const store = new HistoricalLiabilityCustody(
				ctx.storage,
				ctx.id.toString(),
			);
			expect(store.audit()).toEqual(saved.summary);
			expect(capture(store)).toEqual(saved.summary);
			const read = store.read({ liabilityId: saved.id })!;
			for (const [table, rows] of saved.original)
				expect(
					read.sourceFacts.sql.find(([name]) => name === table)?.[1],
				).toEqual(rows);
			expect(originalSnapshot(ctx)).toEqual(saved.before);
		});
	});
	it("includes every original legacy or registry mutation in the source hash and refuses sealed replacement", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx);
			seedLegacyFacts(ctx);
			const summary = capture(store),
				id = refs(ctx)[0]!.liability_id;
			const originalLiability = store.read({ liabilityId: id })!;
			const mutations = [
				[
					"UPDATE assistant_messages SET parent_id='changed'",
					"UPDATE assistant_messages SET parent_id=NULL",
				],
				[
					"UPDATE assistant_compactions SET summary='changed'",
					"UPDATE assistant_compactions SET summary='original summary'",
				],
				[
					"UPDATE assistant_sessions SET content='changed'",
					"UPDATE assistant_sessions SET content=NULL",
				],
				[
					"UPDATE assistant_fts SET content='changed'",
					"UPDATE assistant_fts SET content='original private search'",
				],
				[
					"UPDATE cf_agents_sub_agents SET identity_name='changed'",
					"UPDATE cf_agents_sub_agents SET identity_name=NULL",
				],
			];
			for (const [change, restore] of mutations) {
				ctx.storage.sql.exec(change!);
				const changed = store.inspectSnapshot({ expectedGeneration: 1 });
				expect(changed.sourceHash).not.toBe(summary.sourceHash);
				expect(() =>
					store.captureSnapshot({
						expectedGeneration: 1,
						expectedSourceHash: summary.sourceHash,
					}),
				).toThrow("source changed");
				expect(() =>
					store.captureSnapshot({
						expectedGeneration: 1,
						expectedSourceHash: changed.sourceHash,
					}),
				).toThrow("immutable snapshot");
				expect(store.audit()).toEqual(summary);
				expect(store.read({ liabilityId: id })).toEqual(originalLiability);
				ctx.storage.sql.exec(restore!);
				expect(store.inspectSnapshot({ expectedGeneration: 1 })).toEqual(
					summary,
				);
			}
		});
	});
	it("keeps an older limited archive immutable when previously absent legacy facts appear", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx),
				summary = capture(store),
				id = refs(ctx)[0]!.liability_id;
			const archived = ctx.storage.sql
				.exec("SELECT * FROM historical_custody_parts ORDER BY kind,part")
				.toArray();
			seedLegacyFacts(ctx);
			expect(store.audit()).toEqual(summary);
			expect(
				store
					.read({ liabilityId: id })!
					.sourceFacts.sql.some(
						([name]) =>
							name.startsWith("assistant_") || name === "cf_agents_sub_agents",
					),
			).toBe(false);
			expect(() =>
				store.captureSnapshot({
					expectedGeneration: 1,
					expectedSourceHash: summary.sourceHash,
				}),
			).toThrow("source changed");
			expect(() => capture(store)).toThrow("immutable snapshot");
			expect(
				ctx.storage.sql
					.exec("SELECT * FROM historical_custody_parts ORDER BY kind,part")
					.toArray(),
			).toEqual(archived);
		});
	});
	it("streams actual composite WITHOUT ROWID history and indexed task locators", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx);
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_session_message_chunks(session_id TEXT NOT NULL,id TEXT NOT NULL,idx INTEGER NOT NULL,content TEXT NOT NULL,PRIMARY KEY(session_id,id,idx)) WITHOUT ROWID",
			);
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_session_attachment_chunks(hash TEXT NOT NULL,idx INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(hash,idx)) WITHOUT ROWID",
			);
			ctx.storage.sql.exec(
				"CREATE TABLE cf_agents_task_runs(run_id TEXT PRIMARY KEY,definition TEXT NOT NULL,input TEXT,state TEXT NOT NULL CHECK(state IN ('pending','running','waiting','completed','failed','cancelled')),result TEXT,error_name TEXT,error_message TEXT,status_message TEXT,metadata TEXT,idempotency_key TEXT UNIQUE,retain INTEGER NOT NULL DEFAULT 1,attempt INTEGER NOT NULL DEFAULT 0,generation TEXT,next_at INTEGER,wait_reason TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,cancel_reason TEXT,created_at INTEGER NOT NULL,started_at INTEGER,updated_at INTEGER NOT NULL,settled_at INTEGER) WITHOUT ROWID",
			);
			for (const [id, index] of [
				["😀", 9007199254740993n],
				["\ue000", 9007199254740994n],
			] as const) {
				ctx.storage.sql.exec(
					"INSERT INTO cf_agents_session_message_chunks VALUES ('s',?,CAST(? AS INTEGER),'private')",
					id,
					String(index),
				);
				ctx.storage.sql.exec(
					"INSERT INTO cf_agents_session_attachment_chunks VALUES (?,1,?)",
					id,
					new Uint8Array([1, 2, 3]).buffer,
				);
				ctx.storage.sql.exec(
					"INSERT INTO cf_agents_task_runs(run_id,definition,state,created_at,updated_at) VALUES (?,'actual','waiting',123,123)",
					id,
				);
			}
			// Null ordinary TEXT PK values are identified by the real rowid, not nullable PK casts.
			ctx.storage.sql.exec(
				"CREATE TABLE inference_turn_usage(turn_id TEXT PRIMARY KEY,private TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO inference_turn_usage VALUES (NULL,'first'),(NULL,'second')",
			);
			ctx.storage.kv.put("wfctx:orphan", {});
			ctx.storage.kv.put("runtime-admission-workflow:orphan", {
				id: "not-this-workflow",
			});
			const before = originalSnapshot(ctx),
				observed: string[] = [];
			const wrapped = {
				sql: {
					exec(query: string, ...values: SqlStorageValue[]) {
						if (
							query.startsWith("SELECT * FROM") &&
							query.includes(" WHERE ") &&
							query.includes("cf_agents_task_runs")
						) {
							const plan = ctx.storage.sql
								.exec<{ detail: string }>(
									`EXPLAIN QUERY PLAN ${query}`,
									...values,
								)
								.toArray();
							expect(
								plan.some(
									(row) =>
										row.detail.includes("SEARCH") &&
										row.detail.includes("PRIMARY KEY"),
								),
							).toBe(true);
						}
						if (
							query.startsWith("SELECT * FROM") &&
							!query.includes("historical_")
						)
							expect(query).toContain("LIMIT 1");
						if (
							query.includes("SELECT part,chunk,chunk_hash") &&
							values[1] === "source"
						)
							throw new Error("whole-source hydration forbidden");
						observed.push(query);
						return ctx.storage.sql.exec(query, ...values);
					},
				},
				kv: {
					get: ctx.storage.kv.get.bind(ctx.storage.kv),
					list(options: Parameters<typeof ctx.storage.kv.list>[0]) {
						expect(options?.limit).toBe(1);
						return ctx.storage.kv.list(options);
					},
				},
				transactionSync: ctx.storage.transactionSync.bind(ctx.storage),
			} as unknown as Pick<
				DurableObjectStorage,
				"sql" | "kv" | "transactionSync"
			>;
			const streaming = new HistoricalLiabilityCustody(
					wrapped,
					ctx.id.toString(),
				),
				result = capture(streaming);
			expect(streaming.audit()).toEqual(result);
			expect(capture(streaming)).toEqual(result);
			expect(
				observed.some((query) => query.includes("kind='source' AND part=?")),
			).toBe(true);
			// The unchanged materialized reader rebuilds the original tagged bytes/header/manifest.
			expect(
				store
					.read({ liabilityId: refs(ctx)[0]!.liability_id })!
					.sourceFacts.kv.find(([key]) => key === "wfctx:orphan")![1],
			).toEqual({});
			expect(originalSnapshot(ctx)).toEqual(before);
			const archived = store.read({ liabilityId: refs(ctx)[0]!.liability_id })!;
			const expectedHistory = JSON.stringify([
				"array",
				["😀", "\ue000"].map((id) => [
					"object",
					"plain",
					[
						["data", ["buffer", [1, 2, 3]]],
						["hash", ["string", id]],
						["idx", ["number", 1]],
					],
				]),
			]);
			expect(
				archived.sourceFacts.history.find(
					(row) => row.table === "cf_agents_session_attachment_chunks",
				)!.hash,
			).toBe(createHash("sha256").update(expectedHistory).digest("hex"));
		});
	});
	it("uses an unshadowed alias or unique indexed PK, and denies unsupported ambiguous locators", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx);
			ctx.storage.sql.exec(
				"CREATE TABLE inference_turn_usage(rowid TEXT,turn_id TEXT PRIMARY KEY,private TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO inference_turn_usage VALUES ('shadow',NULL,'one'),('shadow',NULL,'two')",
			);
			ctx.storage.sql.exec(
				"CREATE TABLE inference_recovery_anchor_migrations(rowid TEXT,_rowid_ TEXT,oid TEXT,id TEXT PRIMARY KEY,private TEXT)",
			);
			ctx.storage.sql.exec(
				"INSERT INTO inference_recovery_anchor_migrations VALUES ('x','x','x','unique','value')",
			);
			const summary = store.inspectSnapshot({ expectedGeneration: 1 });
			expect(summary.fiberCount).toBe(1);
			ctx.storage.sql.exec(
				"INSERT INTO inference_recovery_anchor_migrations VALUES ('x','x','x',NULL,'a'),('x','x','x',NULL,'b')",
			);
			expect(() => store.inspectSnapshot({ expectedGeneration: 1 })).toThrow(
				"unsupported source locator",
			);
			expect(
				ctx.storage.sql
					.exec("SELECT name FROM sqlite_master WHERE name GLOB 'historical_*'")
					.toArray(),
			).toEqual([]);
		});
	});
	for (const mode of [
		"kv_insert",
		"sql_insert",
		"late_value",
		"late_sdk_value",
	] as const)
		it(`rolls back complete archive on ${mode} at an owned-write boundary`, async () => {
			await runInDurableObject(fixture(), async (_raw, ctx) => {
				const store = seed(ctx),
					before = originalSnapshot(ctx),
					summary = store.inspectSnapshot({ expectedGeneration: 1 });
				let changed = false;
				const wrapped = {
					sql: {
						exec(query: string, ...values: SqlStorageValue[]) {
							const result = ctx.storage.sql.exec(query, ...values);
							const boundary = mode.startsWith("late_")
								? "INSERT INTO historical_replay_seals"
								: "INSERT INTO historical_custody_parts";
							if (!changed && query.startsWith(boundary)) {
								changed = true;
								if (mode === "kv_insert")
									ctx.storage.kv.put("wfctx:late", {
										runId: "late",
										private: "new",
									});
								else if (mode === "sql_insert")
									ctx.storage.sql.exec(
										"INSERT INTO cf_agents_fibers(fiber_id,name,status,created_at) VALUES ('late','original','interrupted',123)",
									);
								else if (mode === "late_value")
									ctx.storage.kv.put("wfctx:workflow", {
										runId: "original-run",
										userText: "changed after source pass",
									});
								else
									ctx.storage.sql.exec(
										"UPDATE cf_agents_workflows SET error_message='changed after source pass' WHERE id='tracking'",
									);
							}
							return result;
						},
					},
					kv: ctx.storage.kv,
					transactionSync: ctx.storage.transactionSync.bind(ctx.storage),
				} as unknown as Pick<
					DurableObjectStorage,
					"sql" | "kv" | "transactionSync"
				>;
				expect(() =>
					new HistoricalLiabilityCustody(
						wrapped,
						ctx.id.toString(),
					).captureSnapshot({
						expectedGeneration: 1,
						expectedSourceHash: summary.sourceHash,
					}),
				).toThrow("source");
				expect(changed).toBe(true);
				expect(
					ctx.storage.sql
						.exec(
							"SELECT name FROM sqlite_master WHERE name GLOB 'historical_*'",
						)
						.toArray(),
				).toEqual([]);
				expect(originalSnapshot(ctx)).toEqual(before);
			});
		});
	it("rejects noncanonical typed-view bytes in a discarded private fact during audit", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx);
			ctx.storage.kv.put(
				"computer-effect:bad-view",
				new Uint16Array(new Uint8Array([1, 2, 3, 4]).buffer),
			);
			capture(store);
			const part = ctx.storage.sql
				.exec<{ chunk: ArrayBuffer }>(
					"SELECT chunk FROM historical_custody_parts WHERE kind='source' AND part=0",
				)
				.toArray()[0]!;
			const encoded = new TextDecoder()
				.decode(part.chunk)
				.replace(
					'["view","Uint16Array",[1,2,3,4],0,4]',
					'["view","Uint16Array",[1,2,3,4],0,3]',
				);
			expect(encoded).not.toBe(new TextDecoder().decode(part.chunk));
			const bytes = new TextEncoder().encode(encoded);
			ctx.storage.sql.exec(
				"UPDATE historical_custody_parts SET chunk=?,chunk_hash=? WHERE kind='source' AND part=0",
				bytes.buffer,
				createHash("sha256").update(bytes).digest("hex"),
			);
			expect(() => store.audit()).toThrow("invalid binary view bounds");
		});
	});
	it("freezes all UNKNOWN rows and seals once without source/alarm/claim effects", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx);
			await ctx.storage.setAlarm(Date.now() + 60000);
			const before = originalSnapshot(ctx),
				alarm = await ctx.storage.getAlarm();
			const summary = capture(store);
			expect(summary.workflowCount).toBe(1);
			expect(summary.fiberCount).toBe(1);
			expect(summary.identityCount).toBe(4);
			expect(capture(store)).toEqual(summary);
			expect(store.audit()).toEqual(summary);
			expect(originalSnapshot(ctx)).toEqual(before);
			expect(await ctx.storage.getAlarm()).toBe(alarm);
			for (const ref of refs(ctx)) {
				const r = store.read({ liabilityId: ref.liability_id })!;
				expect(r.exposure.providerUsage).toBe("unknown");
				expect(r.exposure.estimatesAreBounds).toBe(false);
				expect(r.exposure.financialFacts).toBe("observed");
				expect(
					r.sourceFacts.kv.some(([k]) => k === "pi-accounting:original-run"),
				).toBe(true);
			}
			for (const identity of [
				{ kind: "run", id: "original-run" },
				{ kind: "fiber", id: "fiber" },
				{ kind: "fiber_key", id: "original-key" },
				{ kind: "workflow", binding: "CHAT_TURN_WORKFLOW", id: "workflow" },
			] as const)
				expect(() => store.assertNotSealed(identity)).toThrow(
					"permanently sealed",
				);
			store.assertNotSealed({
				kind: "run",
				id: "observation-is-not-run-authority",
			});
			expect(
				store
					.read({ liabilityId: refs(ctx)[0]!.liability_id })!
					.sourceFacts.kv.some(
						([key]) => key === "runtime-workflow-observation:v1:callback",
					),
			).toBe(true);
			store.assertNotSealed({ kind: "run", id: "metadata-is-not-proof" });
		});
	});
	it("shares legitimate original run across workflow rows and all exact references", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx);
			ctx.storage.sql.exec(
				"INSERT INTO cf_agents_workflows(id,workflow_id,workflow_name,status,metadata,created_at) VALUES ('tracking2','workflow2','CHAT_TURN_WORKFLOW','running',NULL,124)",
			);
			ctx.storage.kv.put("wfctx:workflow2", { runId: "original-run" });
			const s = capture(store);
			expect(s.identityCount).toBe(5);
			expect(refs(ctx).length).toBe(3);
			expect(() =>
				store.assertNotSealed({ kind: "run", id: "original-run" }),
			).toThrow("permanently sealed");
			expect(store.audit()).toEqual(s);
		});
	});
	it("captures exact dispatch journal run after wfctx deletion and rejects conflicting linkage", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx);
			ctx.storage.kv.delete("wfctx:workflow");
			ctx.storage.kv.put("runtime-admission-workflow:actual", {
				id: "workflow",
				params: { runId: "actual" },
			});
			capture(store);
			expect(() =>
				store.assertNotSealed({ kind: "run", id: "actual" }),
			).toThrow("permanently sealed");
			ctx.storage.kv.put("wfctx:workflow", { runId: "different" });
			expect(() => store.inspectSnapshot({ expectedGeneration: 1 })).toThrow(
				"conflicting original run",
			);
		});
	});
	it("stores >2MB source facts ONCE for many SDK rows and survives eviction", async () => {
		const stub = fixture();
		const ids = await runInDurableObject(stub, async (_raw, ctx) => {
			const store = seed(ctx);
			for (let i = 0; i < 3; i++)
				ctx.storage.kv.put(`wfctx:large-${i}`, {
					userText: "😀".repeat(200000),
					runId: `large${i}`,
				});
			for (let i = 0; i < 200; i++)
				ctx.storage.sql.exec(
					"INSERT INTO cf_agents_fibers(fiber_id,idempotency_key,name,status,metadata_json,snapshot,created_at) VALUES (?,?,'original','interrupted',NULL,NULL,123)",
					`bulk${i}`,
					`key${i}`,
				);
			const s = capture(store);
			expect(s.fiberCount).toBe(201);
			expect(refs(ctx).length).toBe(202);
			const parts = ctx.storage.sql
				.exec<{ bytes: number; max: number }>(
					"SELECT SUM(length(chunk)) AS bytes,MAX(length(chunk)) AS max FROM historical_custody_parts WHERE kind='source'",
				)
				.toArray()[0]!;
			expect(parts.bytes).toBeGreaterThan(2000000);
			expect(parts.max).toBeLessThanOrEqual(1000000);
			expect(
				ctx.storage.sql
					.exec("SELECT * FROM historical_custody_snapshot")
					.toArray().length,
			).toBe(1);
			expect(store.audit()).toEqual(s);
			return refs(ctx).map((r) => r.liability_id);
		});
		await abortAllDurableObjects();
		await runInDurableObject(
			(
				env as unknown as {
					PI_CUTOVER_EARLY: DurableObjectNamespace<PiCutoverEarlyReturnFixture>;
				}
			).PI_CUTOVER_EARLY.get(stub.id),
			async (_raw, ctx) => {
				const store = new HistoricalLiabilityCustody(
					ctx.storage,
					ctx.id.toString(),
				);
				const r = store.read({ liabilityId: ids[0]! })!;
				const value = r.sourceFacts.kv.find(
					([k]) => k === "wfctx:large-0",
				)![1] as { userText: string };
				expect(value.userText).toBe("😀".repeat(200000));
				expect(() =>
					store.assertNotSealed({ kind: "fiber", id: "bulk199" }),
				).toThrow("permanently sealed");
			},
		);
	});
	it("rolls back ALL header/parts/refs/seals on last seal failure", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx),
				sql = ctx.storage.sql;
			let inserted = 0;
			const wrapped = {
				sql: {
					exec(query: string, ...values: SqlStorageValue[]) {
						if (
							query.startsWith("INSERT INTO historical_replay_seals") &&
							++inserted === 4
						)
							throw new Error("late seal failure");
						return sql.exec(query, ...values);
					},
				},
				kv: ctx.storage.kv,
				transactionSync: ctx.storage.transactionSync.bind(ctx.storage),
			} as unknown as Pick<
				DurableObjectStorage,
				"sql" | "kv" | "transactionSync"
			>;
			const broken = new HistoricalLiabilityCustody(wrapped, ctx.id.toString()),
				s = store.inspectSnapshot({ expectedGeneration: 1 });
			expect(() =>
				broken.captureSnapshot({
					expectedGeneration: 1,
					expectedSourceHash: s.sourceHash,
				}),
			).toThrow("late seal");
			expect(
				sql
					.exec("SELECT name FROM sqlite_master WHERE name GLOB 'historical_*'")
					.toArray(),
			).toEqual([]);
			expect(capture(store)).toEqual(s);
		});
	});
	it("does not hydrate private chunks on guard; full audit/read detect private byte corruption", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx);
			capture(store);
			const id = refs(ctx)[0]!.liability_id;
			// Same-size source corruption intentionally leaves structural checks valid.
			ctx.storage.sql.exec(
				"UPDATE historical_custody_parts SET chunk=zeroblob(length(chunk)) WHERE kind='source'",
			);
			const sql = ctx.storage.sql;
			const wrapped = {
				sql: {
					exec(query: string, ...values: SqlStorageValue[]) {
						if (
							query.startsWith("SELECT part,chunk,chunk_hash") &&
							values[1] === "source"
						)
							throw new Error("guard hydrated private bytes");
						return sql.exec(query, ...values);
					},
				},
				kv: ctx.storage.kv,
				transactionSync: ctx.storage.transactionSync.bind(ctx.storage),
			} as unknown as Pick<
				DurableObjectStorage,
				"sql" | "kv" | "transactionSync"
			>;
			new HistoricalLiabilityCustody(
				wrapped,
				ctx.id.toString(),
			).assertNotSealed({ kind: "run", id: "absent" });
			store.assertNotSealed({ kind: "run", id: "absent" });
			expect(() =>
				store.assertNotSealed({ kind: "run", id: "original-run" }),
			).toThrow("permanently sealed");
			expect(() => store.audit()).toThrow("tampered snapshot part");
			expect(() => store.read({ liabilityId: id })).toThrow(
				"tampered snapshot part",
			);
		});
	});
	for (const mode of [
		"seal",
		"ref",
		"manifest",
		"source-part",
		"extra-part",
		"seal-link",
		"header",
	] as const)
		it(`denies absent identity after ${mode} corruption`, async () => {
			await runInDurableObject(fixture(), async (_raw, ctx) => {
				const store = seed(ctx);
				capture(store);
				if (mode === "seal")
					ctx.storage.sql.exec(
						"DELETE FROM historical_replay_seals WHERE identity=(SELECT identity FROM historical_replay_seals LIMIT 1)",
					);
				if (mode === "ref")
					ctx.storage.sql.exec(
						"UPDATE historical_liability_refs SET ref_hash='bad' WHERE liability_id=(SELECT liability_id FROM historical_liability_refs LIMIT 1)",
					);
				if (mode === "manifest")
					ctx.storage.sql.exec(
						"UPDATE historical_custody_parts SET chunk=X'7b7d' WHERE kind='manifest'",
					);
				if (mode === "source-part")
					ctx.storage.sql.exec(
						"DELETE FROM historical_custody_parts WHERE kind='source'",
					);
				if (mode === "extra-part")
					ctx.storage.sql.exec(
						"INSERT INTO historical_custody_parts SELECT snapshot_id,kind,part+1000000,chunk,chunk_hash FROM historical_custody_parts WHERE kind='source' LIMIT 1",
					);
				if (mode === "seal-link")
					ctx.storage.sql.exec(
						"UPDATE historical_replay_seals SET link_hash='wrong' WHERE identity=(SELECT identity FROM historical_replay_seals LIMIT 1)",
					);
				if (mode === "header")
					ctx.storage.sql.exec("DELETE FROM historical_custody_snapshot");
				expect(() =>
					store.assertNotSealed({ kind: "run", id: "unseen" }),
				).toThrow();
				expect(() => store.read({ liabilityId: "a".repeat(64) })).toThrow();
			});
		});
	it("rejects generation/source changes or second freeze and preserves original archived data", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx),
				s = capture(store);
			const id = refs(ctx)[0]!.liability_id;
			expect(() =>
				store.captureSnapshot({
					expectedGeneration: 2,
					expectedSourceHash: s.sourceHash,
				}),
			).toThrow("non-active");
			ctx.storage.sql.exec("UPDATE cf_agents_fibers SET status='running'");
			expect(() =>
				store.captureSnapshot({
					expectedGeneration: 1,
					expectedSourceHash: s.sourceHash,
				}),
			).toThrow("source changed");
			const changed = store.inspectSnapshot({ expectedGeneration: 1 });
			expect(() =>
				store.captureSnapshot({
					expectedGeneration: 1,
					expectedSourceHash: changed.sourceHash,
				}),
			).toThrow("immutable snapshot");
			expect(store.read({ liabilityId: id })).not.toBeNull();
		});
	});
	it("enforces actual physical/tenant nonactive custody and retains anonymous unknown ownership", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx, true);
			capture(store);
			expect(
				store.read({ liabilityId: refs(ctx)[0]!.liability_id })!.ownerUnknown,
			).toBe(true);
			expect(() =>
				new HistoricalLiabilityCustody(ctx.storage, "wrong-physical").audit(),
			).toThrow("custody");
		});
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx);
			ctx.storage.sql.exec(
				"UPDATE cf_agents_state SET state=?",
				JSON.stringify({ tediId: "wrong", orgId: "actual-org" }),
			);
			expect(() => store.inspectSnapshot({ expectedGeneration: 1 })).toThrow(
				"tenant custody",
			);
		});
	});
	it("archives an old Raw owner alias without rewriting original ACK or unknown obligations, including cold retries and retirement projection", async () => {
		const stub = fixture();
		const captured = await runInDurableObject(stub, async (_raw, ctx) => {
			const store = seed(ctx);
			const owner = {
				objectId: ctx.id.toString(),
				tediId: "actual-tedi",
				orgId: "actual-org",
			};
			const record = {
				kind: "unqualified_namespace_rpc_observation",
				providerAttested: false,
				owner,
				admission: { owner, generation: 1, state: "quarantined" },
				payload: { result: false },
				provenance: { kind: "unknown", qualified: false },
			};
			const ack = {
				...record,
				recordHash: createHash("sha256")
					.update(observationJSON(record))
					.digest("hex"),
			};
			const key = "runtime-workflow-observation:v1:old-aliased-ack";
			ctx.storage.kv.put(key, ack);
			const stored = ctx.storage.kv.get<typeof ack>(key)!;
			expect(stored.owner).toBe(stored.admission.owner);
			const before = originalSnapshot(ctx),
				originalJson = JSON.stringify(stored);
			const inspected = store.inspectSnapshot({ expectedGeneration: 1 });
			const bytes = historicalCaptureItemBytes([key, stored]);
			expect(bytes).toBeGreaterThan(0);
			const summary = capture(store);
			expect(summary).toEqual(inspected);
			expect(capture(store)).toEqual(summary);
			expect(store.audit()).toEqual(summary);
			const read = store.read({ liabilityId: refs(ctx)[0]!.liability_id })!;
			const restored = read.sourceFacts.kv.find(
				([k]) => k === key,
			)![1] as typeof ack;
			expect(restored.owner).toBe(restored.admission.owner);
			expect(observationJSON(restored)).toBe(observationJSON(stored));
			const { recordHash, ...body } = restored;
			expect(
				createHash("sha256").update(observationJSON(body)).digest("hex"),
			).toBe(recordHash);
			expect(historicalCaptureItemBytes([key, restored])).toBe(bytes);
			expect(read.disposition).toBe("unknown");
			expect(read.exposure.reservationCoverage).toBe("unknown");
			expect(originalSnapshot(ctx)).toEqual(before);
			const detached = { ...stored, owner: { ...stored.owner } };
			ctx.storage.kv.put(key, detached);
			expect(
				store.inspectSnapshot({ expectedGeneration: 1 }).sourceHash,
			).not.toBe(summary.sourceHash);
			expect(() =>
				store.captureSnapshot({
					expectedGeneration: 1,
					expectedSourceHash: summary.sourceHash,
				}),
			).toThrow("source changed");
			ctx.storage.kv.put(key, stored);
			const proof = store.trackingRetirementProof({
				expectedGeneration: 1,
				snapshotId: summary.snapshotId,
				sourceHash: summary.sourceHash,
			});
			expect(originalSnapshot(ctx)).toEqual(before);
			return {
				summary,
				key,
				originalJson,
				bytes,
				proof,
				id: refs(ctx)[0]!.liability_id,
			};
		});
		await abortAllDurableObjects();
		const ns = (
			env as unknown as {
				PI_CUTOVER_EARLY: DurableObjectNamespace<PiCutoverEarlyReturnFixture>;
			}
		).PI_CUTOVER_EARLY;
		await runInDurableObject(ns.get(stub.id), async (_raw, ctx) => {
			const store = new HistoricalLiabilityCustody(
				ctx.storage,
				ctx.id.toString(),
			);
			expect(store.audit()).toEqual(captured.summary);
			expect(capture(store)).toEqual(captured.summary);
			const read = store.read({ liabilityId: captured.id })!;
			const value = read.sourceFacts.kv.find(
				([k]) => k === captured.key,
			)![1] as { owner: unknown; admission: { owner: unknown } };
			expect(value.owner).toBe(value.admission.owner);
			expect(observationJSON(value)).toBe(
				observationJSON(JSON.parse(captured.originalJson)),
			);
			expect(historicalCaptureItemBytes([captured.key, value])).toBe(
				captured.bytes,
			);
			const stored = ctx.storage.kv.get<typeof value>(captured.key)!;
			expect(stored.owner).toBe(stored.admission.owner);
			expect(JSON.stringify(stored)).toBe(captured.originalJson);
			// Test-only removal proves immutable projection bytes; it is not the retirement operator or execution release.
			ctx.storage.sql.exec("DELETE FROM cf_agents_workflows");
			ctx.storage.sql.exec("DELETE FROM cf_agents_fibers");
			ctx.storage.sql.exec("DELETE FROM cf_agents_runs");
			const current = store.inspectSnapshot({ expectedGeneration: 1 });
			expect(current.sourceHash).toBe(captured.proof.postRetirementSourceHash);
			expect(
				store.trackingRetirementProof({
					expectedGeneration: 1,
					snapshotId: captured.summary.snapshotId,
					sourceHash: captured.summary.sourceHash,
					expectedCurrentSourceHash: current.sourceHash,
				}).postRetirementSourceHash,
			).toBe(current.sourceHash);
			store.assertNotSealed({ kind: "run", id: "new-unused" });
			expect(() =>
				store.assertNotSealed({
					kind: "workflow",
					binding: "CHAT_TURN_WORKFLOW",
					id: "workflow",
				}),
			).toThrow("sealed");
		});
	});
	it("streams a single large DAG across SQL parts and reproduces its exact value bytes", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx),
				shared = { text: "😀".repeat(600000) };
			const value = { first: shared, second: shared };
			ctx.storage.kv.put("computer-effect:large-dag", value);
			const bytes = historicalCaptureItemBytes([
					"computer-effect:large-dag",
					value,
				]),
				summary = capture(store);
			expect(bytes).toBeGreaterThan(2000000);
			const parts = ctx.storage.sql
				.exec<{ max: number; count: number }>(
					"SELECT MAX(length(chunk)) AS max,COUNT(*) AS count FROM historical_custody_parts WHERE kind='source'",
				)
				.toArray()[0]!;
			expect(parts.max).toBe(1000000);
			expect(parts.count).toBeGreaterThan(2);
			expect(store.audit()).toEqual(summary);
			const read = store.read({ liabilityId: refs(ctx)[0]!.liability_id })!;
			const decoded = read.sourceFacts.kv.find(
				([key]) => key === "computer-effect:large-dag",
			)![1] as typeof value;
			expect(decoded.first).toBe(decoded.second);
			expect(decoded.first.text).toBe(shared.text);
			expect(
				historicalCaptureItemBytes(["computer-effect:large-dag", decoded]),
			).toBe(bytes);
			expect(capture(store)).toEqual(summary);
		});
	});
	it("rejects cycles and alias-topology changes during the last archive write, atomically preserving originals", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx),
				shared = { private: "original" },
				key = "computer-effect:dag";
			const value = { a: shared, b: shared };
			ctx.storage.kv.put(key, value);
			const cycle: { self?: unknown } = {};
			cycle.self = cycle;
			ctx.storage.kv.put("computer-effect:cycle", cycle);
			expect(() => store.inspectSnapshot({ expectedGeneration: 1 })).toThrow(
				"reference topology",
			);
			ctx.storage.kv.delete("computer-effect:cycle");
			const sourceHash = store.inspectSnapshot({
				expectedGeneration: 1,
			}).sourceHash;
			const actualExec = ctx.storage.sql.exec.bind(ctx.storage.sql);
			let fired = false;
			ctx.storage.sql.exec = ((sql: string, ...args: SqlStorageValue[]) => {
				const result = actualExec(sql, ...args);
				if (!fired && sql.startsWith("INSERT INTO historical_replay_seals")) {
					fired = true;
					ctx.storage.kv.put(key, { a: { ...shared }, b: { ...shared } });
				}
				return result;
			}) as typeof ctx.storage.sql.exec;
			try {
				expect(() =>
					store.captureSnapshot({
						expectedGeneration: 1,
						expectedSourceHash: sourceHash,
					}),
				).toThrow("source or custody changed");
			} finally {
				ctx.storage.sql.exec = actualExec;
			}
			expect(fired).toBe(true);
			expect(
				ctx.storage.sql
					.exec("SELECT name FROM sqlite_master WHERE name GLOB 'historical_*'")
					.toArray(),
			).toEqual([]);
			const restored = ctx.storage.kv.get<typeof value>(key)!;
			expect(restored.a).toBe(restored.b);
			expect(restored).toEqual(value);
		});
	});
	it("retains native typed-view offset/full buffer and rejects shared binary graphs", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx),
				buffer = new Uint8Array([9, 1, 2, 8]).buffer;
			ctx.storage.kv.put("computer-effect:typed", new Uint8Array(buffer, 1, 2));
			const actual = ctx.storage.kv.get("computer-effect:typed") as Uint8Array;
			expect(actual.byteOffset).toBe(1);
			expect(Array.from(new Uint8Array(actual.buffer))).toEqual([9, 1, 2, 8]);
			capture(store);
			const r = store.read({ liabilityId: refs(ctx)[0]!.liability_id })!;
			const decoded = r.sourceFacts.kv.find(
				([k]) => k === "computer-effect:typed",
			)![1] as Uint8Array;
			expect(decoded.byteOffset).toBe(1);
			expect(Array.from(new Uint8Array(decoded.buffer))).toEqual([9, 1, 2, 8]);
			ctx.storage.kv.put(
				"computer-effect:typed",
				new Uint8Array(new Uint8Array([7, 1, 2, 8]).buffer, 1, 2),
			);
			expect(() =>
				store.captureSnapshot({
					expectedGeneration: 1,
					expectedSourceHash: store.audit()!.sourceHash,
				}),
			).toThrow("source changed");
			const shared = { private: "same" };
			ctx.storage.kv.put("computer-effect:shared", { a: shared, b: shared });
			expect(
				store.inspectSnapshot({ expectedGeneration: 1 }).sourceHash,
			).not.toBe(store.audit()!.sourceHash);
			ctx.storage.kv.delete("computer-effect:shared");
			const sharedBuffer = new ArrayBuffer(4);
			ctx.storage.kv.put("computer-effect:shared-buffer", {
				first: new Uint8Array(sharedBuffer),
				second: new Uint8Array(sharedBuffer, 1, 2),
			});
			const stored = ctx.storage.kv.get("computer-effect:shared-buffer") as {
				first: Uint8Array;
				second: Uint8Array;
			};
			expect(stored.first.buffer).toBe(stored.second.buffer);
			expect(() => store.inspectSnapshot({ expectedGeneration: 1 })).toThrow(
				"reference topology",
			);
		});
	});
	it("inspection/reads never create engine tables; malformed request/type provenance fail closed", async () => {
		await runInDurableObject(fixture(), async (_raw, ctx) => {
			const store = seed(ctx);
			expect(store.read({ liabilityId: "a".repeat(64) })).toBeNull();
			expect(store.audit()).toBeNull();
			store.assertNotSealed({ kind: "run", id: "absent" });
			store.inspectSnapshot({ expectedGeneration: 1 });
			expect(
				ctx.storage.sql
					.exec("SELECT name FROM sqlite_master WHERE name GLOB 'historical_*'")
					.toArray(),
			).toEqual([]);
			expect(() =>
				store.inspectSnapshot({
					expectedGeneration: 1,
					owner: "fake",
				} as never),
			).toThrow("invalid fields");
			ctx.storage.kv.put(
				"computer-effect:array",
				Object.assign([1], { extra: "secret" }),
			);
			expect(() => store.inspectSnapshot({ expectedGeneration: 1 })).toThrow(
				"array properties",
			);
		});
	});
});
