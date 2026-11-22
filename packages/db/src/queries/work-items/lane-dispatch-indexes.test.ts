import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { listWorkItemsPage } from "./crud";
import {
	deriveWorkItemReadiness,
	listWorkItemReadinessProjection,
} from "./readiness";

const migration = "20261022073425_work_items_lane_dispatch_indexes";
const backfill = "20261115163121_lane_ready_requires_state";
const executionContract = "20261118053954_work_item_execution_contract";
// The current Work row reads these generated columns.
const generatedColumns = "20261118171241_generated_json_columns";

// Build the chain-prefix template at collection, not inside a timed test on a
// shared machine.
createMigratedSqlite({
	beforeMigration: migration,
	foreignKeys: false,
}).close();

describe("lane dispatch indexes", () => {
	it("backfills missing plans, indexes ready state, and follows metadata updates", async () => {
		const sqlite = createMigratedSqlite({
			beforeMigration: migration,
			foreignKeys: false,
		});
		sqlite.exec(`
			WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<22000)
			INSERT INTO work_items(id,org_id,title,disposition,metadata,created_at,admission_spec_revision)
			SELECT printf('%05d',i),'org-1','Lane','accepted',
				CASE WHEN i=1 THEN '{"executor":"codex"}'
				WHEN i=2 THEN '{"executor":"devin","laneDispatch":{"state":"ready"}}'
				WHEN i=3 THEN '{"executor":"codex","laneDispatch":null}'
				ELSE '{"executor":"codex","laneDispatch":{"state":"held"}}' END,
				'2026-10-22T00:00:00Z','revision-1' FROM n;
			INSERT INTO work_items(id,org_id,title,disposition,metadata,created_at,admission_spec_revision)
			VALUES('bad','org-2','Malformed','accepted','{"executor":{"kind":"codex"},"laneDispatch":{"state":"later"},"laneExecution":{"delegationDepth":"deep","maxAttempts":99},"budgetShareMicros":"all"}','2026-10-22T00:00:00Z','revision-1');
			INSERT INTO work_items(id,org_id,title,disposition,metadata,created_at,admission_spec_revision)
			VALUES('invalid-root','org-2','Invalid roots','accepted',json_object('rootWorkItemId','11111111-1111-4111-8111-111111-11111','rootGoal',printf('%10001s','x')),'2026-10-22T00:00:00Z','revision-1');
			INSERT INTO work_items(id,org_id,title,disposition,metadata,created_at,admission_spec_revision)
			VALUES('empty-executor','org-2','Empty executor','accepted',json_object('executor',''),'2026-10-22T00:00:00Z','revision-1');
			INSERT INTO work_items(id,org_id,title,disposition,metadata,created_at,admission_spec_revision)
			VALUES('oversized-executor','org-2','Oversized executor','accepted',json_object('executor',printf('%301s','x')),'2026-10-22T00:00:00Z','revision-1');
			INSERT INTO work_items(id,org_id,title,disposition,metadata,created_at,admission_spec_revision)
			VALUES('legacy-factory','org-2','Legacy factory','accepted','{"factoryCycle":{"maxAttempts":3}}','2026-10-22T00:00:00Z','revision-1');
		`);
		for (const name of [
			migration,
			backfill,
			executionContract,
			generatedColumns,
		])
			sqlite.exec(
				readFileSync(
					new URL(`../../../drizzle/${name}/migration.sql`, import.meta.url),
					"utf8",
				).replaceAll("--> statement-breakpoint", ""),
			);
		sqlite.exec("ANALYZE work_items");
		const queries: string[] = [];
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (query) => queries.push(query),
			}),
		);
		for (const executor of ["codex", ["codex", "devin"]]) {
			const page = await listWorkItemsPage(db, {
				orgId: "org-1",
				disposition: "accepted",
				executor,
				dispatchReadyOnly: true,
				limit: 1,
			});
			expect(page.total).toBe(Array.isArray(executor) ? 3 : 2);
		}
		for (const query of queries) {
			const plan = (
				sqlite
					.prepare(`EXPLAIN QUERY PLAN ${query}`)
					.all(...Array.from(query.matchAll(/\?/g), () => null)) as {
					detail: string;
				}[]
			)
				.map((row) => row.detail)
				.join("\n");
			expect(plan, query).toContain(
				"idx_work_items_lane_ready (org_id=? AND disposition=?",
			);
			expect(plan).not.toMatch(/SCAN work_items/);
		}
		sqlite.exec(
			`UPDATE work_items SET executor_type='external_agent', executor_id='codex', dispatch_state='ready' WHERE id='00004'`,
		);
		const updated = await listWorkItemsPage(db, {
			orgId: "org-1",
			disposition: "accepted",
			executor: "codex",
			dispatchReadyOnly: true,
		});
		expect(updated.data.map((row) => row.id)).toEqual([
			"00001",
			"00003",
			"00004",
		]);
		expect(
			sqlite
				.prepare(
					"SELECT executor_type,executor_id,dispatch_state,json_extract(metadata,'$.executor') AS legacy_executor,json_extract(metadata,'$.laneDispatch.state') AS legacy_state FROM work_items WHERE id='00001'",
				)
				.get(),
		).toEqual({
			executor_type: "external_agent",
			executor_id: "codex",
			dispatch_state: "ready",
			legacy_executor: "codex",
			legacy_state: "ready",
		});
		expect(
			sqlite
				.prepare(
					"SELECT executor_type,executor_id,dispatch_state,delegation_depth,max_attempts,budget_share_micros,json_extract(metadata,'$.executor') AS legacy_executor FROM work_items WHERE id='bad'",
				)
				.get(),
		).toEqual({
			executor_type: null,
			executor_id: null,
			dispatch_state: null,
			delegation_depth: null,
			max_attempts: null,
			budget_share_micros: null,
			legacy_executor: '{"kind":"codex"}',
		});
		expect(
			sqlite
				.prepare(
					"SELECT root_work_item_id,root_goal FROM work_items WHERE id='invalid-root'",
				)
				.get(),
		).toEqual({ root_work_item_id: null, root_goal: null });
		for (const id of ["empty-executor", "oversized-executor"]) {
			expect(
				sqlite
					.prepare(
						"SELECT executor_type,executor_id FROM work_items WHERE id=?",
					)
					.get(id),
			).toEqual({ executor_type: null, executor_id: null });
		}
		expect(
			sqlite
				.prepare(
					"SELECT max_attempts,json_extract(metadata,'$.factoryCycle.maxAttempts') AS legacy_max_attempts FROM work_items WHERE id='legacy-factory'",
				)
				.get(),
		).toEqual({ max_attempts: 3, legacy_max_attempts: 3 });
	});
});

describe("dispatch order and readiness", () => {
	it("lists ready Work by priority, due date, then oldest and ignores plan-less Work", async () => {
		const sqlite = createMigratedSqlite({ foreignKeys: false });
		const row = sqlite.prepare(
			"INSERT INTO work_items(id,org_id,title,disposition,dispatch_state,priority,due_date,created_at,admission_spec_revision,executor_type,executor_id) VALUES(?,?,?,?,?,?,?,?,'r','external_agent','codex')",
		);
		const ready = "ready";
		row.run(
			"a-old-medium",
			"o",
			"t",
			"accepted",
			ready,
			"medium",
			null,
			"2026-01-01",
		);
		row.run(
			"b-new-critical",
			"o",
			"t",
			"accepted",
			ready,
			"critical",
			null,
			"2026-03-01",
		);
		row.run(
			"c-high-late",
			"o",
			"t",
			"accepted",
			ready,
			"high",
			"2026-12-01",
			"2026-02-01",
		);
		row.run(
			"d-high-soon",
			"o",
			"t",
			"accepted",
			ready,
			"high",
			"2026-11-01",
			"2026-02-02",
		);
		row.run(
			"e-high-undated",
			"o",
			"t",
			"accepted",
			ready,
			"high",
			null,
			"2026-01-01",
		);
		row.run(
			"f-noplan",
			"o",
			"t",
			"accepted",
			null,
			"critical",
			null,
			"2025-01-01",
		);
		const db = createDbQueryClient(createD1Facade(sqlite));
		const page = await listWorkItemsPage(db, {
			orgId: "o",
			disposition: "accepted",
			dispatchReadyOnly: true,
		});
		expect(page.data.map((r) => r.id)).toEqual([
			"b-new-critical",
			"d-high-soon",
			"c-high-late",
			"e-high-undated",
			"a-old-medium",
		]);
	});

	it("keeps Work off the ready list until its start date and says so in readiness", async () => {
		const sqlite = createMigratedSqlite({ foreignKeys: false });
		const row = sqlite.prepare(
			`INSERT INTO work_items(id,org_id,title,disposition,executor_type,executor_id,dispatch_state,start_at,created_at,admission_spec_revision,work_class,purpose_exception_expires_at) VALUES(?,'o','t','accepted','external_agent','codex','ready',?,'2026-01-01','r','maintenance','2026-11-30T00:00:00.000Z')`,
		);
		row.run("undated", null);
		row.run("started", "2026-11-01T00:00:00.000Z");
		row.run("waiting", "2026-11-07T00:00:00.000Z");
		const db = createDbQueryClient(createD1Facade(sqlite));
		const early = "2026-11-04T00:04:00.000Z";
		const due = "2026-11-07T00:00:00.000Z";
		const ready = async (now: string) =>
			(
				await listWorkItemsPage(db, {
					orgId: "o",
					disposition: "accepted",
					dispatchReadyOnly: true,
					now,
				})
			).data
				.map((r) => r.id)
				.sort();
		expect(await ready(early)).toEqual(["started", "undated"]);
		expect(await ready(due)).toEqual(["started", "undated", "waiting"]);
		// Only the runners' ready list leaves it out.
		expect(
			(await listWorkItemsPage(db, { orgId: "o", now: early })).total,
		).toBe(3);

		const readiness = (workItemId: string, derivedAt: string) =>
			deriveWorkItemReadiness(db, { orgId: "o", workItemId, derivedAt });
		const before = await readiness("waiting", early);
		expect(before).toMatchObject({
			state: "not_before",
			ready: false,
			reasons: [
				{
					code: "not_before",
					detail: expect.stringContaining(
						"Waits for its start date, 2026-11-07T00:00:00.000Z",
					),
				},
			],
		});
		expect(before.gates.find((gate) => gate.gate === "not_before")).toEqual({
			gate: "not_before",
			evaluation: "failed",
			detail: before.reasons[0]!.detail,
		});
		const after = await readiness("waiting", due);
		expect(after).toMatchObject({ state: "ready", ready: true });
		expect(
			after.gates.find((gate) => gate.gate === "not_before")?.evaluation,
		).toBe("passed");
		expect((await readiness("undated", early)).ready).toBe(true);
		sqlite.close();
	});
});

it("backs off repeated deferrals and wakes when the task, a dependency or an approval changes", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	try {
		const db = createDbQueryClient(createD1Facade(sqlite));
		let start = "2026-11-22T01:00:00.000Z";
		let finish = "2026-11-22T01:05:00.000Z";
		let now = "2026-11-22T01:06:00.000Z";
		sqlite.exec(`INSERT INTO tedis(id,organization_id,name,slug) VALUES('fictional','o','Executor','executor');
			INSERT INTO work_items(id,org_id,title,disposition,created_at,admission_spec_revision,work_class,purpose_exception_expires_at)
			VALUES('deferred','o','Waiting task','accepted','2026-01-01','r','maintenance','2026-11-30T00:00:00.000Z'),
			('dependency','o','Dependency','completed','2026-01-01','r','maintenance','2026-11-30T00:00:00.000Z');
			INSERT INTO work_item_relations(id,org_id,from_work_item_id,to_work_item_id,relation_type,created_at) VALUES('r','o','dependency','deferred','blocks','2026-01-01');`);
		const admission =
			sqlite.prepare(`INSERT INTO work_admissions(id,org_id,work_item_id,work_item_version,admission_spec_revision,executor_type,executor_id,decision,decided_at,expires_at,created_at)
			VALUES(?,'o','deferred',1,'r','tedi','fictional','admitted',?,'2026-11-30',?)`);
		const attempt =
			sqlite.prepare(`INSERT INTO work_attempts(id,org_id,work_item_id,admission_id,attempt_number,runtime_state,outcome,executor_type,executor_id,started_at,heartbeat_at,finished_at,expires_at,metadata)
			VALUES(?,'o','deferred',?,?,'cancelled','cancelled','tedi','fictional',?,?,?,'2026-11-30',?)`);
		const readiness = (at = now) =>
			deriveWorkItemReadiness(db, {
				orgId: "o",
				workItemId: "deferred",
				derivedAt: at,
			});
		let nextStartAt = start;
		for (const [n, hours] of [
			[1, 1],
			[2, 4],
			[3, 24],
			[4, 24],
			[5, 24],
		] as const) {
			start = nextStartAt;
			finish = new Date(Date.parse(start) + 300_000).toISOString();
			now = new Date(Date.parse(finish) + 60_000).toISOString();
			admission.run(`admission-${n}`, start, start);
			attempt.run(
				`attempt-${n}`,
				`admission-${n}`,
				n,
				start,
				finish,
				finish,
				JSON.stringify({
					laneResult: { outcome: "deferred", reason: "Waiting on publication" },
				}),
			);
			const result = await readiness();
			const retryAt = new Date(
				Date.parse(finish) + hours * 3_600_000,
			).toISOString();
			expect(result.state).toBe("not_before");
			expect(result.reasons[0]?.detail).toContain("Waiting on publication");
			expect(result.reasons[0]?.detail).toContain(retryAt);
			expect(
				(await readiness(new Date(Date.parse(retryAt) - 1).toISOString()))
					.ready,
			).toBe(false);
			expect((await readiness(retryAt)).ready).toBe(true);
			nextStartAt = retryAt;
			// Recreating the client models a new process reading durable history.
			const restarted = await deriveWorkItemReadiness(
				createDbQueryClient(createD1Facade(sqlite)),
				{ orgId: "o", workItemId: "deferred", derivedAt: now },
			);
			expect(restarted.reasons).toEqual(result.reasons);
		}
		const projection = await listWorkItemReadinessProjection(db, {
			orgId: "o",
			observedAt: now,
		});
		expect(
			projection.data.find((row) => row.workItem.id === "deferred")?.readiness
				.state,
		).toBe("not_before");
		// Changed prose is not evidence that the underlying wait resolved.
		admission.run("different-reason", start, start);
		attempt.run(
			"different-reason",
			"different-reason",
			6,
			start,
			finish,
			finish,
			JSON.stringify({
				laneResult: {
					outcome: "deferred",
					reason: "Publication is still pending; see the latest progress note",
				},
			}),
		);
		expect((await readiness()).reasons[0]?.detail).toContain(
			new Date(Date.parse(finish) + 24 * 3_600_000).toISOString(),
		);
		// Runner heartbeats and its own progress do not wake a parked task.
		sqlite.exec(
			`UPDATE work_items SET updated_at='${now}' WHERE id='deferred';
			INSERT INTO work_items(id,org_id,title,disposition,created_at,admission_spec_revision)
			VALUES('unrelated','o','Another task','accepted','${now}','r');
			INSERT INTO work_item_comments(id,org_id,work_item_id,author_type,body,created_at)
			VALUES('note','o','unrelated','system','Another task changed','${now}');
			INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,rationale,expires_at,created_at)
			VALUES('unrelated-approval','o','unrelated',1,'publication','publish','{}','system','tedix','tedi','fictional','Another approval','2026-11-30','${now}')`,
		);
		expect((await readiness()).ready).toBe(false);
		sqlite.exec(
			`UPDATE work_items SET updated_at='${now}' WHERE id='dependency'`,
		);
		expect((await readiness()).ready).toBe(true);
		sqlite.exec(`UPDATE work_items SET updated_at=NULL WHERE id='dependency';
			UPDATE work_items SET metadata=json_set(metadata,'$.decisionContinuation.at','${now}') WHERE id='deferred'`);
		expect((await readiness()).ready).toBe(true);
		sqlite.exec(`UPDATE work_items SET metadata='{}' WHERE id='deferred';
			INSERT INTO work_approval_proposals(id,org_id,work_item_id,work_item_version,authority_key,action,proposal,requester_type,requester_id,approver_type,approver_id,rationale,expires_at,created_at)
			VALUES('p','o','deferred',1,'publication','publish','{}','system','tedix','tedi','fictional','Review publication','2026-11-30','${now}')`);
		expect((await readiness()).ready).toBe(true);
		// A run after that change starts a fresh streak.
		const nextStart = new Date(Date.parse(now) + 60_000).toISOString();
		const nextFinish = new Date(Date.parse(nextStart) + 60_000).toISOString();
		const nextNow = new Date(Date.parse(nextFinish) + 60_000).toISOString();
		admission.run("admission-6", nextStart, nextStart);
		attempt.run(
			"attempt-7",
			"admission-6",
			7,
			nextStart,
			nextFinish,
			nextFinish,
			JSON.stringify({
				laneResult: { outcome: "deferred", reason: "Waiting on publication" },
			}),
		);
		expect((await readiness(nextNow)).reasons[0]?.detail).toContain(
			new Date(Date.parse(nextFinish) + 3_600_000).toISOString(),
		);
		sqlite.exec(
			`UPDATE work_items SET version=2,admission_spec_revision='r2' WHERE id='deferred'`,
		);
		expect((await readiness(nextNow)).ready).toBe(true);
	} finally {
		sqlite.close();
	}
});
