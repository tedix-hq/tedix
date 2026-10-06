import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	GRAPH_RETRIEVAL_BENCHMARK_TRIGGER_SQL,
	type GraphBenchmarkAggregateMetrics,
	type GraphBenchmarkCaseMetrics,
} from "../schema/graph-retrieval-benchmarks";
import { createD1Facade } from "../test/d1-facade";
import {
	EXACT_RETRIEVAL_ONLY_CASE_THRESHOLDS,
	evaluateGraphRetrievalGraduation,
	scoreGraphRetrievalCase,
	validateCanonicalGraphPath,
} from "./graph-retrieval-benchmark-scorer";
import {
	addGraphRetrievalBenchmarkCase,
	completeEligibleGraphRetrievalBenchmarkRunPair,
	completeGraphRetrievalBenchmarkRun,
	createGraphRetrievalBenchmarkSuite,
	evaluateStoredGraphRetrievalGraduation,
	type GraphRetrievalBenchmarkError,
	lockGraphRetrievalBenchmarkSuite,
	recordGraphRetrievalBenchmarkResult,
	recordGraphRetrievalGraduationEvaluation,
	startGraphRetrievalBenchmarkRun,
	startGraphRetrievalBenchmarkRunPair,
} from "./graph-retrieval-benchmarks";

const BENCHMARK_DDL = `
PRAGMA foreign_keys = ON;
CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE graph_retrieval_benchmark_suites (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	version INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'draft',
	split TEXT NOT NULL,
	revision INTEGER NOT NULL DEFAULT 0,
	case_count INTEGER NOT NULL DEFAULT 0,
	definition_checksum TEXT,
	source_commit TEXT,
	artifact_uri TEXT,
	created_by_type TEXT NOT NULL,
	created_by_id TEXT NOT NULL,
	locked_at TEXT,
	retired_at TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	UNIQUE (organization_id, name, version),
	UNIQUE (organization_id, id),
	CHECK (
		(status = 'draft' AND locked_at IS NULL AND retired_at IS NULL AND definition_checksum IS NULL)
		OR (status = 'locked' AND locked_at IS NOT NULL AND retired_at IS NULL AND length(definition_checksum) > 0)
		OR (status = 'retired' AND locked_at IS NOT NULL AND retired_at IS NOT NULL AND length(definition_checksum) > 0)
	)
);
CREATE TABLE graph_retrieval_benchmark_cases (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	suite_id TEXT NOT NULL REFERENCES graph_retrieval_benchmark_suites(id) ON DELETE RESTRICT,
	suite_revision INTEGER NOT NULL,
	case_key TEXT NOT NULL,
	query TEXT NOT NULL,
	anchor_fact_ids TEXT NOT NULL DEFAULT '[]',
	expected_fact_ids TEXT NOT NULL,
	expected_edges TEXT NOT NULL DEFAULT '[]',
	expected_paths TEXT NOT NULL DEFAULT '[]',
	forbidden_fact_ids TEXT NOT NULL DEFAULT '[]',
	valid_at TEXT NOT NULL,
	answer_rubric TEXT NOT NULL DEFAULT '{}',
	artifact_uri TEXT,
	tags TEXT NOT NULL DEFAULT '[]',
	difficulty TEXT NOT NULL DEFAULT 'intermediate',
	checksum TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	UNIQUE (suite_id, case_key),
	UNIQUE (suite_id, checksum)
);
CREATE TABLE graph_retrieval_benchmark_runs (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	suite_id TEXT NOT NULL REFERENCES graph_retrieval_benchmark_suites(id) ON DELETE RESTRICT,
	suite_checksum TEXT NOT NULL,
	paired_run_key TEXT NOT NULL,
	variant TEXT NOT NULL,
	retrieval_policy_version TEXT NOT NULL,
	harness_version_id TEXT,
	model_provider TEXT NOT NULL,
	model_id TEXT NOT NULL,
	model_version TEXT NOT NULL,
	projection_snapshot TEXT NOT NULL,
	seed INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'running',
	case_count INTEGER NOT NULL DEFAULT 0,
	aggregate_metrics TEXT,
	total_input_tokens INTEGER NOT NULL DEFAULT 0,
	total_output_tokens INTEGER NOT NULL DEFAULT 0,
	total_latency_ms INTEGER NOT NULL DEFAULT 0,
	total_cost_usd REAL NOT NULL DEFAULT 0,
	eligible INTEGER NOT NULL DEFAULT 0,
	trace_artifact_uri TEXT,
	failure_reason TEXT,
	started_at TEXT NOT NULL,
	completed_at TEXT,
	UNIQUE (organization_id, paired_run_key, variant),
	UNIQUE (organization_id, id)
);
CREATE TABLE graph_retrieval_benchmark_results (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	run_id TEXT NOT NULL REFERENCES graph_retrieval_benchmark_runs(id) ON DELETE RESTRICT,
	case_id TEXT NOT NULL REFERENCES graph_retrieval_benchmark_cases(id) ON DELETE RESTRICT,
	origin TEXT NOT NULL DEFAULT 'manual',
	retrieved_fact_ids TEXT NOT NULL,
	returned_edges TEXT NOT NULL DEFAULT '[]',
	returned_paths TEXT NOT NULL DEFAULT '[]',
	answer TEXT,
	cited_fact_ids TEXT NOT NULL DEFAULT '[]',
	claim_support TEXT NOT NULL DEFAULT '[]',
	metrics TEXT NOT NULL,
	input_tokens INTEGER NOT NULL,
	output_tokens INTEGER NOT NULL,
	latency_ms INTEGER NOT NULL,
	cost_usd REAL NOT NULL,
	passed INTEGER NOT NULL,
	failure_reasons TEXT NOT NULL DEFAULT '[]',
	trace_artifact_uri TEXT,
	created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	UNIQUE (run_id, case_id)
);
CREATE TABLE graph_retrieval_graduation_evaluations (
	id TEXT PRIMARY KEY NOT NULL,
	organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	suite_id TEXT NOT NULL REFERENCES graph_retrieval_benchmark_suites(id) ON DELETE RESTRICT,
	baseline_run_id TEXT NOT NULL REFERENCES graph_retrieval_benchmark_runs(id) ON DELETE RESTRICT,
	graph_run_id TEXT NOT NULL REFERENCES graph_retrieval_benchmark_runs(id) ON DELETE RESTRICT,
	evaluator_version TEXT NOT NULL,
	passed INTEGER NOT NULL,
	gates TEXT NOT NULL,
	paired_metrics TEXT NOT NULL,
	projection_snapshot TEXT NOT NULL,
	reasons TEXT NOT NULL,
	evaluated_at TEXT NOT NULL,
	UNIQUE (baseline_run_id, graph_run_id, evaluator_version)
);
`;

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(BENCHMARK_DDL);
	for (const trigger of GRAPH_RETRIEVAL_BENCHMARK_TRIGGER_SQL) {
		sqlite.exec(trigger);
	}
	sqlite.prepare("INSERT INTO organizations (id) VALUES (?)").run("org-1");
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

const T0 = "2026-07-26T10:00:00.000Z";
const T1 = "2026-07-26T10:01:00.000Z";
const T2 = "2026-07-26T10:02:00.000Z";
const T3 = "2026-07-26T10:03:00.000Z";
const projection = {
	configured: true,
	healthy: true,
	passesGate: true,
	state: "ready",
	projectionEpoch: "d1:42",
	persistedWatermark: 42,
	gdsWatermark: 42,
	gdsEpoch: "d1:42",
	nodeMismatchCount: 0,
	edgeMismatchCount: 0,
	lifecycleMismatchCount: 0,
	certifiedAt: T0,
} as const;
const expectedEdge = {
	sourceFactId: "fact-a",
	targetFactId: "fact-b",
	relationType: "requires",
};
const expectedPath = {
	factIds: ["fact-a", "fact-b"],
	edges: [expectedEdge],
};
const canonicalFacts = [
	{
		id: "fact-a",
		organizationId: "org-1",
		validFrom: "2026-01-01T00:00:00.000Z",
		validTo: null,
		archivedAt: null,
	},
	{
		id: "fact-b",
		organizationId: "org-1",
		validFrom: "2026-01-01T00:00:00.000Z",
		validTo: null,
		archivedAt: null,
	},
];
const canonicalEdges = [{ ...expectedEdge, organizationId: "org-1" }];
const perfectRetrievalMetrics: GraphBenchmarkCaseMetrics = {
	factRecall: 1,
	factPrecision: 1,
	edgeRecall: 1,
	edgePrecision: 1,
	pathValidity: 1,
	expectedPathCoverage: 1,
	temporalAccuracy: 1,
	forbiddenFactRate: 0,
	citationRecall: 0,
	citationPrecision: 1,
	unsupportedInferenceRate: 0,
	answerScore: 0,
};
const anchorOnlyRetrievalMetrics: GraphBenchmarkCaseMetrics = {
	...perfectRetrievalMetrics,
	factRecall: 0.5,
	edgeRecall: 0,
	pathValidity: 0,
	expectedPathCoverage: 0,
};

function perfectRetrievalAggregate(
	overrides: Partial<GraphBenchmarkAggregateMetrics> = {},
): GraphBenchmarkAggregateMetrics {
	return {
		...perfectRetrievalMetrics,
		caseCount: 20,
		passedCaseCount: 20,
		p95LatencyMs: 12,
		meanLatencyMs: 12,
		meanInputTokens: 0,
		meanOutputTokens: 0,
		meanCostUsd: 0,
		...overrides,
	};
}

const eligiblePairIntegrity = {
	sameSuiteChecksum: true,
	sameModel: true,
	sameRetrievalPolicy: true,
	sameSeed: true,
	baselineCompleted: true,
	graphCompleted: true,
	baselineEligible: true,
	graphEligible: true,
	sameProjectionSnapshot: true,
	noMissingCases: true,
};

function perfectPairedMetrics() {
	return {
		pairedCaseCount: 20,
		answerScoreLift: 0,
		factRecallLift: 0,
		factPrecisionLift: 0,
		edgeRecallLift: 0,
		pathValidityLift: 0,
		expectedPathCoverageLift: 0,
		temporalAccuracyLift: 0,
		unsupportedInferenceRateDelta: 0,
		forbiddenFactRateDelta: 0,
		p95LatencyMsDelta: 2,
		meanTokenDelta: 0,
		meanCostUsdDelta: 0,
	};
}

async function seedLockedSuite(
	db: ReturnType<typeof createDbClient>,
	caseCount = 1,
) {
	await createGraphRetrievalBenchmarkSuite(db, {
		id: "suite-1",
		organizationId: "org-1",
		name: "graph-grounding",
		version: 1,
		split: "locked_test",
		sourceCommit: "deadbeef",
		createdByType: "tedi",
		createdById: "cto",
		createdAt: T0,
	});
	for (let index = 1; index <= caseCount; index++) {
		await addGraphRetrievalBenchmarkCase(db, {
			id: `case-${index}`,
			organizationId: "org-1",
			suiteId: "suite-1",
			expectedSuiteRevision: index - 1,
			caseKey: `canonical-path-${index}`,
			query: "What does fact A require?",
			anchorFactIds: ["fact-a"],
			expectedFactIds: ["fact-a", "fact-b"],
			expectedEdges: [expectedEdge],
			expectedPaths: [expectedPath],
			forbiddenFactIds: ["fact-stale"],
			validAt: T1,
			answerRubric: { mustMention: "fact-b" },
			checksum: `case-checksum-${index}`,
			createdAt: T0,
		});
	}
	return lockGraphRetrievalBenchmarkSuite(db, {
		organizationId: "org-1",
		suiteId: "suite-1",
		expectedRevision: caseCount,
		minimumCaseCount: caseCount,
		definitionChecksum: "suite-checksum-1",
		lockedAt: T1,
	});
}

describe("canonical graph path scoring", () => {
	it("validates every node, temporal lifecycle, and edge against D1 truth", () => {
		const factsById = new Map(canonicalFacts.map((fact) => [fact.id, fact]));
		const edgeKeys = new Set(["fact-a\u001frequires\u001ffact-b"]);
		expect(
			validateCanonicalGraphPath(expectedPath, {
				organizationId: "org-1",
				validAt: T1,
				factsById,
				canonicalEdgeKeys: edgeKeys,
			}),
		).toBe(true);
		expect(
			validateCanonicalGraphPath(
				{
					factIds: ["fact-a", "fact-b"],
					edges: [{ ...expectedEdge, relationType: "invented" }],
				},
				{
					organizationId: "org-1",
					validAt: T1,
					factsById,
					canonicalEdgeKeys: edgeKeys,
				},
			),
		).toBe(false);
		const staleFacts = new Map(factsById);
		staleFacts.set("fact-b", {
			...canonicalFacts[1]!,
			validTo: "2026-06-01T00:00:00.000Z",
		});
		expect(
			validateCanonicalGraphPath(expectedPath, {
				organizationId: "org-1",
				validAt: T1,
				factsById: staleFacts,
				canonicalEdgeKeys: edgeKeys,
			}),
		).toBe(false);
	});

	it("scores graph evidence without treating a returned path as self-validating", () => {
		const scored = scoreGraphRetrievalCase({
			expectation: {
				organizationId: "org-1",
				validAt: T1,
				expectedFactIds: ["fact-a", "fact-b"],
				expectedEdges: [expectedEdge],
				expectedPaths: [expectedPath],
				forbiddenFactIds: ["fact-stale"],
			},
			observation: {
				retrievedFactIds: ["fact-a", "fact-b"],
				returnedEdges: [expectedEdge],
				returnedPaths: [expectedPath],
				citedFactIds: ["fact-a", "fact-b"],
				claimSupport: [{ claimId: "claim-1", citedFactIds: ["fact-b"] }],
				answerScore: 0.95,
				inputTokens: 100,
				outputTokens: 20,
				latencyMs: 100,
				costUsd: 0.01,
			},
			canonicalFacts,
			canonicalEdges,
		});
		expect(scored.passed).toBe(true);
		expect(scored.metrics).toMatchObject({
			factRecall: 1,
			edgeRecall: 1,
			pathValidity: 1,
			expectedPathCoverage: 1,
			temporalAccuracy: 1,
			unsupportedInferenceRate: 0,
		});
	});

	it("uses exact retrieval-only thresholds instead of accepting an 0.8 partial hit", () => {
		const facts = Array.from({ length: 5 }, (_, index) => ({
			id: `exact-${index + 1}`,
			organizationId: "org-1",
			validFrom: "2026-01-01T00:00:00.000Z",
			validTo: null,
			archivedAt: null,
		}));
		const input = {
			expectation: {
				organizationId: "org-1",
				validAt: T1,
				expectedFactIds: facts.map((fact) => fact.id),
				expectedEdges: [],
				expectedPaths: [],
				forbiddenFactIds: [],
			},
			observation: {
				retrievedFactIds: facts.slice(0, 4).map((fact) => fact.id),
				returnedEdges: [],
				returnedPaths: [],
				citedFactIds: [],
				claimSupport: [],
				answerScore: 1,
				inputTokens: 0,
				outputTokens: 0,
				latencyMs: 1,
				costUsd: 0,
			},
			canonicalFacts: facts,
			canonicalEdges: [],
		};
		expect(scoreGraphRetrievalCase(input).passed).toBe(true);
		const exact = scoreGraphRetrievalCase({
			...input,
			thresholds: EXACT_RETRIEVAL_ONLY_CASE_THRESHOLDS,
		});
		expect(exact.passed).toBe(false);
		expect(exact.metrics.factRecall).toBe(0.8);
		expect(exact.failureReasons).toContain("fact recall 0.8 < 1");
	});
});

describe("locked D1 graph benchmark ledger", () => {
	it("makes cases immutable and rejects additions after the suite lock", async () => {
		const { db, sqlite } = fixture();
		const suite = await seedLockedSuite(db);
		expect(suite).toMatchObject({
			status: "locked",
			revision: 1,
			caseCount: 1,
			definitionChecksum: "suite-checksum-1",
		});
		expect(() =>
			sqlite
				.prepare(
					"UPDATE graph_retrieval_benchmark_cases SET query = 'rewrite' WHERE id = 'case-1'",
				)
				.run(),
		).toThrow(/immutable/);
		await expect(
			addGraphRetrievalBenchmarkCase(db, {
				id: "case-2",
				organizationId: "org-1",
				suiteId: "suite-1",
				expectedSuiteRevision: 1,
				caseKey: "late-case",
				query: "late",
				expectedFactIds: ["fact-a"],
				validAt: T1,
				checksum: "case-checksum-2",
				createdAt: T2,
			}),
		).rejects.toMatchObject<Partial<GraphRetrievalBenchmarkError>>({
			reason: "case_conflict",
		});
		expect(() =>
			sqlite
				.prepare(
					"UPDATE graph_retrieval_benchmark_suites SET name = 'rewritten' WHERE id = 'suite-1'",
				)
				.run(),
		).toThrow(/definition is immutable/);
	});

	it("rolls back pair creation when either variant conflicts", async () => {
		const { db, sqlite } = fixture();
		await seedLockedSuite(db);
		const common = {
			organizationId: "org-1",
			suiteId: "suite-1",
			suiteChecksum: "suite-checksum-1",
			pairedRunKey: "pair-atomic-conflict",
			retrievalPolicyVersion: "policy-1",
			harnessVersionId: "harness-1",
			modelProvider: "none",
			modelId: "retrieval",
			modelVersion: "1",
			projectionSnapshot: projection,
			seed: 1,
			startedAt: T1,
		};
		await startGraphRetrievalBenchmarkRun(db, {
			...common,
			id: "existing-baseline",
			variant: "baseline",
		});
		await expect(
			startGraphRetrievalBenchmarkRunPair(db, {
				baseline: {
					...common,
					id: "conflicting-baseline",
					variant: "baseline",
				},
				graph: {
					...common,
					id: "rolled-back-graph",
					variant: "graph",
				},
			}),
		).rejects.toMatchObject<Partial<GraphRetrievalBenchmarkError>>({
			reason: "run_conflict",
		});
		expect(
			sqlite
				.prepare(
					"SELECT id, variant FROM graph_retrieval_benchmark_runs WHERE paired_run_key = ? ORDER BY variant",
				)
				.all("pair-atomic-conflict"),
		).toEqual([{ id: "existing-baseline", variant: "baseline" }]);
	});

	it("keeps otherwise passing manually completed gold runs ineligible", async () => {
		const { db, sqlite } = fixture();
		await seedLockedSuite(db);
		const common = {
			organizationId: "org-1",
			suiteId: "suite-1",
			suiteChecksum: "suite-checksum-1",
			pairedRunKey: "pair-1",
			retrievalPolicyVersion: "policy-1",
			harnessVersionId: "harness-1",
			modelProvider: "openai",
			modelId: "gpt-test",
			modelVersion: "2026-07",
			projectionSnapshot: projection,
			seed: 42,
			startedAt: T1,
		};
		await startGraphRetrievalBenchmarkRun(db, {
			...common,
			id: "run-baseline",
			variant: "baseline",
		});
		await startGraphRetrievalBenchmarkRun(db, {
			...common,
			id: "run-graph",
			variant: "graph",
		});

		const baselineScore = scoreGraphRetrievalCase({
			expectation: {
				organizationId: "org-1",
				validAt: T1,
				expectedFactIds: ["fact-a", "fact-b"],
				expectedEdges: [expectedEdge],
				expectedPaths: [expectedPath],
				forbiddenFactIds: ["fact-stale"],
			},
			observation: {
				retrievedFactIds: ["fact-a"],
				returnedEdges: [],
				returnedPaths: [],
				citedFactIds: ["fact-a"],
				claimSupport: [],
				answerScore: 0.65,
				inputTokens: 100,
				outputTokens: 20,
				latencyMs: 100,
				costUsd: 0.01,
			},
			canonicalFacts,
			canonicalEdges,
		});
		const graphScore = scoreGraphRetrievalCase({
			expectation: {
				organizationId: "org-1",
				validAt: T1,
				expectedFactIds: ["fact-a", "fact-b"],
				expectedEdges: [expectedEdge],
				expectedPaths: [expectedPath],
				forbiddenFactIds: ["fact-stale"],
			},
			observation: {
				retrievedFactIds: ["fact-a", "fact-b"],
				returnedEdges: [expectedEdge],
				returnedPaths: [expectedPath],
				citedFactIds: ["fact-a", "fact-b"],
				claimSupport: [{ claimId: "answer-claim", citedFactIds: ["fact-b"] }],
				answerScore: 0.9,
				inputTokens: 105,
				outputTokens: 25,
				latencyMs: 110,
				costUsd: 0.011,
			},
			canonicalFacts,
			canonicalEdges,
		});
		const record = async (
			id: string,
			runId: string,
			score: typeof baselineScore,
			resources: {
				retrievedFactIds: string[];
				returnedEdges: (typeof expectedEdge)[];
				returnedPaths: (typeof expectedPath)[];
				citedFactIds: string[];
				claimSupport: Array<{ claimId: string; citedFactIds: string[] }>;
				inputTokens: number;
				outputTokens: number;
				latencyMs: number;
				costUsd: number;
			},
		) =>
			recordGraphRetrievalBenchmarkResult(db, {
				id,
				organizationId: "org-1",
				runId,
				caseId: "case-1",
				origin: "manual",
				...resources,
				metrics: score.metrics,
				passed: score.passed,
				failureReasons: score.failureReasons,
				createdAt: T2,
			});
		await record("result-baseline", "run-baseline", baselineScore, {
			retrievedFactIds: ["fact-a"],
			returnedEdges: [],
			returnedPaths: [],
			citedFactIds: ["fact-a"],
			claimSupport: [],
			inputTokens: 100,
			outputTokens: 20,
			latencyMs: 100,
			costUsd: 0.01,
		});
		await record("result-graph", "run-graph", graphScore, {
			retrievedFactIds: ["fact-a", "fact-b"],
			returnedEdges: [expectedEdge],
			returnedPaths: [expectedPath],
			citedFactIds: ["fact-a", "fact-b"],
			claimSupport: [{ claimId: "answer-claim", citedFactIds: ["fact-b"] }],
			inputTokens: 105,
			outputTokens: 25,
			latencyMs: 110,
			costUsd: 0.011,
		});
		await completeGraphRetrievalBenchmarkRun(db, {
			organizationId: "org-1",
			runId: "run-baseline",
			completedAt: T3,
		});
		await completeGraphRetrievalBenchmarkRun(db, {
			organizationId: "org-1",
			runId: "run-graph",
			completedAt: T3,
		});

		const evaluation = await evaluateStoredGraphRetrievalGraduation(db, {
			organizationId: "org-1",
			pairedRunKey: "pair-1",
			currentProjection: projection,
			policy: {
				minPairedCases: 1,
				minAnswerScoreLift: 0.2,
				minExpectedPathCoverageLift: 0.5,
				maxP95LatencyRatio: 1.2,
				maxMeanTokenRatio: 1.1,
				maxMeanCostRatio: 1.2,
			},
		});
		expect(evaluation.result.passed).toBe(false);
		expect(evaluation.baselineRun.eligible).toBe(false);
		expect(evaluation.graphRun.eligible).toBe(false);
		expect(evaluation.result.gates).toMatchObject({
			pair_baselineEligible: { passed: false, actual: false },
			pair_graphEligible: { passed: false, actual: false },
		});
		expect(evaluation.result.pairedMetrics).toMatchObject({
			pairedCaseCount: 1,
			answerScoreLift: 0.25,
			expectedPathCoverageLift: 1,
		});
		await recordGraphRetrievalGraduationEvaluation(db, {
			id: "graduation-1",
			organizationId: "org-1",
			suiteId: "suite-1",
			baselineRunId: "run-baseline",
			graphRunId: "run-graph",
			evaluatorVersion: "graph-grounding-v1",
			result: evaluation.result,
			projectionSnapshot: projection,
			evaluatedAt: T3,
		});
		expect(() =>
			sqlite
				.prepare(
					"UPDATE graph_retrieval_graduation_evaluations SET passed = 0 WHERE id = 'graduation-1'",
				)
				.run(),
		).toThrow(/immutable/);
	});

	it("rejects a manual result that pre-seeds a built-in deterministic result id", async () => {
		const { db, sqlite } = fixture();
		await seedLockedSuite(db);
		const common = {
			organizationId: "org-1",
			suiteId: "suite-1",
			suiteChecksum: "suite-checksum-1",
			pairedRunKey: "pair-preseed",
			retrievalPolicyVersion: "anchor-vs-projected-path-expansion-v1",
			harnessVersionId: "builtin:1",
			modelProvider: "none",
			modelId: "deterministic-retrieval-only",
			modelVersion: "1",
			projectionSnapshot: projection,
			seed: 0,
			startedAt: T1,
		};
		const pair = await startGraphRetrievalBenchmarkRunPair(db, {
			baseline: {
				...common,
				id: "preseed-baseline",
				variant: "baseline",
			},
			graph: {
				...common,
				id: "preseed-graph",
				variant: "graph",
			},
		});
		const preseededId = "public-deterministic-result-id";
		await recordGraphRetrievalBenchmarkResult(db, {
			id: preseededId,
			organizationId: "org-1",
			runId: pair.baselineRun.id,
			caseId: "case-1",
			origin: "manual",
			retrievedFactIds: ["fact-a"],
			metrics: anchorOnlyRetrievalMetrics,
			inputTokens: 0,
			outputTokens: 0,
			latencyMs: 10,
			costUsd: 0,
			passed: false,
			failureReasons: ["manual preseed"],
			createdAt: T2,
		});
		expect(() =>
			sqlite
				.prepare(
					"UPDATE graph_retrieval_benchmark_results SET origin = 'builtin' WHERE id = ?",
				)
				.run(preseededId),
		).toThrow(/immutable/);
		await expect(
			recordGraphRetrievalBenchmarkResult(db, {
				id: preseededId,
				organizationId: "org-1",
				runId: pair.baselineRun.id,
				caseId: "case-1",
				origin: "builtin",
				retrievedFactIds: ["fact-a"],
				metrics: anchorOnlyRetrievalMetrics,
				inputTokens: 0,
				outputTokens: 0,
				latencyMs: 10,
				costUsd: 0,
				passed: false,
				failureReasons: ["baseline control"],
				createdAt: T2,
			}),
		).rejects.toMatchObject<Partial<GraphRetrievalBenchmarkError>>({
			reason: "case_conflict",
		});
		await recordGraphRetrievalBenchmarkResult(db, {
			id: "builtin-graph-result",
			organizationId: "org-1",
			runId: pair.graphRun.id,
			caseId: "case-1",
			origin: "builtin",
			retrievedFactIds: ["fact-a", "fact-b"],
			returnedEdges: [expectedEdge],
			returnedPaths: [expectedPath],
			metrics: perfectRetrievalMetrics,
			inputTokens: 0,
			outputTokens: 0,
			latencyMs: 12,
			costUsd: 0,
			passed: true,
			failureReasons: [],
			createdAt: T2,
		});
		await expect(
			completeEligibleGraphRetrievalBenchmarkRunPair(db, {
				organizationId: "org-1",
				pairedRunKey: "pair-preseed",
				baselineRunId: pair.baselineRun.id,
				graphRunId: pair.graphRun.id,
				completedAt: T3,
			}),
		).rejects.toMatchObject<Partial<GraphRetrievalBenchmarkError>>({
			reason: "run_conflict",
		});
	});

	it("atomically executes an idempotent perfect 20-case built-in retrieval pair as eligible", async () => {
		const { db, sqlite } = fixture();
		await seedLockedSuite(db, 20);
		const harnessIdentity = {
			retrievalPolicyVersion: "anchor-vs-projected-path-expansion-v1",
			harnessVersionId: "builtin:1",
			modelProvider: "none",
			modelId: "deterministic-retrieval-only",
			modelVersion: "1",
		};
		const common = {
			organizationId: "org-1",
			suiteId: "suite-1",
			suiteChecksum: "suite-checksum-1",
			pairedRunKey: "pair-builtin",
			...harnessIdentity,
			projectionSnapshot: projection,
			seed: 0,
			startedAt: T1,
		};
		const startInput = {
			baseline: {
				...common,
				id: "run-builtin-baseline",
				variant: "baseline" as const,
			},
			graph: {
				...common,
				id: "run-builtin-graph",
				variant: "graph" as const,
			},
		};
		const started = await startGraphRetrievalBenchmarkRunPair(db, startInput);
		const replayedStart = await startGraphRetrievalBenchmarkRunPair(db, {
			baseline: {
				...startInput.baseline,
				projectionSnapshot: { ...projection, certifiedAt: T2 },
				startedAt: T2,
			},
			graph: {
				...startInput.graph,
				projectionSnapshot: { ...projection, certifiedAt: T2 },
				startedAt: T2,
			},
		});
		expect(replayedStart).toMatchObject({
			baselineRun: { id: started.baselineRun.id, eligible: false },
			graphRun: { id: started.graphRun.id, eligible: false },
		});
		expect(
			sqlite
				.prepare(
					"SELECT COUNT(*) AS count FROM graph_retrieval_benchmark_runs WHERE paired_run_key = ?",
				)
				.get("pair-builtin"),
		).toEqual({ count: 2 });

		for (let index = 1; index <= 20; index++) {
			await recordGraphRetrievalBenchmarkResult(db, {
				id: `baseline-result-${index}`,
				organizationId: "org-1",
				runId: started.baselineRun.id,
				caseId: `case-${index}`,
				origin: "builtin",
				retrievedFactIds: ["fact-a"],
				returnedEdges: [],
				returnedPaths: [],
				citedFactIds: [],
				claimSupport: [],
				metrics: anchorOnlyRetrievalMetrics,
				inputTokens: 0,
				outputTokens: 0,
				latencyMs: 10,
				costUsd: 0,
				passed: false,
				failureReasons: ["baseline anchor-only control"],
				createdAt: T2,
			});
			await recordGraphRetrievalBenchmarkResult(db, {
				id: `graph-result-${index}`,
				organizationId: "org-1",
				runId: started.graphRun.id,
				caseId: `case-${index}`,
				origin: "builtin",
				retrievedFactIds: ["fact-a", "fact-b"],
				returnedEdges: [expectedEdge],
				returnedPaths: [expectedPath],
				citedFactIds: [],
				claimSupport: [],
				metrics: perfectRetrievalMetrics,
				inputTokens: 0,
				outputTokens: 0,
				latencyMs: 12,
				costUsd: 0,
				passed: true,
				failureReasons: [],
				createdAt: T2,
			});
		}
		const completionInput = {
			organizationId: "org-1",
			pairedRunKey: "pair-builtin",
			baselineRunId: started.baselineRun.id,
			graphRunId: started.graphRun.id,
			completedAt: T3,
		};
		const completed = await completeEligibleGraphRetrievalBenchmarkRunPair(
			db,
			completionInput,
		);
		const replayedCompletion =
			await completeEligibleGraphRetrievalBenchmarkRunPair(db, completionInput);
		expect(completed).toMatchObject({
			baselineRun: {
				status: "completed",
				eligible: true,
				caseCount: 20,
			},
			graphRun: {
				status: "completed",
				eligible: true,
				caseCount: 20,
			},
		});
		expect(replayedCompletion).toEqual(completed);

		const evaluation = await evaluateStoredGraphRetrievalGraduation(db, {
			organizationId: "org-1",
			pairedRunKey: "pair-builtin",
			mode: "retrieval_only",
			currentProjection: projection,
		});
		expect(evaluation.result.passed).toBe(true);
		expect(evaluation.result.gates).toMatchObject({
			graduation_mode: {
				passed: true,
				actual: "retrieval_only",
			},
			pair_baselineEligible: { passed: true, actual: true },
			pair_graphEligible: { passed: true, actual: true },
			projection_snapshot_current: { passed: true },
			retrieval_latency_basis: {
				actual: "measured_baseline_ratio",
			},
		});
		expect(evaluation.result.gates.answer_score_lift).toBeUndefined();
		expect(evaluation.result.gates.mean_token_budget).toBeUndefined();
		expect(evaluation.result.gates.mean_cost_budget).toBeUndefined();
	});
});

describe("fail-closed graph graduation", () => {
	it("fails when projection or paired metrics are absent", () => {
		const result = evaluateGraphRetrievalGraduation({
			suite: { status: "locked", split: "locked_test", caseCount: 20 },
			pairIntegrity: {
				sameSuiteChecksum: true,
				sameModel: true,
				sameRetrievalPolicy: true,
				sameSeed: true,
				baselineCompleted: true,
				graphCompleted: true,
				baselineEligible: true,
				graphEligible: true,
				sameProjectionSnapshot: false,
				noMissingCases: true,
			},
			projection: null,
			currentProjection: null,
			baseline: null,
			graph: null,
			paired: null,
		});
		expect(result.passed).toBe(false);
		expect(result.gates.projection_passes_gate).toMatchObject({
			passed: false,
			actual: null,
		});
		expect(result.gates.finite_complete_metrics?.passed).toBe(false);
	});

	it("fails non-finite economics rather than serializing an accidental green", () => {
		const aggregate: GraphBenchmarkCaseMetrics = {
			factRecall: 1,
			factPrecision: 1,
			edgeRecall: 1,
			edgePrecision: 1,
			pathValidity: 1,
			expectedPathCoverage: 1,
			temporalAccuracy: 1,
			forbiddenFactRate: 0,
			citationRecall: 1,
			citationPrecision: 1,
			unsupportedInferenceRate: 0,
			answerScore: 1,
		};
		const full = {
			...aggregate,
			caseCount: 20,
			passedCaseCount: 20,
			p95LatencyMs: 0,
			meanLatencyMs: 0,
			meanInputTokens: 0,
			meanOutputTokens: 0,
			meanCostUsd: 0,
		};
		const result = evaluateGraphRetrievalGraduation({
			suite: { status: "locked", split: "locked_test", caseCount: 20 },
			pairIntegrity: {
				sameSuiteChecksum: true,
				sameModel: true,
				sameRetrievalPolicy: true,
				sameSeed: true,
				baselineCompleted: true,
				graphCompleted: true,
				baselineEligible: true,
				graphEligible: true,
				sameProjectionSnapshot: true,
				noMissingCases: true,
			},
			projection,
			currentProjection: projection,
			baseline: full,
			graph: { ...full, meanCostUsd: Number.NaN },
			paired: {
				pairedCaseCount: 20,
				answerScoreLift: 0.1,
				factRecallLift: 0,
				factPrecisionLift: 0,
				edgeRecallLift: 0,
				pathValidityLift: 0,
				expectedPathCoverageLift: 0,
				temporalAccuracyLift: 0,
				unsupportedInferenceRateDelta: 0,
				forbiddenFactRateDelta: 0,
				p95LatencyMsDelta: 0,
				meanTokenDelta: 0,
				meanCostUsdDelta: Number.NaN,
			},
		});
		expect(result.passed).toBe(false);
		expect(result.gates.finite_complete_metrics?.passed).toBe(false);
		expect(result.gates.mean_cost_budget?.passed).toBe(false);
	});

	it("fails retrieval-only graduation when strict graph evidence degrades", () => {
		const baseline = perfectRetrievalAggregate({
			p95LatencyMs: 10,
			meanLatencyMs: 10,
		});
		const graph = perfectRetrievalAggregate({
			factPrecision: 0.99,
			edgePrecision: 0.99,
			pathValidity: 0.99,
			expectedPathCoverage: 0.99,
			temporalAccuracy: 0.99,
		});
		const result = evaluateGraphRetrievalGraduation({
			suite: { status: "locked", split: "locked_test", caseCount: 20 },
			pairIntegrity: eligiblePairIntegrity,
			projection,
			currentProjection: projection,
			baseline,
			graph,
			paired: {
				...perfectPairedMetrics(),
				factPrecisionLift: -0.01,
				pathValidityLift: -0.01,
				expectedPathCoverageLift: -0.01,
				temporalAccuracyLift: -0.01,
			},
			mode: "retrieval_only",
		});
		expect(result.passed).toBe(false);
		expect(result.gates).toMatchObject({
			graph_fact_precision: { passed: false },
			graph_edge_precision: { passed: false },
			graph_path_validity: { passed: false },
			graph_expected_path_coverage: { passed: false },
			graph_temporal_accuracy: { passed: false },
		});
	});

	it("fails retrieval-only graduation when any graph case failed scoring", () => {
		const result = evaluateGraphRetrievalGraduation({
			suite: { status: "locked", split: "locked_test", caseCount: 20 },
			pairIntegrity: eligiblePairIntegrity,
			projection,
			currentProjection: projection,
			baseline: perfectRetrievalAggregate({
				p95LatencyMs: 10,
				meanLatencyMs: 10,
			}),
			graph: perfectRetrievalAggregate({ passedCaseCount: 19 }),
			paired: perfectPairedMetrics(),
			mode: "retrieval_only",
		});
		expect(result.passed).toBe(false);
		expect(result.gates.graph_all_cases_passed).toMatchObject({
			passed: false,
			actual: "19/20",
			required: "20/20",
		});
	});

	it("fails when the current certified projection watermark or epoch drifts", () => {
		const result = evaluateGraphRetrievalGraduation({
			suite: { status: "locked", split: "locked_test", caseCount: 20 },
			pairIntegrity: eligiblePairIntegrity,
			projection,
			currentProjection: {
				...projection,
				projectionEpoch: "d1:43",
				persistedWatermark: 43,
			},
			baseline: perfectRetrievalAggregate({
				p95LatencyMs: 10,
				meanLatencyMs: 10,
			}),
			graph: perfectRetrievalAggregate(),
			paired: perfectPairedMetrics(),
			mode: "retrieval_only",
		});
		expect(result.passed).toBe(false);
		expect(result.gates.projection_snapshot_current).toMatchObject({
			passed: false,
			actual: "d1:43@43",
			required: "d1:42@42",
		});
	});
});
