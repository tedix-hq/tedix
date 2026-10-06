/**
 * Locked, auditable graph-retrieval benchmark ledger.
 *
 * Suites and cases are canonical D1 rows. Large trace bundles remain in R2 and
 * are referenced by URI. Baseline and graph variants share a paired run key so
 * graduation compares like-for-like executions rather than unrelated means.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	real,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

export interface GraphBenchmarkEdge {
	sourceFactId: string;
	targetFactId: string;
	relationType: string;
}

export interface GraphBenchmarkPath {
	factIds: string[];
	edges: GraphBenchmarkEdge[];
}

export interface GraphBenchmarkClaimSupport {
	claimId: string;
	citedFactIds: string[];
}

export interface GraphBenchmarkProjectionSnapshot {
	configured: boolean;
	healthy: boolean;
	passesGate: boolean;
	state?: string;
	projectionEpoch?: string | null;
	persistedWatermark?: number;
	gdsWatermark?: number;
	gdsEpoch?: string | null;
	nodeMismatchCount?: number | null;
	edgeMismatchCount?: number | null;
	lifecycleMismatchCount?: number | null;
	entityCoverage?: number | null;
	edgeCoverage?: number | null;
	certifiedAt?: string | null;
}

export const ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_IDENTITY = {
	retrievalPolicyVersion: "anchor-vs-projected-path-expansion-v1",
	harnessVersionId: "builtin:1",
	modelProvider: "none",
	modelId: "deterministic-retrieval-only",
	modelVersion: "1",
} as const;
export const ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_SEED = 0;

export interface GraphBenchmarkCaseMetrics {
	factRecall: number;
	factPrecision: number;
	edgeRecall: number;
	edgePrecision: number;
	pathValidity: number;
	expectedPathCoverage: number;
	temporalAccuracy: number;
	forbiddenFactRate: number;
	citationRecall: number;
	citationPrecision: number;
	unsupportedInferenceRate: number;
	answerScore: number;
}

export interface GraphBenchmarkAggregateMetrics extends GraphBenchmarkCaseMetrics {
	caseCount: number;
	passedCaseCount: number;
	p95LatencyMs: number;
	meanLatencyMs: number;
	meanInputTokens: number;
	meanOutputTokens: number;
	meanCostUsd: number;
}

export interface GraphBenchmarkGraduationGates {
	[key: string]: {
		passed: boolean;
		actual: number | string | boolean | null;
		required: number | string | boolean;
	};
}

export const graphRetrievalBenchmarkSuites = sqliteTable(
	"graph_retrieval_benchmark_suites",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		version: integer("version").notNull(),
		status: text("status", { enum: ["draft", "locked", "retired"] })
			.notNull()
			.default("draft"),
		split: text("split", {
			enum: ["validation", "locked_test", "canary"],
		}).notNull(),
		revision: integer("revision").notNull().default(0),
		caseCount: integer("case_count").notNull().default(0),
		definitionChecksum: text("definition_checksum"),
		sourceCommit: text("source_commit"),
		artifactUri: text("artifact_uri"),
		createdByType: text("created_by_type", {
			enum: ["user", "tedi", "service", "api_key", "external_agent", "system"],
		}).notNull(),
		createdById: text("created_by_id").notNull(),
		lockedAt: text("locked_at"),
		retiredAt: text("retired_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_graph_benchmark_suite_version").on(
			table.organizationId,
			table.name,
			table.version,
		),
		uniqueIndex("uniq_graph_benchmark_suite_org_id").on(
			table.organizationId,
			table.id,
		),
		index("idx_graph_benchmark_suite_status").on(
			table.organizationId,
			table.status,
			table.split,
		),
		check(
			"chk_graph_benchmark_suite_version",
			sql`${table.version} > 0 AND ${table.revision} >= 0 AND ${table.caseCount} >= 0`,
		),
		check(
			"chk_graph_benchmark_suite_lifecycle",
			sql`(${table.status} = 'draft' AND ${table.lockedAt} IS NULL AND ${table.retiredAt} IS NULL AND ${table.definitionChecksum} IS NULL) OR (${table.status} = 'locked' AND ${table.lockedAt} IS NOT NULL AND ${table.retiredAt} IS NULL AND length(${table.definitionChecksum}) > 0) OR (${table.status} = 'retired' AND ${table.lockedAt} IS NOT NULL AND ${table.retiredAt} IS NOT NULL AND length(${table.definitionChecksum}) > 0)`,
		),
	],
);

/**
 * Cases are immutable from insertion, even while the suite is draft. A
 * correction is a new case/suite version, preserving ground-truth history.
 * `suiteRevision` is the CAS version observed at insertion.
 */
export const graphRetrievalBenchmarkCases = sqliteTable(
	"graph_retrieval_benchmark_cases",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		suiteId: text("suite_id")
			.notNull()
			.references(() => graphRetrievalBenchmarkSuites.id, {
				onDelete: "restrict",
			}),
		suiteRevision: integer("suite_revision").notNull(),
		caseKey: text("case_key").notNull(),
		query: text("query").notNull(),
		anchorFactIds: text("anchor_fact_ids", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		expectedFactIds: text("expected_fact_ids", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		expectedEdges: text("expected_edges", { mode: "json" })
			.$type<GraphBenchmarkEdge[]>()
			.notNull()
			.default([]),
		expectedPaths: text("expected_paths", { mode: "json" })
			.$type<GraphBenchmarkPath[]>()
			.notNull()
			.default([]),
		forbiddenFactIds: text("forbidden_fact_ids", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		validAt: text("valid_at").notNull(),
		answerRubric: text("answer_rubric", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		artifactUri: text("artifact_uri"),
		tags: text("tags", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		difficulty: text("difficulty", {
			enum: ["basic", "intermediate", "advanced", "adversarial"],
		})
			.notNull()
			.default("intermediate"),
		checksum: text("checksum").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_graph_benchmark_case_key").on(
			table.suiteId,
			table.caseKey,
		),
		uniqueIndex("uniq_graph_benchmark_case_checksum").on(
			table.suiteId,
			table.checksum,
		),
		index("idx_graph_benchmark_case_suite").on(
			table.organizationId,
			table.suiteId,
			table.caseKey,
		),
		check(
			"chk_graph_benchmark_case_shape",
			sql`length(trim(${table.query})) > 0 AND length(${table.checksum}) > 0 AND ${table.suiteRevision} >= 0`,
		),
		check(
			"chk_graph_benchmark_case_expected",
			sql`json_array_length(${table.expectedFactIds}) > 0 OR json_array_length(${table.expectedEdges}) > 0 OR json_array_length(${table.expectedPaths}) > 0`,
		),
	],
);

export const graphRetrievalBenchmarkRuns = sqliteTable(
	"graph_retrieval_benchmark_runs",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		suiteId: text("suite_id")
			.notNull()
			.references(() => graphRetrievalBenchmarkSuites.id, {
				onDelete: "restrict",
			}),
		suiteChecksum: text("suite_checksum").notNull(),
		pairedRunKey: text("paired_run_key").notNull(),
		variant: text("variant", { enum: ["baseline", "graph"] }).notNull(),
		retrievalPolicyVersion: text("retrieval_policy_version").notNull(),
		harnessVersionId: text("harness_version_id"),
		modelProvider: text("model_provider").notNull(),
		modelId: text("model_id").notNull(),
		modelVersion: text("model_version").notNull(),
		projectionSnapshot: text("projection_snapshot", { mode: "json" })
			.$type<GraphBenchmarkProjectionSnapshot>()
			.notNull(),
		seed: integer("seed").notNull(),
		status: text("status", {
			enum: ["running", "completed", "failed"],
		})
			.notNull()
			.default("running"),
		caseCount: integer("case_count").notNull().default(0),
		aggregateMetrics: text("aggregate_metrics", {
			mode: "json",
		}).$type<GraphBenchmarkAggregateMetrics>(),
		totalInputTokens: integer("total_input_tokens").notNull().default(0),
		totalOutputTokens: integer("total_output_tokens").notNull().default(0),
		totalLatencyMs: integer("total_latency_ms").notNull().default(0),
		totalCostUsd: real("total_cost_usd").notNull().default(0),
		eligible: integer("eligible", { mode: "boolean" }).notNull().default(false),
		traceArtifactUri: text("trace_artifact_uri"),
		failureReason: text("failure_reason"),
		startedAt: text("started_at").notNull(),
		completedAt: text("completed_at"),
	},
	(table) => [
		uniqueIndex("uniq_graph_benchmark_run_pair_variant").on(
			table.organizationId,
			table.pairedRunKey,
			table.variant,
		),
		uniqueIndex("uniq_graph_benchmark_run_org_id").on(
			table.organizationId,
			table.id,
		),
		index("idx_graph_benchmark_run_suite").on(
			table.organizationId,
			table.suiteId,
			table.status,
			table.startedAt,
		),
		check(
			"chk_graph_benchmark_run_totals",
			sql`${table.caseCount} >= 0 AND ${table.totalInputTokens} >= 0 AND ${table.totalOutputTokens} >= 0 AND ${table.totalLatencyMs} >= 0 AND ${table.totalCostUsd} >= 0`,
		),
		check(
			"chk_graph_benchmark_run_lifecycle",
			sql`(${table.status} = 'running' AND ${table.completedAt} IS NULL AND ${table.aggregateMetrics} IS NULL) OR (${table.status} = 'completed' AND ${table.completedAt} IS NOT NULL AND ${table.aggregateMetrics} IS NOT NULL AND ${table.failureReason} IS NULL) OR (${table.status} = 'failed' AND ${table.completedAt} IS NOT NULL AND ${table.failureReason} IS NOT NULL)`,
		),
	],
);

export const graphRetrievalBenchmarkResults = sqliteTable(
	"graph_retrieval_benchmark_results",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		runId: text("run_id")
			.notNull()
			.references(() => graphRetrievalBenchmarkRuns.id, {
				onDelete: "restrict",
			}),
		caseId: text("case_id")
			.notNull()
			.references(() => graphRetrievalBenchmarkCases.id, {
				onDelete: "restrict",
			}),
		origin: text("origin", { enum: ["manual", "builtin"] })
			.notNull()
			.default("manual"),
		retrievedFactIds: text("retrieved_fact_ids", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		returnedEdges: text("returned_edges", { mode: "json" })
			.$type<GraphBenchmarkEdge[]>()
			.notNull()
			.default([]),
		returnedPaths: text("returned_paths", { mode: "json" })
			.$type<GraphBenchmarkPath[]>()
			.notNull()
			.default([]),
		answer: text("answer"),
		citedFactIds: text("cited_fact_ids", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		claimSupport: text("claim_support", { mode: "json" })
			.$type<GraphBenchmarkClaimSupport[]>()
			.notNull()
			.default([]),
		metrics: text("metrics", { mode: "json" })
			.$type<GraphBenchmarkCaseMetrics>()
			.notNull(),
		inputTokens: integer("input_tokens").notNull(),
		outputTokens: integer("output_tokens").notNull(),
		latencyMs: integer("latency_ms").notNull(),
		costUsd: real("cost_usd").notNull(),
		passed: integer("passed", { mode: "boolean" }).notNull(),
		failureReasons: text("failure_reasons", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default([]),
		traceArtifactUri: text("trace_artifact_uri"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_graph_benchmark_result_case").on(
			table.runId,
			table.caseId,
		),
		index("idx_graph_benchmark_result_run").on(
			table.organizationId,
			table.runId,
		),
		check(
			"chk_graph_benchmark_result_cost",
			sql`${table.inputTokens} >= 0 AND ${table.outputTokens} >= 0 AND ${table.latencyMs} >= 0 AND ${table.costUsd} >= 0`,
		),
	],
);

/** Append-only certification evidence for a paired run. */
export const graphRetrievalGraduationEvaluations = sqliteTable(
	"graph_retrieval_graduation_evaluations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		suiteId: text("suite_id")
			.notNull()
			.references(() => graphRetrievalBenchmarkSuites.id, {
				onDelete: "restrict",
			}),
		baselineRunId: text("baseline_run_id")
			.notNull()
			.references(() => graphRetrievalBenchmarkRuns.id, {
				onDelete: "restrict",
			}),
		graphRunId: text("graph_run_id")
			.notNull()
			.references(() => graphRetrievalBenchmarkRuns.id, {
				onDelete: "restrict",
			}),
		evaluatorVersion: text("evaluator_version").notNull(),
		passed: integer("passed", { mode: "boolean" }).notNull(),
		gates: text("gates", { mode: "json" })
			.$type<GraphBenchmarkGraduationGates>()
			.notNull(),
		pairedMetrics: text("paired_metrics", { mode: "json" })
			.$type<Record<string, number>>()
			.notNull(),
		projectionSnapshot: text("projection_snapshot", { mode: "json" })
			.$type<GraphBenchmarkProjectionSnapshot>()
			.notNull(),
		reasons: text("reasons", { mode: "json" }).$type<string[]>().notNull(),
		evaluatedAt: text("evaluated_at").notNull(),
	},
	(table) => [
		uniqueIndex("uniq_graph_benchmark_graduation_pair").on(
			table.baselineRunId,
			table.graphRunId,
			table.evaluatorVersion,
		),
		index("idx_graph_benchmark_graduation_suite").on(
			table.organizationId,
			table.suiteId,
			table.evaluatedAt,
		),
		check(
			"chk_graph_benchmark_graduation_distinct_runs",
			sql`${table.baselineRunId} != ${table.graphRunId}`,
		),
	],
);

/**
 * Required migration triggers. They make case/result/evaluation immutability
 * and suite revision fencing database facts, not caller conventions.
 */
export const GRAPH_RETRIEVAL_BENCHMARK_TRIGGER_SQL = [
	`CREATE TRIGGER graph_benchmark_case_insert_guard
		BEFORE INSERT ON graph_retrieval_benchmark_cases
		WHEN NOT EXISTS (
			SELECT 1
			FROM graph_retrieval_benchmark_suites s
			WHERE s.id = NEW.suite_id
			  AND s.organization_id = NEW.organization_id
			  AND s.status = 'draft'
			  AND s.revision = NEW.suite_revision
		)
		BEGIN
			SELECT RAISE(ABORT, 'benchmark suite is not an editable draft at the expected revision');
		END`,
	`CREATE TRIGGER graph_benchmark_case_revision_advance
		AFTER INSERT ON graph_retrieval_benchmark_cases
		BEGIN
			UPDATE graph_retrieval_benchmark_suites
			SET revision = revision + 1,
				case_count = case_count + 1,
				updated_at = NEW.created_at
			WHERE id = NEW.suite_id
			  AND organization_id = NEW.organization_id
			  AND status = 'draft'
			  AND revision = NEW.suite_revision;
			SELECT RAISE(ABORT, 'benchmark suite revision CAS failed')
			WHERE changes() != 1;
		END`,
	`CREATE TRIGGER graph_benchmark_case_no_update
		BEFORE UPDATE ON graph_retrieval_benchmark_cases
		BEGIN
			SELECT RAISE(ABORT, 'benchmark cases are immutable');
		END`,
	`CREATE TRIGGER graph_benchmark_case_no_delete
		BEFORE DELETE ON graph_retrieval_benchmark_cases
		BEGIN
			SELECT RAISE(ABORT, 'benchmark cases are immutable');
		END`,
	`CREATE TRIGGER graph_benchmark_locked_suite_definition_guard
		BEFORE UPDATE ON graph_retrieval_benchmark_suites
		WHEN OLD.status IN ('locked', 'retired')
		 AND (
			NEW.organization_id != OLD.organization_id
			OR NEW.name != OLD.name
			OR NEW.version != OLD.version
			OR NEW.split != OLD.split
			OR NEW.revision != OLD.revision
			OR NEW.case_count != OLD.case_count
			OR NEW.definition_checksum != OLD.definition_checksum
			OR NEW.source_commit IS NOT OLD.source_commit
			OR NEW.artifact_uri IS NOT OLD.artifact_uri
			OR NEW.created_by_type != OLD.created_by_type
			OR NEW.created_by_id != OLD.created_by_id
			OR NEW.locked_at != OLD.locked_at
			OR (OLD.status = 'retired' AND NEW.status != 'retired')
			OR (OLD.status = 'locked' AND NEW.status NOT IN ('locked', 'retired'))
		 )
		BEGIN
			SELECT RAISE(ABORT, 'locked benchmark suite definition is immutable');
		END`,
	`CREATE TRIGGER graph_benchmark_locked_suite_no_delete
		BEFORE DELETE ON graph_retrieval_benchmark_suites
		WHEN OLD.status IN ('locked', 'retired')
		BEGIN
			SELECT RAISE(ABORT, 'locked benchmark suites are immutable');
		END`,
	`CREATE TRIGGER graph_benchmark_run_suite_guard
		BEFORE INSERT ON graph_retrieval_benchmark_runs
		WHEN NOT EXISTS (
			SELECT 1
			FROM graph_retrieval_benchmark_suites s
			WHERE s.id = NEW.suite_id
			  AND s.organization_id = NEW.organization_id
			  AND s.status = 'locked'
			  AND s.definition_checksum = NEW.suite_checksum
		)
		BEGIN
			SELECT RAISE(ABORT, 'benchmark run requires the exact locked suite');
		END`,
	`CREATE TRIGGER graph_benchmark_result_guard
		BEFORE INSERT ON graph_retrieval_benchmark_results
		WHEN NOT EXISTS (
			SELECT 1
			FROM graph_retrieval_benchmark_runs r
			JOIN graph_retrieval_benchmark_cases c
			  ON c.suite_id = r.suite_id
			 AND c.id = NEW.case_id
			 AND c.organization_id = r.organization_id
			WHERE r.id = NEW.run_id
			  AND r.organization_id = NEW.organization_id
			  AND r.status = 'running'
		)
		BEGIN
			SELECT RAISE(ABORT, 'benchmark result does not belong to a running suite case');
		END`,
	`CREATE TRIGGER graph_benchmark_result_no_update
		BEFORE UPDATE ON graph_retrieval_benchmark_results
		BEGIN
			SELECT RAISE(ABORT, 'benchmark results are immutable');
		END`,
	`CREATE TRIGGER graph_benchmark_result_no_delete
		BEFORE DELETE ON graph_retrieval_benchmark_results
		BEGIN
			SELECT RAISE(ABORT, 'benchmark results are immutable');
		END`,
	`CREATE TRIGGER graph_benchmark_graduation_no_update
		BEFORE UPDATE ON graph_retrieval_graduation_evaluations
		BEGIN
			SELECT RAISE(ABORT, 'graduation evaluations are immutable');
		END`,
	`CREATE TRIGGER graph_benchmark_graduation_no_delete
		BEFORE DELETE ON graph_retrieval_graduation_evaluations
		BEGIN
			SELECT RAISE(ABORT, 'graduation evaluations are immutable');
		END`,
] as const;

export type GraphRetrievalBenchmarkSuite =
	typeof graphRetrievalBenchmarkSuites.$inferSelect;
export type GraphRetrievalBenchmarkCase =
	typeof graphRetrievalBenchmarkCases.$inferSelect;
export type GraphRetrievalBenchmarkRun =
	typeof graphRetrievalBenchmarkRuns.$inferSelect;
export type GraphRetrievalBenchmarkResult =
	typeof graphRetrievalBenchmarkResults.$inferSelect;
export type GraphRetrievalGraduationEvaluation =
	typeof graphRetrievalGraduationEvaluations.$inferSelect;
