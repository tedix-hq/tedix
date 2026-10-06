import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { getTaskTypeLearningCurves } from "./flywheel/learning-curves";
import { getLearningReplayValidation } from "./flywheel/learning-replay";

describe("flywheel bounded aggregation", () => {
	it("aggregates 2,000 evidence-linked episodes without dropping denominators", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			CREATE TABLE tedi_rationale_records (
				id TEXT PRIMARY KEY, tedi_id TEXT NOT NULL, org_id TEXT NOT NULL,
				category TEXT NOT NULL, evidence TEXT NOT NULL, outcome_status TEXT NOT NULL,
				created_at TEXT NOT NULL, completed_at TEXT, tool_call_refs TEXT,
				run_id TEXT, work_item_id TEXT, proof_ref TEXT
			);
			CREATE INDEX idx_rationale_flywheel_window
				ON tedi_rationale_records (tedi_id, org_id, created_at);
			CREATE TABLE tedi_runtime_events (
				id TEXT PRIMARY KEY, tedi_id TEXT NOT NULL, organization_id TEXT NOT NULL,
				run_id TEXT, kind TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL
			);
			CREATE INDEX idx_tedi_runtime_events_run_created
				ON tedi_runtime_events (tedi_id, run_id, created_at);
		`);
		const insert = sqlite.prepare(`INSERT INTO tedi_rationale_records
			(id, tedi_id, org_id, category, evidence, outcome_status, created_at,
			 completed_at, tool_call_refs, run_id, work_item_id, proof_ref)
			VALUES (?, 'tedi-1', 'org-1', 'optimization', ?, ?, ?, ?, ?, ?, ?, ?)`);
		// Wall-clock-relative: getTaskTypeLearningCurves filters created_at >=
		// Date.now() - windowDays, so a fixed base ages out of the 180d window
		// (see work-items-selection.test.ts T_BASE note). 2000 rows at +1min
		// steps stay in the past by anchoring the base 2100min before the run.
		const base = Date.now() - 2_100 * 60_000;
		for (let index = 0; index < 2_000; index += 1) {
			const createdAt = new Date(base + index * 60_000).toISOString();
			insert.run(
				`episode-${index}`,
				JSON.stringify({ skillSlug: `routine-${index % 4}` }),
				index % 10 === 0 ? "failure" : "success",
				createdAt,
				new Date(Date.parse(createdAt) + 5_000).toISOString(),
				JSON.stringify([`run-${index}:tool:1`, `run-${index}:tool:2`]),
				`run-${index}`,
				index % 2 === 0 ? `work-${index}` : null,
				JSON.stringify({ kind: "run", ref: `run-${index}` }),
			);
		}
		const started = performance.now();
		const report = await getTaskTypeLearningCurves(
			createDbClient(createD1Facade(sqlite)),
			{ tediId: "tedi-1", orgId: "org-1" },
			{ windowDays: 180, limit: 10, maxPointsPerTask: 20 },
		);
		const elapsedMs = performance.now() - started;

		expect(report.pagination.totalTaskTypes).toBe(4);
		expect(report.summary.episodeCount).toBe(2_000);
		expect(report.summary.cohortCounts).toEqual({
			organic: 1_000,
			operator: 1_000,
			scheduled_dogfood: 0,
		});
		expect(report.curves.every((curve) => curve.points.length <= 20)).toBe(
			true,
		);
		expect(elapsedMs).toBeLessThan(1_000);
	});

	it("keeps organic, operator, and scheduled dogfood curves disjoint", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			CREATE TABLE tedi_rationale_records (
				id TEXT PRIMARY KEY, tedi_id TEXT NOT NULL, org_id TEXT NOT NULL,
				category TEXT NOT NULL, evidence TEXT NOT NULL, outcome_status TEXT NOT NULL,
				created_at TEXT NOT NULL, completed_at TEXT, tool_call_refs TEXT,
				run_id TEXT, work_item_id TEXT, proof_ref TEXT
			);
			CREATE TABLE tedi_runtime_events (
				id TEXT PRIMARY KEY, tedi_id TEXT NOT NULL, organization_id TEXT NOT NULL,
				run_id TEXT, kind TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL
			);
		`);
		const insert = sqlite.prepare(`INSERT INTO tedi_rationale_records
			(id, tedi_id, org_id, category, evidence, outcome_status, created_at,
			 completed_at, tool_call_refs, work_item_id, proof_ref)
			VALUES (?, 'tedi-1', 'org-1', 'deploy', ?, 'success', ?, ?, '["tool"]', ?,
			'{"kind":"artifact","ref":"proof"}')`);
		for (let index = 0; index < 12; index += 1) {
			const cohort =
				index < 4 ? "organic" : index < 8 ? "operator" : "scheduled";
			const createdAt = new Date(
				Date.now() - (20 - index) * 60_000,
			).toISOString();
			insert.run(
				`cohort-${index}`,
				JSON.stringify(
					cohort === "scheduled"
						? { taskType: "deploy", skillSlug: "platform-deploy-dogfood" }
						: { taskType: "deploy" },
				),
				createdAt,
				new Date(Date.parse(createdAt) + 1_000).toISOString(),
				cohort === "operator" ? `work-${index}` : null,
			);
		}
		const db = createDbClient(createD1Facade(sqlite));
		const report = await getTaskTypeLearningCurves(
			db,
			{ tediId: "tedi-1", orgId: "org-1" },
			{ windowDays: 7 },
		);
		expect(report.curves).toHaveLength(3);
		expect(report.summary.cohortCounts).toEqual({
			organic: 4,
			operator: 4,
			scheduled_dogfood: 4,
		});
		expect(new Set(report.curves.map((curve) => curve.cohort))).toEqual(
			new Set(["organic", "operator", "scheduled_dogfood"]),
		);

		const scheduled = await getTaskTypeLearningCurves(
			db,
			{ tediId: "tedi-1", orgId: "org-1" },
			{ windowDays: 7, cohort: "scheduled_dogfood" },
		);
		expect(scheduled.cohort).toBe("scheduled_dogfood");
		expect(scheduled.curves).toHaveLength(1);
		expect(scheduled.curves[0]?.cohort).toBe("scheduled_dogfood");
	});

	it("finds later success contrasts without a quadratic self-join", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			CREATE TABLE tedi_rationale_records (
				id TEXT PRIMARY KEY, tedi_id TEXT NOT NULL, org_id TEXT NOT NULL,
				category TEXT NOT NULL, action TEXT NOT NULL, evidence TEXT NOT NULL,
				outcome_status TEXT NOT NULL, created_at TEXT NOT NULL
			);
			CREATE INDEX idx_rationale_replay ON tedi_rationale_records
				(tedi_id, org_id, category, outcome_status, created_at);
		`);
		const insert = sqlite.prepare(`INSERT INTO tedi_rationale_records
			(id, tedi_id, org_id, category, action, evidence, outcome_status, created_at)
			VALUES (?, 'tedi-1', 'org-1', 'deploy', ?, '{}', ?, ?)`);
		// Wall-clock-relative: getLearningReplayValidation filters created_at >=
		// Date.now() - windowDays; a fixed base ages out of the 180d window
		// (see work-items-selection.test.ts T_BASE note).
		const base = Date.now() - 2_100 * 60_000;
		for (let index = 0; index < 2_000; index += 1) {
			insert.run(
				`episode-${index}`,
				`action-${index}`,
				index % 2 === 0 ? "failure" : "success",
				new Date(base + index * 60_000).toISOString(),
			);
		}

		const started = performance.now();
		const report = await getLearningReplayValidation(
			createDbClient(createD1Facade(sqlite)),
			{ tediId: "tedi-1", orgId: "org-1" },
			180,
		);
		const elapsedMs = performance.now() - started;

		expect(report.transitions).toHaveLength(20);
		expect(
			report.signals.find((signal) => signal.key === "failure_to_success")
				?.value,
		).toBe(1);
		expect(
			report.transitions.every((item) => item.successAt > item.failureAt),
		).toBe(true);
		expect(elapsedMs).toBeLessThan(1_000);
	});

	it("measures execution duration from runtime terminals instead of rationale age", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(`
			CREATE TABLE tedi_rationale_records (
				id TEXT PRIMARY KEY, tedi_id TEXT NOT NULL, org_id TEXT NOT NULL,
				category TEXT NOT NULL, evidence TEXT NOT NULL, outcome_status TEXT NOT NULL,
				created_at TEXT NOT NULL, completed_at TEXT, tool_call_refs TEXT,
				run_id TEXT, work_item_id TEXT, proof_ref TEXT
			);
			CREATE TABLE tedi_runtime_events (
				id TEXT PRIMARY KEY, tedi_id TEXT NOT NULL, organization_id TEXT NOT NULL,
				run_id TEXT, kind TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL
			);
			CREATE INDEX idx_tedi_runtime_events_run_created
				ON tedi_runtime_events (tedi_id, run_id, created_at);
		`);
		for (let index = 0; index < 4; index += 1) {
			const runId = `duration-run-${index}`;
			sqlite
				.prepare(`INSERT INTO tedi_rationale_records
				(id, tedi_id, org_id, category, evidence, outcome_status, created_at,
				 completed_at, run_id, proof_ref)
				VALUES (?, 'tedi-1', 'org-1', 'deploy', '{"taskType":"deploy"}',
				'success', datetime('now', '-2 days'), datetime('now', '-1 day'), ?,
				'{"kind":"run","ref":"proof"}')`)
				.run(`duration-${index}`, runId);
			sqlite
				.prepare(`INSERT INTO tedi_runtime_events VALUES
				(?, 'tedi-1', 'org-1', ?, 'run.started', NULL, datetime('now', '-1 hour')),
				(?, 'tedi-1', 'org-1', ?, 'run.completed', '{}', datetime('now', '-1 hour', '+2 seconds'))`)
				.run(`${runId}-started`, runId, `${runId}-completed`, runId);
		}

		const report = await getTaskTypeLearningCurves(
			createDbClient(createD1Facade(sqlite)),
			{ tediId: "tedi-1", orgId: "org-1" },
			{ windowDays: 7 },
		);
		expect(report.curves[0]?.baseline?.averageDurationMs).toBe(2000);
		expect(report.curves[0]?.recent?.averageDurationMs).toBe(2000);
	});
});
