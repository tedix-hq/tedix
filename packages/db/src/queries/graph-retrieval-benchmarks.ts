import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_IDENTITY,
	ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_SEED,
	type GraphBenchmarkAggregateMetrics,
	type GraphBenchmarkCaseMetrics,
	type GraphBenchmarkClaimSupport,
	type GraphBenchmarkEdge,
	type GraphBenchmarkPath,
	type GraphBenchmarkProjectionSnapshot,
	type GraphRetrievalBenchmarkCase,
	type GraphRetrievalBenchmarkResult,
	type GraphRetrievalBenchmarkRun,
	type GraphRetrievalBenchmarkSuite,
	type GraphRetrievalGraduationEvaluation,
	graphRetrievalBenchmarkCases,
	graphRetrievalBenchmarkResults,
	graphRetrievalBenchmarkRuns,
	graphRetrievalBenchmarkSuites,
	graphRetrievalGraduationEvaluations,
} from "../schema/graph-retrieval-benchmarks";
import {
	aggregateGraphRetrievalCases,
	comparePairedGraphRetrievalCases,
	evaluateGraphRetrievalGraduation,
	type GraphRetrievalGraduationMode,
	type GraphRetrievalGraduationPolicy,
	type GraphRetrievalGraduationResult,
	matchesCertifiedGraphBenchmarkProjectionSnapshot,
	type PersistableScoredCase,
} from "./graph-retrieval-benchmark-scorer";

export type GraphRetrievalBenchmarkErrorReason =
	| "case_conflict"
	| "case_count_mismatch"
	| "graduation_conflict"
	| "incomplete_pair"
	| "run_conflict"
	| "run_not_found"
	| "suite_conflict"
	| "suite_not_found"
	| "suite_not_locked"
	| "suite_retired";

export class GraphRetrievalBenchmarkError extends Error {
	constructor(
		readonly reason: GraphRetrievalBenchmarkErrorReason,
		message: string,
	) {
		super(message);
		this.name = "GraphRetrievalBenchmarkError";
	}
}

export async function createGraphRetrievalBenchmarkSuite(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		name: string;
		version: number;
		split: "validation" | "locked_test" | "canary";
		sourceCommit?: string | null;
		artifactUri?: string | null;
		createdByType:
			| "user"
			| "tedi"
			| "service"
			| "api_key"
			| "external_agent"
			| "system";
		createdById: string;
		createdAt: string;
	},
): Promise<GraphRetrievalBenchmarkSuite> {
	const [created] = await db
		.insert(graphRetrievalBenchmarkSuites)
		.values({
			...input,
			sourceCommit: input.sourceCommit ?? null,
			artifactUri: input.artifactUri ?? null,
			status: "draft",
			revision: 0,
			caseCount: 0,
			createdAt: input.createdAt,
			updatedAt: input.createdAt,
		})
		.onConflictDoNothing()
		.returning();
	if (created) return created;

	const [existing] = await db
		.select()
		.from(graphRetrievalBenchmarkSuites)
		.where(
			and(
				eq(graphRetrievalBenchmarkSuites.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkSuites.name, input.name),
				eq(graphRetrievalBenchmarkSuites.version, input.version),
			),
		)
		.limit(1);
	if (
		existing?.id === input.id &&
		existing.split === input.split &&
		existing.createdByType === input.createdByType &&
		existing.createdById === input.createdById
	) {
		return existing;
	}
	throw new GraphRetrievalBenchmarkError(
		"suite_conflict",
		"Suite name/version already identifies a different definition",
	);
}

export async function getGraphRetrievalBenchmarkSuite(
	db: DbClient,
	input: { organizationId: string; suiteId: string },
): Promise<GraphRetrievalBenchmarkSuite | null> {
	const [row] = await db
		.select()
		.from(graphRetrievalBenchmarkSuites)
		.where(
			and(
				eq(graphRetrievalBenchmarkSuites.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkSuites.id, input.suiteId),
			),
		)
		.limit(1);
	return row ?? null;
}

/**
 * Inserts one immutable case. The migration trigger checks `suiteRevision` and
 * atomically increments the suite revision/case count after insertion.
 */
export async function addGraphRetrievalBenchmarkCase(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		suiteId: string;
		expectedSuiteRevision: number;
		caseKey: string;
		query: string;
		anchorFactIds?: string[];
		expectedFactIds: string[];
		expectedEdges?: GraphBenchmarkEdge[];
		expectedPaths?: GraphBenchmarkPath[];
		forbiddenFactIds?: string[];
		validAt: string;
		answerRubric?: Record<string, JsonValue>;
		artifactUri?: string | null;
		tags?: string[];
		difficulty?: "basic" | "intermediate" | "advanced" | "adversarial";
		checksum: string;
		createdAt: string;
	},
): Promise<GraphRetrievalBenchmarkCase> {
	try {
		const [created] = await db
			.insert(graphRetrievalBenchmarkCases)
			.values({
				id: input.id,
				organizationId: input.organizationId,
				suiteId: input.suiteId,
				suiteRevision: input.expectedSuiteRevision,
				caseKey: input.caseKey,
				query: input.query,
				anchorFactIds: input.anchorFactIds ?? [],
				expectedFactIds: input.expectedFactIds,
				expectedEdges: input.expectedEdges ?? [],
				expectedPaths: input.expectedPaths ?? [],
				forbiddenFactIds: input.forbiddenFactIds ?? [],
				validAt: input.validAt,
				answerRubric: input.answerRubric ?? {},
				artifactUri: input.artifactUri ?? null,
				tags: input.tags ?? [],
				difficulty: input.difficulty ?? "intermediate",
				checksum: input.checksum,
				createdAt: input.createdAt,
			})
			.returning();
		if (!created) throw new Error("Case insert returned no row");
		return created;
	} catch {
		const [existing] = await db
			.select()
			.from(graphRetrievalBenchmarkCases)
			.where(
				and(
					eq(graphRetrievalBenchmarkCases.suiteId, input.suiteId),
					eq(graphRetrievalBenchmarkCases.caseKey, input.caseKey),
				),
			)
			.limit(1);
		if (
			existing?.id === input.id &&
			existing.organizationId === input.organizationId &&
			existing.checksum === input.checksum
		) {
			return existing;
		}
		throw new GraphRetrievalBenchmarkError(
			"case_conflict",
			"Case is duplicate, suite is locked, or suite revision changed",
		);
	}
}

export async function listGraphRetrievalBenchmarkCases(
	db: DbClient,
	input: {
		organizationId: string;
		suiteId: string;
		limit?: number;
	},
): Promise<GraphRetrievalBenchmarkCase[]> {
	return db
		.select()
		.from(graphRetrievalBenchmarkCases)
		.where(
			and(
				eq(graphRetrievalBenchmarkCases.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkCases.suiteId, input.suiteId),
			),
		)
		.orderBy(graphRetrievalBenchmarkCases.caseKey)
		.limit(Math.max(1, Math.min(1000, Math.trunc(input.limit ?? 500))));
}

export function isEligiblePathGraphRetrievalBenchmarkCase(
	benchmarkCase: Pick<
		GraphRetrievalBenchmarkCase,
		"anchorFactIds" | "expectedPaths"
	>,
): boolean {
	return (
		benchmarkCase.anchorFactIds.length > 0 &&
		benchmarkCase.expectedPaths.some(
			(path) =>
				path.factIds.length >= 2 &&
				path.edges.length >= 1 &&
				path.edges.length === path.factIds.length - 1,
		)
	);
}

export async function lockGraphRetrievalBenchmarkSuite(
	db: DbClient,
	input: {
		organizationId: string;
		suiteId: string;
		expectedRevision: number;
		minimumCaseCount: number;
		definitionChecksum: string;
		lockedAt: string;
	},
): Promise<GraphRetrievalBenchmarkSuite> {
	const [suite] = await db
		.select()
		.from(graphRetrievalBenchmarkSuites)
		.where(
			and(
				eq(graphRetrievalBenchmarkSuites.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkSuites.id, input.suiteId),
			),
		)
		.limit(1);
	if (!suite) {
		throw new GraphRetrievalBenchmarkError(
			"suite_not_found",
			"Benchmark suite was not found",
		);
	}
	if (suite.status !== "draft") {
		if (
			suite.status === "locked" &&
			suite.definitionChecksum === input.definitionChecksum
		) {
			return suite;
		}
		throw new GraphRetrievalBenchmarkError(
			suite.status === "retired" ? "suite_retired" : "suite_conflict",
			`Benchmark suite is ${suite.status}`,
		);
	}
	const [actual] = await db
		.select({ value: count() })
		.from(graphRetrievalBenchmarkCases)
		.where(
			and(
				eq(graphRetrievalBenchmarkCases.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkCases.suiteId, input.suiteId),
			),
		);
	const actualCount = Number(actual?.value ?? 0);
	if (
		suite.revision !== input.expectedRevision ||
		suite.caseCount !== actualCount ||
		actualCount < Math.max(1, input.minimumCaseCount) ||
		input.definitionChecksum.trim().length === 0
	) {
		throw new GraphRetrievalBenchmarkError(
			"case_count_mismatch",
			"Suite revision/case count changed or minimum locked sample is not met",
		);
	}
	const [locked] = await db
		.update(graphRetrievalBenchmarkSuites)
		.set({
			status: "locked",
			definitionChecksum: input.definitionChecksum,
			lockedAt: input.lockedAt,
			updatedAt: input.lockedAt,
		})
		.where(
			and(
				eq(graphRetrievalBenchmarkSuites.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkSuites.id, input.suiteId),
				eq(graphRetrievalBenchmarkSuites.status, "draft"),
				eq(graphRetrievalBenchmarkSuites.revision, input.expectedRevision),
				eq(graphRetrievalBenchmarkSuites.caseCount, actualCount),
			),
		)
		.returning();
	if (!locked) {
		throw new GraphRetrievalBenchmarkError(
			"suite_conflict",
			"Suite was changed concurrently before lock",
		);
	}
	return locked;
}

export interface StartGraphRetrievalBenchmarkRunInput {
	id: string;
	organizationId: string;
	suiteId: string;
	suiteChecksum: string;
	pairedRunKey: string;
	variant: "baseline" | "graph";
	retrievalPolicyVersion: string;
	harnessVersionId?: string | null;
	modelProvider: string;
	modelId: string;
	modelVersion: string;
	projectionSnapshot: GraphBenchmarkProjectionSnapshot;
	seed: number;
	traceArtifactUri?: string | null;
	startedAt: string;
}

const projectionSnapshotFields: Array<keyof GraphBenchmarkProjectionSnapshot> =
	[
		"configured",
		"healthy",
		"passesGate",
		"state",
		"projectionEpoch",
		"persistedWatermark",
		"gdsWatermark",
		"gdsEpoch",
		"nodeMismatchCount",
		"edgeMismatchCount",
		"lifecycleMismatchCount",
		"entityCoverage",
		"edgeCoverage",
		"certifiedAt",
	];

function sameProjectionSnapshot(
	left: GraphBenchmarkProjectionSnapshot,
	right: GraphBenchmarkProjectionSnapshot,
): boolean {
	return projectionSnapshotFields.every(
		(field) => (left[field] ?? null) === (right[field] ?? null),
	);
}

function runMatchesStartInput(
	run: GraphRetrievalBenchmarkRun,
	input: StartGraphRetrievalBenchmarkRunInput,
): boolean {
	// Projection snapshot, trace URI, and start time are server-observed values.
	// They remain immutable on the stored row but are not client idempotency keys.
	return (
		run.id === input.id &&
		run.organizationId === input.organizationId &&
		run.suiteId === input.suiteId &&
		run.suiteChecksum === input.suiteChecksum &&
		run.pairedRunKey === input.pairedRunKey &&
		run.variant === input.variant &&
		run.retrievalPolicyVersion === input.retrievalPolicyVersion &&
		run.harnessVersionId === (input.harnessVersionId ?? null) &&
		run.modelProvider === input.modelProvider &&
		run.modelId === input.modelId &&
		run.modelVersion === input.modelVersion &&
		run.seed === input.seed
	);
}

function runInsertValues(input: StartGraphRetrievalBenchmarkRunInput) {
	return {
		...input,
		harnessVersionId: input.harnessVersionId ?? null,
		traceArtifactUri: input.traceArtifactUri ?? null,
		status: "running" as const,
	};
}

export async function startGraphRetrievalBenchmarkRun(
	db: DbClient,
	input: StartGraphRetrievalBenchmarkRunInput,
): Promise<GraphRetrievalBenchmarkRun> {
	try {
		const [created] = await db
			.insert(graphRetrievalBenchmarkRuns)
			.values(runInsertValues(input))
			.returning();
		if (!created) throw new Error("Run insert returned no row");
		return created;
	} catch {
		const [existing] = await db
			.select()
			.from(graphRetrievalBenchmarkRuns)
			.where(
				and(
					eq(graphRetrievalBenchmarkRuns.organizationId, input.organizationId),
					eq(graphRetrievalBenchmarkRuns.pairedRunKey, input.pairedRunKey),
					eq(graphRetrievalBenchmarkRuns.variant, input.variant),
				),
			)
			.limit(1);
		if (existing && runMatchesStartInput(existing, input)) {
			return existing;
		}
		throw new GraphRetrievalBenchmarkError(
			"run_conflict",
			"Run pair/variant already exists or suite is not exactly locked",
		);
	}
}

/**
 * Creates both variants in one D1 batch transaction. A retry returns the
 * already-created exact pair; a partial or definition-mismatched pair is never
 * repaired implicitly because that would destroy the immutable pairing proof.
 */
export async function startGraphRetrievalBenchmarkRunPair(
	db: DbClient,
	input: {
		baseline: StartGraphRetrievalBenchmarkRunInput & { variant: "baseline" };
		graph: StartGraphRetrievalBenchmarkRunInput & { variant: "graph" };
	},
): Promise<{
	baselineRun: GraphRetrievalBenchmarkRun;
	graphRun: GraphRetrievalBenchmarkRun;
}> {
	const { baseline, graph } = input;
	const samePairDefinition =
		baseline.id !== graph.id &&
		baseline.organizationId === graph.organizationId &&
		baseline.suiteId === graph.suiteId &&
		baseline.suiteChecksum === graph.suiteChecksum &&
		baseline.pairedRunKey === graph.pairedRunKey &&
		baseline.retrievalPolicyVersion === graph.retrievalPolicyVersion &&
		(baseline.harnessVersionId ?? null) === (graph.harnessVersionId ?? null) &&
		baseline.modelProvider === graph.modelProvider &&
		baseline.modelId === graph.modelId &&
		baseline.modelVersion === graph.modelVersion &&
		sameProjectionSnapshot(
			baseline.projectionSnapshot,
			graph.projectionSnapshot,
		) &&
		baseline.seed === graph.seed &&
		baseline.startedAt === graph.startedAt;
	if (!samePairDefinition) {
		throw new GraphRetrievalBenchmarkError(
			"run_conflict",
			"Baseline and graph inputs do not define one immutable pair",
		);
	}

	try {
		const [baselineRows, graphRows] = await db.batch([
			db
				.insert(graphRetrievalBenchmarkRuns)
				.values(runInsertValues(baseline))
				.returning(),
			db
				.insert(graphRetrievalBenchmarkRuns)
				.values(runInsertValues(graph))
				.returning(),
		]);
		const baselineRun = baselineRows[0];
		const graphRun = graphRows[0];
		if (!baselineRun || !graphRun) {
			throw new Error("Atomic run-pair insert returned an incomplete pair");
		}
		return { baselineRun, graphRun };
	} catch {
		const existing = await db
			.select()
			.from(graphRetrievalBenchmarkRuns)
			.where(
				and(
					eq(
						graphRetrievalBenchmarkRuns.organizationId,
						baseline.organizationId,
					),
					eq(graphRetrievalBenchmarkRuns.pairedRunKey, baseline.pairedRunKey),
				),
			)
			.limit(2);
		const baselineRun = existing.find((run) => run.variant === "baseline");
		const graphRun = existing.find((run) => run.variant === "graph");
		if (
			baselineRun &&
			graphRun &&
			runMatchesStartInput(baselineRun, baseline) &&
			runMatchesStartInput(graphRun, graph)
		) {
			return { baselineRun, graphRun };
		}
		throw new GraphRetrievalBenchmarkError(
			"run_conflict",
			"Run pair already exists partially, identifies another definition, or the suite is not exactly locked",
		);
	}
}

export async function recordGraphRetrievalBenchmarkResult(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		runId: string;
		caseId: string;
		origin: "manual" | "builtin";
		retrievedFactIds: string[];
		returnedEdges?: GraphBenchmarkEdge[];
		returnedPaths?: GraphBenchmarkPath[];
		answer?: string | null;
		citedFactIds?: string[];
		claimSupport?: GraphBenchmarkClaimSupport[];
		metrics: GraphBenchmarkCaseMetrics;
		inputTokens: number;
		outputTokens: number;
		latencyMs: number;
		costUsd: number;
		passed: boolean;
		failureReasons?: string[];
		traceArtifactUri?: string | null;
		createdAt: string;
	},
): Promise<GraphRetrievalBenchmarkResult> {
	const [created] = await db
		.insert(graphRetrievalBenchmarkResults)
		.values({
			...input,
			returnedEdges: input.returnedEdges ?? [],
			returnedPaths: input.returnedPaths ?? [],
			answer: input.answer ?? null,
			citedFactIds: input.citedFactIds ?? [],
			claimSupport: input.claimSupport ?? [],
			failureReasons: input.failureReasons ?? [],
			traceArtifactUri: input.traceArtifactUri ?? null,
		})
		.onConflictDoNothing()
		.returning();
	if (created) return created;
	const [existing] = await db
		.select()
		.from(graphRetrievalBenchmarkResults)
		.where(
			and(
				eq(graphRetrievalBenchmarkResults.runId, input.runId),
				eq(graphRetrievalBenchmarkResults.caseId, input.caseId),
			),
		)
		.limit(1);
	if (existing?.id === input.id && existing.origin === input.origin) {
		return existing;
	}
	throw new GraphRetrievalBenchmarkError(
		"case_conflict",
		"Run already has an immutable result for this case",
	);
}

function toScoredCase(
	result: GraphRetrievalBenchmarkResult,
): PersistableScoredCase {
	return {
		caseId: result.caseId,
		metrics: result.metrics,
		passed: result.passed,
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		latencyMs: result.latencyMs,
		costUsd: result.costUsd,
	};
}

export async function listGraphRetrievalBenchmarkResults(
	db: DbClient,
	input: { organizationId: string; runId: string; limit?: number },
): Promise<GraphRetrievalBenchmarkResult[]> {
	return db
		.select()
		.from(graphRetrievalBenchmarkResults)
		.where(
			and(
				eq(graphRetrievalBenchmarkResults.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkResults.runId, input.runId),
			),
		)
		.orderBy(graphRetrievalBenchmarkResults.caseId)
		.limit(Math.max(1, Math.min(2000, Math.trunc(input.limit ?? 1000))));
}

export async function completeGraphRetrievalBenchmarkRun(
	db: DbClient,
	input: {
		organizationId: string;
		runId: string;
		traceArtifactUri?: string | null;
		completedAt: string;
	},
): Promise<GraphRetrievalBenchmarkRun> {
	const [run] = await db
		.select()
		.from(graphRetrievalBenchmarkRuns)
		.where(
			and(
				eq(graphRetrievalBenchmarkRuns.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkRuns.id, input.runId),
			),
		)
		.limit(1);
	if (!run) {
		throw new GraphRetrievalBenchmarkError(
			"run_not_found",
			"Benchmark run was not found",
		);
	}
	if (run.status === "completed") return run;
	if (run.status !== "running") {
		throw new GraphRetrievalBenchmarkError(
			"run_conflict",
			`Benchmark run is ${run.status}`,
		);
	}
	const [suite] = await db
		.select()
		.from(graphRetrievalBenchmarkSuites)
		.where(eq(graphRetrievalBenchmarkSuites.id, run.suiteId))
		.limit(1);
	const results = await listGraphRetrievalBenchmarkResults(db, {
		organizationId: input.organizationId,
		runId: input.runId,
		limit: 2000,
	});
	if (!suite || results.length !== suite.caseCount || suite.caseCount === 0) {
		throw new GraphRetrievalBenchmarkError(
			"case_count_mismatch",
			`Run has ${results.length} immutable results for ${suite?.caseCount ?? 0} suite cases`,
		);
	}
	const aggregate = aggregateGraphRetrievalCases(results.map(toScoredCase));
	const [completed] = await db
		.update(graphRetrievalBenchmarkRuns)
		.set({
			status: "completed",
			caseCount: aggregate.caseCount,
			aggregateMetrics: aggregate,
			totalInputTokens: results.reduce(
				(sum, result) => sum + result.inputTokens,
				0,
			),
			totalOutputTokens: results.reduce(
				(sum, result) => sum + result.outputTokens,
				0,
			),
			totalLatencyMs: results.reduce(
				(sum, result) => sum + result.latencyMs,
				0,
			),
			totalCostUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
			traceArtifactUri: input.traceArtifactUri ?? run.traceArtifactUri,
			completedAt: input.completedAt,
		})
		.where(
			and(
				eq(graphRetrievalBenchmarkRuns.id, run.id),
				eq(graphRetrievalBenchmarkRuns.status, "running"),
			),
		)
		.returning();
	if (!completed) {
		throw new GraphRetrievalBenchmarkError(
			"run_conflict",
			"Benchmark run was settled concurrently",
		);
	}
	return completed;
}

function runMatchesEligibleHarness(run: GraphRetrievalBenchmarkRun): boolean {
	return (
		run.retrievalPolicyVersion ===
			ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_IDENTITY.retrievalPolicyVersion &&
		run.harnessVersionId ===
			ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_IDENTITY.harnessVersionId &&
		run.modelProvider ===
			ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_IDENTITY.modelProvider &&
		run.modelId === ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_IDENTITY.modelId &&
		run.modelVersion === ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_IDENTITY.modelVersion
	);
}

function completedRunMetrics(results: GraphRetrievalBenchmarkResult[]) {
	const aggregate = aggregateGraphRetrievalCases(results.map(toScoredCase));
	return {
		aggregate,
		totalInputTokens: results.reduce(
			(sum, result) => sum + result.inputTokens,
			0,
		),
		totalOutputTokens: results.reduce(
			(sum, result) => sum + result.outputTokens,
			0,
		),
		totalLatencyMs: results.reduce((sum, result) => sum + result.latencyMs, 0),
		totalCostUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
	};
}

/**
 * Settles both server-executed variants with one SQL UPDATE, making eligibility
 * an atomic property of a complete pair rather than two independent writes.
 * The identity fence prevents a manually-labelled/custom harness from using
 * this path. Manual single-run completion intentionally leaves `eligible=0`.
 */
export async function completeEligibleGraphRetrievalBenchmarkRunPair(
	db: DbClient,
	input: {
		organizationId: string;
		pairedRunKey: string;
		baselineRunId: string;
		graphRunId: string;
		completedAt: string;
	},
): Promise<{
	baselineRun: GraphRetrievalBenchmarkRun;
	graphRun: GraphRetrievalBenchmarkRun;
}> {
	const runs = await db
		.select()
		.from(graphRetrievalBenchmarkRuns)
		.where(
			and(
				eq(graphRetrievalBenchmarkRuns.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkRuns.pairedRunKey, input.pairedRunKey),
				inArray(graphRetrievalBenchmarkRuns.id, [
					input.baselineRunId,
					input.graphRunId,
				]),
			),
		)
		.limit(2);
	const baselineRun = runs.find(
		(run) => run.id === input.baselineRunId && run.variant === "baseline",
	);
	const graphRun = runs.find(
		(run) => run.id === input.graphRunId && run.variant === "graph",
	);
	const validPair =
		baselineRun !== undefined &&
		graphRun !== undefined &&
		baselineRun.suiteId === graphRun.suiteId &&
		baselineRun.suiteChecksum === graphRun.suiteChecksum &&
		baselineRun.seed === ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_SEED &&
		graphRun.seed === ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_SEED &&
		matchesCertifiedGraphBenchmarkProjectionSnapshot(
			baselineRun.projectionSnapshot,
			graphRun.projectionSnapshot,
		) &&
		runMatchesEligibleHarness(baselineRun) &&
		runMatchesEligibleHarness(graphRun);
	if (!validPair || !baselineRun || !graphRun) {
		throw new GraphRetrievalBenchmarkError(
			"run_conflict",
			"Only the exact certified built-in baseline/graph pair is eligible for atomic completion",
		);
	}
	if (
		baselineRun.status === "completed" &&
		graphRun.status === "completed" &&
		baselineRun.eligible &&
		graphRun.eligible
	) {
		return { baselineRun, graphRun };
	}
	if (
		baselineRun.status !== "running" ||
		graphRun.status !== "running" ||
		baselineRun.eligible ||
		graphRun.eligible
	) {
		throw new GraphRetrievalBenchmarkError(
			"run_conflict",
			"Eligible paired completion requires both variants to be running or already atomically eligible",
		);
	}

	const [suite] = await db
		.select()
		.from(graphRetrievalBenchmarkSuites)
		.where(
			and(
				eq(graphRetrievalBenchmarkSuites.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkSuites.id, graphRun.suiteId),
			),
		)
		.limit(1);
	const [benchmarkCases, baselineResults, graphResults] = await Promise.all([
		listGraphRetrievalBenchmarkCases(db, {
			organizationId: input.organizationId,
			suiteId: graphRun.suiteId,
			limit: 1000,
		}),
		listGraphRetrievalBenchmarkResults(db, {
			organizationId: input.organizationId,
			runId: baselineRun.id,
			limit: 2000,
		}),
		listGraphRetrievalBenchmarkResults(db, {
			organizationId: input.organizationId,
			runId: graphRun.id,
			limit: 2000,
		}),
	]);
	if (
		!suite ||
		suite.caseCount === 0 ||
		benchmarkCases.length !== suite.caseCount ||
		baselineResults.length !== suite.caseCount ||
		graphResults.length !== suite.caseCount
	) {
		throw new GraphRetrievalBenchmarkError(
			"case_count_mismatch",
			`Paired runs have ${baselineResults.length}/${graphResults.length} immutable results for ${suite?.caseCount ?? 0} suite cases`,
		);
	}
	if (!benchmarkCases.every(isEligiblePathGraphRetrievalBenchmarkCase)) {
		throw new GraphRetrievalBenchmarkError(
			"run_conflict",
			"Eligible paired completion requires anchors and a nontrivial expected path in every case",
		);
	}
	if (
		baselineResults.some((result) => result.origin !== "builtin") ||
		graphResults.some((result) => result.origin !== "builtin")
	) {
		throw new GraphRetrievalBenchmarkError(
			"run_conflict",
			"Eligible paired completion requires every immutable result to originate from the built-in executor",
		);
	}
	const baselineCompleted = completedRunMetrics(baselineResults);
	const graphCompleted = completedRunMetrics(graphResults);

	const completed = await db
		.update(graphRetrievalBenchmarkRuns)
		.set({
			status: "completed",
			caseCount: sql<number>`CASE
				WHEN ${graphRetrievalBenchmarkRuns.id} = ${baselineRun.id}
				THEN ${baselineCompleted.aggregate.caseCount}
				ELSE ${graphCompleted.aggregate.caseCount}
			END`,
			aggregateMetrics: sql<GraphBenchmarkAggregateMetrics>`CASE
				WHEN ${graphRetrievalBenchmarkRuns.id} = ${baselineRun.id}
				THEN ${JSON.stringify(baselineCompleted.aggregate)}
				ELSE ${JSON.stringify(graphCompleted.aggregate)}
			END`,
			totalInputTokens: sql<number>`CASE
				WHEN ${graphRetrievalBenchmarkRuns.id} = ${baselineRun.id}
				THEN ${baselineCompleted.totalInputTokens}
				ELSE ${graphCompleted.totalInputTokens}
			END`,
			totalOutputTokens: sql<number>`CASE
				WHEN ${graphRetrievalBenchmarkRuns.id} = ${baselineRun.id}
				THEN ${baselineCompleted.totalOutputTokens}
				ELSE ${graphCompleted.totalOutputTokens}
			END`,
			totalLatencyMs: sql<number>`CASE
				WHEN ${graphRetrievalBenchmarkRuns.id} = ${baselineRun.id}
				THEN ${baselineCompleted.totalLatencyMs}
				ELSE ${graphCompleted.totalLatencyMs}
			END`,
			totalCostUsd: sql<number>`CASE
				WHEN ${graphRetrievalBenchmarkRuns.id} = ${baselineRun.id}
				THEN ${baselineCompleted.totalCostUsd}
				ELSE ${graphCompleted.totalCostUsd}
			END`,
			eligible: true,
			completedAt: input.completedAt,
		})
		.where(
			and(
				eq(graphRetrievalBenchmarkRuns.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkRuns.pairedRunKey, input.pairedRunKey),
				eq(graphRetrievalBenchmarkRuns.status, "running"),
				inArray(graphRetrievalBenchmarkRuns.id, [baselineRun.id, graphRun.id]),
				sql`(
					SELECT COUNT(*)
					FROM graph_retrieval_benchmark_runs AS pair_guard
					WHERE pair_guard.organization_id = ${input.organizationId}
						AND pair_guard.paired_run_key = ${input.pairedRunKey}
						AND pair_guard.status = 'running'
						AND (
							(pair_guard.id = ${baselineRun.id} AND pair_guard.variant = 'baseline')
							OR (pair_guard.id = ${graphRun.id} AND pair_guard.variant = 'graph')
						)
				) = 2`,
			),
		)
		.returning();
	const completedBaseline = completed.find(
		(run) => run.id === baselineRun.id && run.eligible,
	);
	const completedGraph = completed.find(
		(run) => run.id === graphRun.id && run.eligible,
	);
	if (!completedBaseline || !completedGraph || completed.length !== 2) {
		throw new GraphRetrievalBenchmarkError(
			"run_conflict",
			"Benchmark pair changed concurrently before atomic completion",
		);
	}
	return {
		baselineRun: completedBaseline,
		graphRun: completedGraph,
	};
}

export async function getGraphRetrievalBenchmarkRun(
	db: DbClient,
	input: { organizationId: string; runId: string },
): Promise<GraphRetrievalBenchmarkRun | null> {
	const [row] = await db
		.select()
		.from(graphRetrievalBenchmarkRuns)
		.where(
			and(
				eq(graphRetrievalBenchmarkRuns.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkRuns.id, input.runId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function evaluateStoredGraphRetrievalGraduation(
	db: DbClient,
	input: {
		organizationId: string;
		pairedRunKey: string;
		mode?: GraphRetrievalGraduationMode;
		currentProjection: GraphBenchmarkProjectionSnapshot | null;
		policy?: Partial<Omit<GraphRetrievalGraduationPolicy, "mode">>;
	},
): Promise<{
	suite: GraphRetrievalBenchmarkSuite;
	baselineRun: GraphRetrievalBenchmarkRun;
	graphRun: GraphRetrievalBenchmarkRun;
	result: GraphRetrievalGraduationResult;
}> {
	const runs = await db
		.select()
		.from(graphRetrievalBenchmarkRuns)
		.where(
			and(
				eq(graphRetrievalBenchmarkRuns.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkRuns.pairedRunKey, input.pairedRunKey),
			),
		)
		.limit(2);
	const baselineRun = runs.find((run) => run.variant === "baseline");
	const graphRun = runs.find((run) => run.variant === "graph");
	if (!baselineRun || !graphRun) {
		throw new GraphRetrievalBenchmarkError(
			"incomplete_pair",
			"Paired baseline and graph runs are both required",
		);
	}
	const [suite] = await db
		.select()
		.from(graphRetrievalBenchmarkSuites)
		.where(
			and(
				eq(graphRetrievalBenchmarkSuites.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkSuites.id, graphRun.suiteId),
			),
		)
		.limit(1);
	if (!suite) {
		throw new GraphRetrievalBenchmarkError(
			"suite_not_found",
			"Paired run suite was not found",
		);
	}
	const [baselineResults, graphResults] = await Promise.all([
		listGraphRetrievalBenchmarkResults(db, {
			organizationId: input.organizationId,
			runId: baselineRun.id,
			limit: 2000,
		}),
		listGraphRetrievalBenchmarkResults(db, {
			organizationId: input.organizationId,
			runId: graphRun.id,
			limit: 2000,
		}),
	]);
	const comparison = comparePairedGraphRetrievalCases({
		baseline: baselineResults.map(toScoredCase),
		graph: graphResults.map(toScoredCase),
	});
	const result = evaluateGraphRetrievalGraduation({
		suite: {
			status: suite.status,
			split: suite.split,
			caseCount: suite.caseCount,
		},
		pairIntegrity: {
			sameSuiteChecksum:
				baselineRun.suiteId === graphRun.suiteId &&
				baselineRun.suiteChecksum === graphRun.suiteChecksum,
			sameModel:
				baselineRun.modelProvider === graphRun.modelProvider &&
				baselineRun.modelId === graphRun.modelId &&
				baselineRun.modelVersion === graphRun.modelVersion,
			sameRetrievalPolicy:
				baselineRun.retrievalPolicyVersion === graphRun.retrievalPolicyVersion,
			sameSeed: baselineRun.seed === graphRun.seed,
			baselineCompleted: baselineRun.status === "completed",
			graphCompleted: graphRun.status === "completed",
			baselineEligible: baselineRun.eligible,
			graphEligible: graphRun.eligible,
			sameProjectionSnapshot: matchesCertifiedGraphBenchmarkProjectionSnapshot(
				baselineRun.projectionSnapshot,
				graphRun.projectionSnapshot,
			),
			noMissingCases:
				comparison.missingBaselineCaseIds.length === 0 &&
				comparison.missingGraphCaseIds.length === 0,
		},
		projection: graphRun.projectionSnapshot,
		currentProjection: input.currentProjection,
		baseline: comparison.baseline,
		graph: comparison.graph,
		paired: comparison.paired,
		mode: input.mode,
		policy: input.policy,
	});
	return { suite, baselineRun, graphRun, result };
}

export async function recordGraphRetrievalGraduationEvaluation(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		suiteId: string;
		baselineRunId: string;
		graphRunId: string;
		evaluatorVersion: string;
		result: GraphRetrievalGraduationResult;
		projectionSnapshot: GraphBenchmarkProjectionSnapshot;
		evaluatedAt: string;
	},
): Promise<GraphRetrievalGraduationEvaluation> {
	const [created] = await db
		.insert(graphRetrievalGraduationEvaluations)
		.values({
			id: input.id,
			organizationId: input.organizationId,
			suiteId: input.suiteId,
			baselineRunId: input.baselineRunId,
			graphRunId: input.graphRunId,
			evaluatorVersion: input.evaluatorVersion,
			passed: input.result.passed,
			gates: input.result.gates,
			pairedMetrics: input.result.pairedMetrics,
			projectionSnapshot: input.projectionSnapshot,
			reasons: input.result.reasons,
			evaluatedAt: input.evaluatedAt,
		})
		.onConflictDoNothing()
		.returning();
	if (created) return created;
	const [existing] = await db
		.select()
		.from(graphRetrievalGraduationEvaluations)
		.where(
			and(
				eq(
					graphRetrievalGraduationEvaluations.baselineRunId,
					input.baselineRunId,
				),
				eq(graphRetrievalGraduationEvaluations.graphRunId, input.graphRunId),
				eq(
					graphRetrievalGraduationEvaluations.evaluatorVersion,
					input.evaluatorVersion,
				),
			),
		)
		.limit(1);
	if (existing?.id === input.id) return existing;
	throw new GraphRetrievalBenchmarkError(
		"graduation_conflict",
		"Paired run already has a different immutable graduation evaluation",
	);
}

export function graphRetrievalRunAggregate(
	run: GraphRetrievalBenchmarkRun,
): GraphBenchmarkAggregateMetrics | null {
	return run.aggregateMetrics;
}
