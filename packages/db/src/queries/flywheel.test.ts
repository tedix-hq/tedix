import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import {
	buildCronFlywheelHealth,
	EXPECTED_COGNITIVE_CRONS,
} from "./flywheel/cron-executions";
import {
	buildDecisionEpisodeQuality,
	getDecisionEpisodeProjections,
} from "./flywheel/decision-episodes";
import { extractFactIdsFromFlywheelEvidence } from "./flywheel/evidence-fact-ids";
import {
	type FlywheelAccess,
	getTaskTypeLearningCurves,
} from "./flywheel/learning-curves";
import { getBrainProducerQuality } from "./flywheel/producer-quality";

const access: FlywheelAccess = {
	tediId: "tedi-1",
	orgId: "org-1",
};

/** Insert a row, filling unrelated NOT NULL columns with placeholders. */
function insertWithPlaceholders(
	sqlite: ReturnType<typeof createMigratedSqlite>,
	table: string,
	row: Record<string, string>,
) {
	const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{
		name: string;
		notnull: number;
		dflt_value: unknown;
		type: string;
	}>;
	const values: Record<string, string | number> = { ...row };
	for (const column of columns) {
		if (column.name in values || !column.notnull || column.dflt_value != null)
			continue;
		values[column.name] = /INT|REAL/i.test(column.type) ? 0 : column.name;
	}
	const names = Object.keys(values);
	sqlite
		.prepare(
			`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
		)
		.run(...names.map((name) => values[name]!));
}

function flywheelDb() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const d1 = createD1Facade(sqlite);
	const statements: string[] = [];
	const prepare = d1.prepare.bind(d1);
	d1.prepare = (query: string) => {
		statements.push(query);
		return prepare(query);
	};
	return { db: createDbClient(d1), sqlite, statements };
}

describe("flywheel query helpers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("scores brain producers by provenance and downstream use", async () => {
		vi.spyOn(Date, "now").mockReturnValue(
			new Date("2026-05-22T12:00:00.000Z").getTime(),
		);
		const db = {
			all: vi.fn().mockResolvedValueOnce([
				{
					producer: "afterTurn",
					factsLearned: 10,
					activeFacts: 9,
					archivedFacts: 1,
					probationFacts: 2,
					withProvenance: 10,
					retrievedFacts: 6,
					feedbackTouchedFacts: 3,
					citedFacts: 2,
					avgConfidence: 0.82,
				},
			]),
		};

		const quality = await getBrainProducerQuality(db as never, access, 14);

		expect(quality.summary).toMatchObject({
			producerCount: 1,
			factsLearned: 10,
		});
		expect(quality.producers[0]).toMatchObject({
			producer: "afterTurn",
			avgConfidence: 0.82,
			rates: {
				provenance: 1,
				lifecycle: 0.9,
				retrieval: 0.6,
				feedback: 0.5,
				citation: 0.2,
				archive: 0.1,
			},
		});
		expect(quality.producers[0]?.score).toBeGreaterThan(0.6);
	});

	it("extracts fact ids from the evidence shapes used by flywheel projections", () => {
		expect(
			extractFactIdsFromFlywheelEvidence({
				factIds: ["top-level"],
				provenance: {
					retrievedFacts: [{ factId: "retrieved" }],
				},
				metadata: {
					id: "work-item-id",
					facts: [{ id: "fact-record" }],
				},
			}),
		).toEqual(["top-level", "retrieved", "fact-record"]);
	});

	it("extracts fact ids from stringified rationale evidence", () => {
		expect(
			extractFactIdsFromFlywheelEvidence(
				JSON.stringify({
					provenance: {
						retrieved_facts: [{ fact_id: "json-fact" }],
					},
				}),
			),
		).toEqual(["json-fact"]);
	});

	it("projects decision episodes with objective and approval context", async () => {
		const { db, sqlite, statements } = flywheelDb();
		sqlite
			.prepare(
				`INSERT INTO tedi_rationale_records (id, tedi_id, org_id, action, rationale, category, confidence, evidence, outcome_status, objective_id, approval_request_id, run_id, tool_call_refs, proof_ref, created_at, completed_at)
				 VALUES ('decision-1', 'tedi-1', 'org-1', 'Deploy app', 'why', 'deployment', 0.82, ?, 'success', 'objective-1', 'approval-1', 'tedi-1:mcp:171', ?, ?, '2026-05-22T10:00:00.000Z', '2026-05-22T10:10:00.000Z')`,
			)
			.run(
				JSON.stringify({ factIds: ["fact-1"] }),
				JSON.stringify([
					"tedi-1:mcp:171:step:0:0:deploy_worker",
					"tedi-1:mcp:171:step:1:0:verify_deploy",
				]),
				JSON.stringify({ kind: "run", ref: "tedi-1:mcp:171" }),
			);
		sqlite.exec(
			`INSERT INTO work_items (id, org_id, title, objective_id, provenance, metadata, created_at, admission_spec_revision)
			 VALUES ('work-1', 'org-1', 'Ship deployment', 'objective-1', '{}', '{}', '2026-05-22T09:00:00.000Z', 'fixture');`,
		);
		insertWithPlaceholders(sqlite, "mcp_payment_events", {
			id: "payment-1",
			organization_id: "org-1",
			tedi_id: "tedi-1",
			rationale_record_id: "decision-1",
		});
		statements.length = 0;

		const [episode] = await getDecisionEpisodeProjections(db, access, 1);

		expect(episode).toMatchObject({
			decisionId: "decision-1",
			objectiveId: "objective-1",
			approvalRequestId: "approval-1",
			// WS1: stored execution links surface on the projection.
			runId: "tedi-1:mcp:171",
			toolCallRefs: [
				"tedi-1:mcp:171:step:0:0:deploy_worker",
				"tedi-1:mcp:171:step:1:0:verify_deploy",
			],
			proofRef: { kind: "run", ref: "tedi-1:mcp:171" },
			factIds: ["fact-1"],
			workItemIds: ["work-1"],
			// Stored refs (2) win over the telemetry-window heuristic count.
			toolCallCount: 2,
			paymentEventCount: 1,
		});
		expect(episode?.nodes.map((node) => node.type)).toEqual(
			expect.arrayContaining([
				"decision",
				"fact",
				"outcome",
				"run",
				"work_item",
				"tool_call",
				"payment",
				"objective",
				"approval_request",
			]),
		);
		expect(episode?.edges.map((edge) => edge.type)).toEqual(
			expect.arrayContaining([
				"CITES",
				"COMPLETED_AS",
				"EXPLAINED_BY",
				"EXECUTED",
				"EXECUTED_IN",
				"SPENT_OR_REQUESTED",
				"SERVES_OBJECTIVE",
				"GATED_BY",
			]),
		);

		const quality = buildDecisionEpisodeQuality([episode!]);
		expect(quality).toMatchObject({
			episodeCount: 1,
			decisionsWithoutFacts: 0,
			pendingOutcomes: 0,
			episodesWithoutWorkItems: 0,
			episodesWithoutToolCalls: 0,
			episodesWithoutExecutionLinks: 0,
			episodesWithProofRefs: 1,
			episodesWithPayments: 1,
		});
		expect(quality.gaps).toEqual([]);
		expect(statements).toHaveLength(5);
	});

	it("flags unlinked legacy episodes in the WS1 quality gate", async () => {
		const { db, sqlite } = flywheelDb();
		sqlite.exec(
			`INSERT INTO tedi_rationale_records (id, tedi_id, org_id, action, rationale, category, confidence, evidence, outcome_status, created_at, completed_at)
			 VALUES ('decision-legacy', 'tedi-1', 'org-1', 'Old decision', 'why', 'custom', 0.5, '{}', 'success', '2026-05-01T10:00:00.000Z', '2026-05-01T10:10:00.000Z')`,
		);

		const [episode] = await getDecisionEpisodeProjections(db, access, 1);

		expect(episode).toMatchObject({
			runId: null,
			toolCallRefs: [],
			proofRef: null,
			workItemIds: [],
			toolCallCount: 0,
		});
		const quality = buildDecisionEpisodeQuality([episode!]);
		expect(quality.episodesWithoutExecutionLinks).toBe(1);
		expect(quality.episodesWithProofRefs).toBe(0);
		expect(quality.gaps).toEqual(
			expect.arrayContaining([expect.stringContaining("NO execution link")]),
		);
	});

	it("aggregates every task episode into bounded curves and raises regressions", async () => {
		vi.spyOn(Date, "now").mockReturnValue(
			new Date("2026-05-22T12:00:00.000Z").getTime(),
		);
		const { db, sqlite } = flywheelDb();
		// Eight operator episodes: four clean baseline runs, then four slower,
		// costlier, half-failing recent runs.
		const insertEpisode = sqlite.prepare(
			`INSERT INTO tedi_rationale_records (id, tedi_id, org_id, action, rationale, category, confidence, evidence, outcome_status, run_id, work_item_id, tool_call_refs, proof_ref, created_at, completed_at)
			 VALUES (?, 'tedi-1', 'org-1', 'Deploy', 'why', 'deployment', 0.8, '{"taskType":"skill:deploy"}', ?, ?, 'work-1', ?, ?, ?, ?)`,
		);
		const insertRunCompleted = sqlite.prepare(
			`INSERT INTO tedi_runtime_events (id, organization_id, tedi_id, run_id, kind, payload, runtime_backend, created_at)
			 VALUES (?, 'org-1', 'tedi-1', ?, 'run.completed', ?, 'cloudflare', ?)`,
		);
		for (let index = 0; index < 8; index++) {
			const recent = index >= 4;
			const createdAt = new Date(
				Date.UTC(2026, 4, 20, 10, index),
			).toISOString();
			const completedAt = new Date(
				Date.parse(createdAt) + (recent ? 6000 : 1000),
			).toISOString();
			const success = !recent || index % 2 === 0;
			insertEpisode.run(
				`episode-${index}`,
				success ? "success" : "failure",
				`run-${index}`,
				JSON.stringify(
					Array.from({ length: recent ? 5 : 2 }, (_, step) => `step-${step}`),
				),
				success ? JSON.stringify({ kind: "run", ref: `run-${index}` }) : null,
				createdAt,
				completedAt,
			);
			insertRunCompleted.run(
				`event-${index}`,
				`run-${index}`,
				JSON.stringify({ tokensUsed: recent ? 4000 : 1000 }),
				completedAt,
			);
		}

		const report = await getTaskTypeLearningCurves(db, access, {
			windowDays: 30,
			limit: 10,
		});

		expect(report.curves[0]).toMatchObject({
			cohort: "operator",
			taskType: "skill:deploy",
			totalEpisodes: 8,
			direction: "regressed",
		});
		expect(report.alerts.map((alert) => alert.metric)).toEqual(
			expect.arrayContaining([
				"success_rate",
				"steps",
				"duration",
				"token_cost",
			]),
		);
		expect(report.alerts.every((alert) => alert.cohort === "operator")).toBe(
			true,
		);
		expect(report.pagination).toEqual({
			offset: 0,
			limit: 10,
			totalTaskTypes: 1,
			nextOffset: null,
		});
	});

	it("projects the cron execution ledger onto the six expected cognitive crons", () => {
		const now = new Date("2026-07-16T12:00:00.000Z").getTime();
		const hoursAgo = (h: number) =>
			new Date(now - h * 60 * 60 * 1000).toISOString();

		const crons = buildCronFlywheelHealth(
			[
				{
					cronName: "brain-reflection",
					status: "success",
					startedAt: hoursAgo(2),
					finishedAt: hoursAgo(1.9),
				},
				{
					cronName: "objective-review",
					status: "failure",
					startedAt: hoursAgo(20),
					finishedAt: hoursAgo(19.9),
				},
				{
					cronName: "app-operations",
					status: "running",
					startedAt: hoursAgo(1),
					finishedAt: null,
				},
				// A non-expected cron in the ledger is ignored by this projection.
				{
					cronName: "deploy-reconciler",
					status: "success",
					startedAt: hoursAgo(0.2),
					finishedAt: hoursAgo(0.1),
				},
			],
			[
				{ cronName: "brain-reflection", cnt: 3 },
				{ cronName: "objective-review", cnt: 1 },
				{ cronName: "deploy-reconciler", cnt: 90 },
			],
			now,
			[
				{
					cronName: "skill-development",
					enabled: true,
					lastBudgetBlockedAt: hoursAgo(1),
					lastBudgetBlockedReason:
						"governed_learning inference budget exhausted",
					lastBudgetResetAt: new Date(now + 12 * 60 * 60 * 1000).toISOString(),
					lastBudgetAdmissionClass: "governed_learning",
				},
			],
		);

		expect(crons).toHaveLength(EXPECTED_COGNITIVE_CRONS.length);
		const byName = new Map(crons.map((cron) => [cron.name, cron]));

		// Fresh success within interval (8h): stamped, not overdue.
		expect(byName.get("brain-reflection")).toMatchObject({
			lastExecutedAt: hoursAgo(2),
			lastSuccess: true,
			executionsLast24h: 3,
			expectedIntervalHours: 8,
			overdue: false,
			state: "healthy",
		});

		// Failed fire past 1.5×4h: stamped, overdue, lastSuccess=false.
		expect(byName.get("objective-review")).toMatchObject({
			lastSuccess: false,
			executionsLast24h: 1,
			overdue: true,
			state: "failed",
		});

		// Still running: lastSuccess is null (no terminal verdict yet).
		expect(byName.get("app-operations")).toMatchObject({
			lastExecutedAt: hoursAgo(1),
			lastSuccess: null,
			executionsLast24h: 0,
			overdue: false,
			state: "running",
		});

		// A suppressed occurrence remains mechanically overdue but is projected
		// as budget governance, not a scheduler/runtime failure.
		expect(byName.get("skill-development")).toMatchObject({
			lastExecutedAt: null,
			lastSuccess: null,
			executionsLast24h: 0,
			overdue: true,
			state: "budget_blocked",
			budgetBlockedAt: hoursAgo(1),
			budgetBlockedReason: "governed_learning inference budget exhausted",
			budgetBlockActive: true,
			budgetAdmissionClass: "governed_learning",
		});
		expect(byName.has("deploy-reconciler")).toBe(false);

		const optedOut = buildCronFlywheelHealth([], [], now, [], new Set());
		expect(optedOut).toHaveLength(EXPECTED_COGNITIVE_CRONS.length);
		expect(optedOut.every((cron) => cron.state === "disabled")).toBe(true);
		expect(optedOut.every((cron) => cron.overdue === false)).toBe(true);
	});
});
