import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { listWorkItemsPage } from "./crud";
import { deriveWorkItemReadiness } from "./readiness";

const migration = "20261022073425_work_items_lane_dispatch_indexes";
const backfill = "20261115163121_lane_ready_requires_state";

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
		`);
		for (const name of [migration, backfill])
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
				"idx_work_items_lane_ready (org_id=? AND disposition=? AND <expr>=?)",
			);
			expect(plan).not.toMatch(/SCAN work_items/);
		}
		sqlite.exec(
			`UPDATE work_items SET metadata='{"executor":"codex","laneDispatch":{"state":"ready"}}' WHERE id='00004'`,
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
	});
});

describe("dispatch order and readiness", () => {
	it("lists ready Work by priority, due date, then oldest and ignores plan-less Work", async () => {
		const sqlite = createMigratedSqlite({ foreignKeys: false });
		const row = sqlite.prepare(
			"INSERT INTO work_items(id,org_id,title,disposition,metadata,priority,due_date,created_at,admission_spec_revision) VALUES(?,?,?,?,?,?,?,?,'r')",
		);
		const ready = '{"executor":"codex","laneDispatch":{"state":"ready"}}';
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
			'{"executor":"codex"}',
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
			`INSERT INTO work_items(id,org_id,title,disposition,metadata,start_at,created_at,admission_spec_revision,work_class,purpose_exception_expires_at) VALUES(?,'o','t','accepted','{"executor":"codex","laneDispatch":{"state":"ready"}}',?,'2026-01-01','r','maintenance','2026-11-30T00:00:00.000Z')`,
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
