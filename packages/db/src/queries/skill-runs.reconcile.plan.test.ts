import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import {
	listSkillRunsAwaitingReconcile,
	listSkillRunsForOrg,
	listSkillRunsForTedi,
} from "./skill-runs";

const PENDING = "idx_skill_runs_reconcile_pending";

// The statement as the runtime ran it before, on the index it ran on.
const BEFORE = `SELECT id FROM skill_runs INDEXED BY idx_skill_runs_reconcile
	WHERE runtime_environment = ?1
	  AND workflow_retired_at IS NULL
	  AND COALESCE(error, '') <> 'REVOKED'
	  AND COALESCE(error, '') NOT GLOB 'REVOKED:*'
	  AND (status IN ('queued','running','paused')
	       OR restart_requested_at IS NOT NULL
	       OR (status = 'failed'
	           AND (error LIKE 'WORKFLOW_ADMISSION_CREATE_FAILED:%'
	                OR error LIKE 'WORKFLOW_ADMISSION_PENDING:%')))
	ORDER BY COALESCE(last_reconciled_at, started_at) ASC, started_at ASC
	LIMIT ?2`;

type Statistics = "none" | "analysed" | "analysed before the index";

function fixture(statistics: Statistics, options?: { dropIndex?: boolean }) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const insert = sqlite.prepare(
		"INSERT INTO skill_runs (id, organization_id, skill_id, tedi_id, workflow_instance_id, runtime_environment, status, error, restart_requested_at, workflow_retired_at, last_reconciled_at, started_at, params) VALUES (?, ?, 'skill-1', 'tedi-1', ?, ?, ?, ?, ?, ?, ?, ?, '{\"n\":1}')",
	);
	const at = (minute: number) =>
		new Date(Date.UTC(2026, 10, 1) + minute * 60_000).toISOString();
	// Finished history: what the old scan walked on every tick.
	for (let i = 0; i < 3000; i++)
		insert.run(
			`done-${i}`,
			i % 4 === 0 ? "org-other" : "org-example",
			`wf-done-${i}`,
			i % 10 === 0 ? "staging" : "production",
			i % 7 === 0 ? "failed" : i % 9 === 0 ? "canceled" : "completed",
			i % 7 === 0 ? "Step failed" : null,
			null,
			null,
			i % 3 === 0 ? at(i + 5) : null,
			at(i),
		);
	// Runs the scan has to return or skip. Every one has its own start time,
	// so the order is fully decided and both plans must agree on it.
	const statuses = ["running", "queued", "paused"];
	for (let i = 0; i < 120; i++)
		insert.run(
			`open-${i}`,
			i % 4 === 0 ? "org-other" : "org-example",
			`wf-open-${i}`,
			i % 6 === 0 ? "staging" : "production",
			statuses[i % 3] ?? "running",
			i % 11 === 0 ? "REVOKED_TOKEN_REFRESH_FAILED" : null,
			null,
			null,
			// Some never visited, some visited out of start order.
			i % 2 === 0 ? null : at(9000 - i * 13),
			at(4000 + i * 7 + 1),
		);
	for (const [id, status, error, restart, retired, reconciled, minute] of [
		["restart-done", "completed", null, at(1), null, null, 5003],
		["restart-failed", "failed", "Step failed", at(2), null, at(8000), 5011],
		["admission-create", "failed", "WORKFLOW_ADMISSION_CREATE_FAILED: timeout"],
		["admission-pending", "failed", "WORKFLOW_ADMISSION_PENDING: workflow"],
		["admission-lower", "failed", "workflow_admission_pending: x"],
		["retired-running", "running", null, null, at(3), null, 5023],
		["retired-restart", "completed", null, at(4), at(5), null, 5027],
		["revoked-running", "running", "REVOKED", null, null, null, 5031],
		["revoked-reason", "queued", "REVOKED: by owner", null, null, null, 5037],
		["revoked-restart", "completed", "REVOKED", at(6), null, null, 5041],
	] as const)
		insert.run(
			id,
			"org-example",
			`wf-${id}`,
			"production",
			status,
			error,
			restart ?? null,
			retired ?? null,
			reconciled ?? null,
			at(minute ?? 5050 + id.length * 3 + id.charCodeAt(10)),
		);
	if (options?.dropIndex) sqlite.exec(`DROP INDEX ${PENDING}`);
	if (statistics !== "none") sqlite.exec("ANALYZE; ANALYZE sqlite_schema;");
	// The state right after the migration: statistics for every index but
	// the new one.
	if (statistics === "analysed before the index")
		sqlite.exec(
			`DELETE FROM sqlite_stat1 WHERE idx = '${PENDING}'; ANALYZE sqlite_schema;`,
		);
	const plans: string[] = [];
	const explain = (query: string) =>
		sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array((query.match(/\?(?!\d)/g) ?? []).length).fill(null))
			.map((row) => String(row.detail))
			.join(" | ");
	const db = createDbClient(
		createD1Facade({
			prepare(query) {
				if (/^select/i.test(query) && query.includes('"skill_runs"'))
					plans.push(explain(query));
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	return { sqlite, db, plans, explain };
}

describe.each([
	{ statistics: "none" },
	{ statistics: "analysed" },
	{ statistics: "analysed before the index" },
] as const)(
	"runs awaiting the reconciler with $statistics statistics",
	({ statistics }) => {
		it("reads the waiting runs in scan order instead of walking and sorting the environment's history", async () => {
			const { db, plans } = fixture(statistics);
			await listSkillRunsAwaitingReconcile(db, "production", 50);
			expect(plans).toEqual([
				`SEARCH skill_runs USING INDEX ${PENDING} (runtime_environment=?)`,
			]);
		});

		it("returns the runs the walk returned, in the same order", async () => {
			const { sqlite, db } = fixture(statistics);
			const before = sqlite.prepare(BEFORE);
			for (const environment of [
				"production",
				"staging",
				"development",
			] as const)
				for (const limit of [1, 7, 50, 500]) {
					const rows = await listSkillRunsAwaitingReconcile(
						db,
						environment,
						limit,
					);
					expect(
						rows.map((row) => row.id),
						`${environment} ${limit}`,
					).toEqual(before.all(environment, limit).map((row) => row.id));
				}
			const all = await listSkillRunsAwaitingReconcile(db, "production", 500);
			const ids = all.map((row) => row.id);
			// 100 open production runs plus the restart and admission cases; never
			// a retired or revoked run, never ordinary finished history.
			expect(ids).toHaveLength(105);
			expect(ids).toEqual(
				expect.arrayContaining([
					"restart-done",
					"restart-failed",
					"admission-create",
					"admission-pending",
					"admission-lower",
					"open-11",
				]),
			);
			expect(ids.filter((id) => /^(done|retired|revoked)-/.test(id))).toEqual(
				[],
			);
			expect(all.find((row) => row.id === "admission-create")).toMatchObject({
				organizationId: "org-example",
				skillId: "skill-1",
				tediId: "tedi-1",
				workflowInstanceId: "wf-admission-create",
				params: { n: 1 },
				status: "failed",
				error: "WORKFLOW_ADMISSION_CREATE_FAILED: timeout",
				executionEpoch: 0,
				restartRequestedAt: null,
				restartCommandId: null,
			});
		});

		it("moves a visited run behind the ones not visited since", async () => {
			const { sqlite, db } = fixture(statistics);
			const [first, second] = await listSkillRunsAwaitingReconcile(
				db,
				"production",
				2,
			);
			sqlite
				.prepare(
					"UPDATE skill_runs SET last_reconciled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
				)
				.run(first?.id ?? "");
			const next = await listSkillRunsAwaitingReconcile(db, "production", 500);
			expect(next[0]?.id).toBe(second?.id);
			expect(next.at(-1)?.id).toBe(first?.id);
			// A run that finishes leaves the scan.
			sqlite
				.prepare("UPDATE skill_runs SET status = 'completed' WHERE id = ?")
				.run(second?.id ?? "");
			expect(
				(await listSkillRunsAwaitingReconcile(db, "production", 500)).map(
					(row) => row.id,
				),
			).not.toContain(second?.id);
		});

		it("is not offered to reads that do not state its condition", async () => {
			const { db, plans, explain } = fixture(statistics);
			for (const query of [
				`SELECT id FROM skill_runs INDEXED BY ${PENDING} WHERE runtime_environment = ?`,
				`SELECT id FROM skill_runs INDEXED BY ${PENDING} WHERE runtime_environment = ? AND status IN ('queued', 'running', 'paused')`,
				`SELECT id FROM skill_runs INDEXED BY ${PENDING} WHERE organization_id = ? AND runtime_environment = ? ORDER BY started_at DESC`,
			])
				expect(() => explain(query)).toThrow(/no query solution/);
			await listSkillRunsForOrg(db, "org-example", "production", {
				status: "running",
			});
			await listSkillRunsForTedi(db, "org-example", "tedi-1", "production");
			expect(plans.length).toBeGreaterThan(0);
			for (const plan of plans) expect(plan).not.toContain(PENDING);
		});

		it("still answers, on the old plan, on a database without the index", async () => {
			const { sqlite, db, plans } = fixture(statistics, { dropIndex: true });
			const rows = await listSkillRunsAwaitingReconcile(db, "production", 50);
			expect(rows.map((row) => row.id)).toEqual(
				sqlite
					.prepare(BEFORE)
					.all("production", 50)
					.map((row) => row.id),
			);
			expect(plans).toEqual([
				"SEARCH skill_runs USING INDEX idx_skill_runs_reconcile (runtime_environment=?) | USE TEMP B-TREE FOR ORDER BY",
			]);
		});
	},
);
