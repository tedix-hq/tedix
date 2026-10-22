import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { listWorkItemsPage } from "./crud";

const migration = "20261022073425_work_items_lane_dispatch_indexes";

describe("lane dispatch indexes", () => {
	it("indexes existing metadata and follows metadata updates without a backfill", async () => {
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
		sqlite.exec(
			readFileSync(
				new URL(`../../../drizzle/${migration}/migration.sql`, import.meta.url),
				"utf8",
			),
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
			expect(page.total).toBe(Array.isArray(executor) ? 2 : 1);
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
			`UPDATE work_items SET metadata='{"executor":"codex","laneDispatch":{"state":"ready"}}' WHERE id='00003'`,
		);
		const updated = await listWorkItemsPage(db, {
			orgId: "org-1",
			disposition: "accepted",
			executor: "codex",
			dispatchReadyOnly: true,
		});
		expect(updated.data.map((row) => row.id)).toEqual(["00003", "00001"]);
	});
});
