/// <reference path="../../worker-configuration.d.ts" />

import type { DbClient } from "@tedix/db/client";
import { getGraphProjectionBacklogStats } from "@tedix/db/queries/graph-projection";
import {
	EXACT_RETRIEVAL_ONLY_CASE_THRESHOLDS,
	matchesCertifiedGraphBenchmarkProjectionSnapshot,
	scoreGraphRetrievalCase,
} from "@tedix/db/queries/graph-retrieval-benchmark-scorer";
import {
	addGraphRetrievalBenchmarkCase,
	completeEligibleGraphRetrievalBenchmarkRunPair,
	createGraphRetrievalBenchmarkSuite,
	evaluateStoredGraphRetrievalGraduation,
	getGraphRetrievalBenchmarkRun,
	getGraphRetrievalBenchmarkSuite,
	isEligiblePathGraphRetrievalBenchmarkCase,
	listGraphRetrievalBenchmarkCases,
	lockGraphRetrievalBenchmarkSuite,
	recordGraphRetrievalBenchmarkResult,
	recordGraphRetrievalGraduationEvaluation,
	startGraphRetrievalBenchmarkRunPair,
} from "@tedix/db/queries/graph-retrieval-benchmarks";
import {
	getGraphProjectionReadinessSnapshot,
	getGraphRetrievalBenchmarkCaseById,
	listCanonicalBenchmarkEdges,
	listCanonicalBenchmarkFacts,
} from "@tedix/db/queries/graph-retrieval-runtime";
import {
	ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_IDENTITY,
	type GraphBenchmarkEdge,
	type GraphBenchmarkPath,
	type GraphBenchmarkProjectionSnapshot,
	type GraphRetrievalBenchmarkCase,
	type GraphRetrievalBenchmarkRun,
} from "@tedix/db/schema/graph-retrieval-benchmarks";
import { toJsonRecord } from "@tedix/db/utils/json";
import { getGraphClient } from "../integrations/graph-db/client";
import { graphProjectionReadAdmission } from "./graph-projection-certification";
import {
	benchmarkChecksum,
	buildAnchorOnlyObservation,
	buildProjectedGraphObservation,
	deterministicBenchmarkUuid,
	GRAPH_RETRIEVAL_GRADUATION_MODE,
	GRAPH_RETRIEVAL_HARNESS_MODE,
	GRAPH_RETRIEVAL_MAX_DEPTH,
	GRAPH_RETRIEVAL_MAX_NODES_PER_ANCHOR,
	GRAPH_RETRIEVAL_SEED,
	type RetrievalOnlyObservation,
} from "./graph-retrieval-benchmark-harness";

export const GRAPH_RETRIEVAL_GRADUATION_EVALUATOR_VERSION =
	"graph-retrieval-graduation-v2";

export class GraphRetrievalBenchmarkServiceError extends Error {
	constructor(
		readonly reason:
			| "not_found"
			| "invalid_pair"
			| "projection_not_ready"
			| "invalid_case",
		message: string,
	) {
		super(message);
		this.name = "GraphRetrievalBenchmarkServiceError";
	}
}

export function requireEligiblePathGraphRetrievalBenchmarkCases(
	cases: Array<
		Pick<GraphRetrievalBenchmarkCase, "anchorFactIds" | "expectedPaths">
	>,
	expectedCaseCount: number,
): void {
	if (
		cases.length !== expectedCaseCount ||
		cases.some(
			(benchmarkCase) =>
				!isEligiblePathGraphRetrievalBenchmarkCase(benchmarkCase),
		)
	) {
		throw new GraphRetrievalBenchmarkServiceError(
			"invalid_case",
			"Eligible retrieval execution requires every locked case to have anchors and at least one nontrivial expected path",
		);
	}
}

export async function readGraphBenchmarkProjectionSnapshot(
	db: DbClient,
	env: CloudflareEnv,
	organizationId: string,
): Promise<GraphBenchmarkProjectionSnapshot> {
	const [readiness, backlog] = await Promise.all([
		getGraphProjectionReadinessSnapshot(db, organizationId),
		getGraphProjectionBacklogStats(db, organizationId),
	]);
	const graphClient = getGraphClient(env);
	const configured = graphClient !== null;
	let healthy = false;
	if (graphClient) {
		try {
			healthy = await graphClient.isHealthy();
		} catch {
			healthy = false;
		}
	}
	const mismatchesKnownAndClear =
		readiness?.nodeMismatchCount === 0 &&
		readiness.edgeMismatchCount === 0 &&
		readiness.lifecycleMismatchCount === 0;
	const watermarksMatch =
		readiness !== null &&
		readiness.persistedWatermark === backlog.highWaterSequence &&
		backlog.cursor === backlog.highWaterSequence;
	const backlogClear =
		backlog.pendingCount === 0 &&
		backlog.retryCount === 0 &&
		backlog.poisonedCount === 0;
	const admission = graphProjectionReadAdmission({
		inspection: {
			transportHealthy: healthy,
			readiness: readiness ?? null,
			backlog,
			checkedAt: new Date().toISOString(),
		},
	});
	const passesGate =
		configured &&
		admission.allowed &&
		mismatchesKnownAndClear &&
		watermarksMatch &&
		backlogClear;

	return {
		configured,
		healthy,
		passesGate,
		state: readiness?.state ?? "missing",
		projectionEpoch: readiness?.projectionEpoch ?? null,
		persistedWatermark: readiness?.persistedWatermark ?? 0,
		gdsWatermark: readiness?.gdsWatermark ?? 0,
		gdsEpoch: readiness?.gdsEpoch ?? null,
		nodeMismatchCount: readiness?.nodeMismatchCount ?? null,
		edgeMismatchCount: readiness?.edgeMismatchCount ?? null,
		lifecycleMismatchCount: readiness?.lifecycleMismatchCount ?? null,
		certifiedAt: readiness?.lastCertifiedAt ?? null,
	};
}

export async function requireCertifiedGraphBenchmarkProjection(
	db: DbClient,
	env: CloudflareEnv,
	organizationId: string,
): Promise<GraphBenchmarkProjectionSnapshot> {
	const snapshot = await readGraphBenchmarkProjectionSnapshot(
		db,
		env,
		organizationId,
	);
	if (!snapshot.passesGate) {
		throw new GraphRetrievalBenchmarkServiceError(
			"projection_not_ready",
			`Graph benchmark is disabled while projection readiness is ${snapshot.state ?? "missing"}`,
		);
	}
	return snapshot;
}

export async function serverCaseChecksum(input: {
	organizationId: string;
	suiteId: string;
	caseId: string;
	suiteRevision: number;
	caseKey: string;
	query: string;
	anchorFactIds: string[];
	expectedFactIds: string[];
	expectedEdges: GraphBenchmarkEdge[];
	expectedPaths: GraphBenchmarkPath[];
	forbiddenFactIds: string[];
	validAt: string;
	answerRubric: Record<string, unknown>;
	artifactUri?: string | null;
	tags: string[];
	difficulty: string;
}): Promise<string> {
	return benchmarkChecksum({
		kind: "graph_retrieval_benchmark_case_v1",
		...input,
		artifactUri: input.artifactUri ?? null,
	});
}

export async function serverSuiteChecksum(input: {
	suite: {
		id: string;
		organizationId: string;
		name: string;
		version: number;
		split: string;
		revision: number;
		caseCount: number;
		sourceCommit: string | null;
		artifactUri: string | null;
	};
	cases: Array<{ id: string; caseKey: string; checksum: string }>;
}): Promise<string> {
	const suiteDefinition = {
		id: input.suite.id,
		organizationId: input.suite.organizationId,
		name: input.suite.name,
		version: input.suite.version,
		split: input.suite.split,
		revision: input.suite.revision,
		caseCount: input.suite.caseCount,
		sourceCommit: input.suite.sourceCommit,
		artifactUri: input.suite.artifactUri,
	};
	return benchmarkChecksum({
		kind: "graph_retrieval_benchmark_suite_v1",
		suite: suiteDefinition,
		cases: [...input.cases]
			.sort((left, right) => left.caseKey.localeCompare(right.caseKey))
			.map(({ id, caseKey, checksum }) => ({ id, caseKey, checksum })),
	});
}

export async function createDraftGraphBenchmark(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		name: string;
		version: number;
		split: "validation" | "locked_test" | "canary";
		sourceCommit?: string;
		artifactUri?: string;
		actor: {
			type: "user" | "tedi" | "service" | "api_key" | "external_agent";
			id: string;
		};
		now: string;
	},
) {
	return createGraphRetrievalBenchmarkSuite(db, {
		id: input.id,
		organizationId: input.organizationId,
		name: input.name,
		version: input.version,
		split: input.split,
		sourceCommit: input.sourceCommit,
		artifactUri: input.artifactUri,
		createdByType: input.actor.type,
		createdById: input.actor.id,
		createdAt: input.now,
	});
}

export async function addServerChecksummedGraphBenchmarkCase(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		suiteId: string;
		expectedSuiteRevision: number;
		caseKey: string;
		query: string;
		anchorFactIds: string[];
		expectedFactIds: string[];
		expectedEdges: GraphBenchmarkEdge[];
		expectedPaths: GraphBenchmarkPath[];
		forbiddenFactIds: string[];
		validAt: string;
		answerRubric: Record<string, unknown>;
		artifactUri?: string;
		tags: string[];
		difficulty: "basic" | "intermediate" | "advanced" | "adversarial";
		now: string;
	},
) {
	const checksum = await serverCaseChecksum({
		organizationId: input.organizationId,
		suiteId: input.suiteId,
		caseId: input.id,
		suiteRevision: input.expectedSuiteRevision,
		caseKey: input.caseKey,
		query: input.query,
		anchorFactIds: input.anchorFactIds,
		expectedFactIds: input.expectedFactIds,
		expectedEdges: input.expectedEdges,
		expectedPaths: input.expectedPaths,
		forbiddenFactIds: input.forbiddenFactIds,
		validAt: input.validAt,
		answerRubric: input.answerRubric,
		artifactUri: input.artifactUri,
		tags: input.tags,
		difficulty: input.difficulty,
	});
	return addGraphRetrievalBenchmarkCase(db, {
		...input,
		answerRubric: toJsonRecord(input.answerRubric),
		checksum,
		createdAt: input.now,
	});
}

export async function lockServerChecksummedGraphBenchmarkSuite(
	db: DbClient,
	input: {
		organizationId: string;
		suiteId: string;
		expectedRevision: number;
		minimumCaseCount: number;
		now: string;
	},
) {
	const suite = await getGraphRetrievalBenchmarkSuite(db, input);
	if (!suite) {
		throw new GraphRetrievalBenchmarkServiceError(
			"not_found",
			"Benchmark suite was not found",
		);
	}
	const cases = await listGraphRetrievalBenchmarkCases(db, {
		organizationId: input.organizationId,
		suiteId: input.suiteId,
		limit: 1000,
	});
	const definitionChecksum = await serverSuiteChecksum({ suite, cases });
	return lockGraphRetrievalBenchmarkSuite(db, {
		...input,
		definitionChecksum,
		lockedAt: input.now,
	});
}

export async function startGraphBenchmarkPair(
	db: DbClient,
	env: CloudflareEnv,
	input: {
		organizationId: string;
		suiteId: string;
		baselineRunId: string;
		graphRunId: string;
		pairedRunKey: string;
		now: string;
	},
): Promise<{
	projectionSnapshot: GraphBenchmarkProjectionSnapshot;
	baselineRun: GraphRetrievalBenchmarkRun;
	graphRun: GraphRetrievalBenchmarkRun;
}> {
	const suite = await getGraphRetrievalBenchmarkSuite(db, input);
	if (!suite) {
		throw new GraphRetrievalBenchmarkServiceError(
			"not_found",
			"Benchmark suite was not found",
		);
	}
	if (suite.status !== "locked" || !suite.definitionChecksum) {
		throw new GraphRetrievalBenchmarkServiceError(
			"invalid_pair",
			"Paired execution requires an exactly locked suite",
		);
	}
	const cases = await listGraphRetrievalBenchmarkCases(db, {
		organizationId: input.organizationId,
		suiteId: input.suiteId,
		limit: 1000,
	});
	requireEligiblePathGraphRetrievalBenchmarkCases(cases, suite.caseCount);
	const [existingBaselineRun, existingGraphRun] = await Promise.all([
		getGraphRetrievalBenchmarkRun(db, {
			organizationId: input.organizationId,
			runId: input.baselineRunId,
		}),
		getGraphRetrievalBenchmarkRun(db, {
			organizationId: input.organizationId,
			runId: input.graphRunId,
		}),
	]);
	if (existingBaselineRun || existingGraphRun) {
		const existingPair =
			existingBaselineRun && existingGraphRun
				? {
						baselineRun: existingBaselineRun,
						graphRun: existingGraphRun,
					}
				: null;
		if (
			existingPair?.baselineRun.variant !== "baseline" ||
			existingPair.graphRun.variant !== "graph" ||
			existingPair.baselineRun.pairedRunKey !== input.pairedRunKey ||
			existingPair.graphRun.pairedRunKey !== input.pairedRunKey ||
			existingPair.baselineRun.suiteId !== suite.id ||
			existingPair.graphRun.suiteId !== suite.id ||
			existingPair.baselineRun.suiteChecksum !== suite.definitionChecksum ||
			existingPair.graphRun.suiteChecksum !== suite.definitionChecksum ||
			existingPair.baselineRun.seed !== GRAPH_RETRIEVAL_SEED ||
			existingPair.graphRun.seed !== GRAPH_RETRIEVAL_SEED ||
			!pairUsesBuiltinRetrievalHarness(existingPair) ||
			!matchesCertifiedGraphBenchmarkProjectionSnapshot(
				existingPair.baselineRun.projectionSnapshot,
				existingPair.graphRun.projectionSnapshot,
			)
		) {
			throw new GraphRetrievalBenchmarkServiceError(
				"invalid_pair",
				"Existing client run IDs do not identify this exact built-in pair",
			);
		}
		return {
			projectionSnapshot: existingPair.graphRun.projectionSnapshot,
			...existingPair,
		};
	}
	const projectionSnapshot = await requireCertifiedGraphBenchmarkProjection(
		db,
		env,
		input.organizationId,
	);
	const common = {
		organizationId: input.organizationId,
		suiteId: input.suiteId,
		suiteChecksum: suite.definitionChecksum,
		pairedRunKey: input.pairedRunKey,
		...ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_IDENTITY,
		projectionSnapshot,
		seed: GRAPH_RETRIEVAL_SEED,
		startedAt: input.now,
	};
	const { baselineRun, graphRun } = await startGraphRetrievalBenchmarkRunPair(
		db,
		{
			baseline: {
				...common,
				id: input.baselineRunId,
				variant: "baseline",
			},
			graph: {
				...common,
				id: input.graphRunId,
				variant: "graph",
			},
		},
	);
	return {
		projectionSnapshot: graphRun.projectionSnapshot,
		baselineRun,
		graphRun,
	};
}

function requirePairProjectionSnapshot(
	pair: {
		baselineRun: GraphRetrievalBenchmarkRun;
		graphRun: GraphRetrievalBenchmarkRun;
	},
	current: GraphBenchmarkProjectionSnapshot,
): void {
	if (
		!matchesCertifiedGraphBenchmarkProjectionSnapshot(
			pair.baselineRun.projectionSnapshot,
			current,
		) ||
		!matchesCertifiedGraphBenchmarkProjectionSnapshot(
			pair.graphRun.projectionSnapshot,
			current,
		)
	) {
		throw new GraphRetrievalBenchmarkServiceError(
			"projection_not_ready",
			"Certified graph projection watermark/epoch no longer matches the immutable benchmark pair snapshot",
		);
	}
}

function pairUsesBuiltinRetrievalHarness(pair: {
	baselineRun: GraphRetrievalBenchmarkRun;
	graphRun: GraphRetrievalBenchmarkRun;
}): boolean {
	return [pair.baselineRun, pair.graphRun].every(
		(run) =>
			run.retrievalPolicyVersion ===
				ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_IDENTITY.retrievalPolicyVersion &&
			run.harnessVersionId ===
				ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_IDENTITY.harnessVersionId &&
			run.modelProvider ===
				ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_IDENTITY.modelProvider &&
			run.modelId === ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_IDENTITY.modelId &&
			run.modelVersion ===
				ELIGIBLE_BUILTIN_GRAPH_RETRIEVAL_IDENTITY.modelVersion,
	);
}

async function getCase(
	db: DbClient,
	organizationId: string,
	caseId: string,
): Promise<GraphRetrievalBenchmarkCase | null> {
	return getGraphRetrievalBenchmarkCaseById(db, { organizationId, caseId });
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function observationFactIds(
	benchmarkCase: GraphRetrievalBenchmarkCase,
	observation: RetrievalOnlyObservation,
): string[] {
	return unique([
		...benchmarkCase.expectedFactIds,
		...benchmarkCase.forbiddenFactIds,
		...benchmarkCase.expectedEdges.flatMap((edge) => [
			edge.sourceFactId,
			edge.targetFactId,
		]),
		...benchmarkCase.expectedPaths.flatMap((path) => path.factIds),
		...observation.retrievedFactIds,
		...observation.returnedEdges.flatMap((edge) => [
			edge.sourceFactId,
			edge.targetFactId,
		]),
		...observation.returnedPaths.flatMap((path) => path.factIds),
	]);
}

async function readCanonicalFacts(
	db: DbClient,
	organizationId: string,
	factIds: string[],
) {
	const rows = [];
	for (let index = 0; index < factIds.length; index += 80) {
		rows.push(
			...(await listCanonicalBenchmarkFacts(db, {
				organizationId,
				factIds: factIds.slice(index, index + 80),
			})),
		);
	}
	return rows;
}

async function readCanonicalEdges(
	db: DbClient,
	organizationId: string,
	edges: GraphBenchmarkEdge[],
	canonicalFactIds: ReadonlySet<string>,
) {
	const sourceIds = unique(edges.map((edge) => edge.sourceFactId));
	const wanted = new Set(
		edges.map(
			(edge) =>
				`${edge.sourceFactId}\u001f${edge.relationType}\u001f${edge.targetFactId}`,
		),
	);
	const rows: Array<{
		sourceFactId: string;
		targetFactId: string;
		relationType: string;
	}> = [];
	for (let index = 0; index < sourceIds.length; index += 80) {
		rows.push(
			...(await listCanonicalBenchmarkEdges(db, {
				organizationId,
				sourceFactIds: sourceIds.slice(index, index + 80),
			})),
		);
	}
	return rows
		.filter(
			(edge) =>
				canonicalFactIds.has(edge.sourceFactId) &&
				canonicalFactIds.has(edge.targetFactId) &&
				wanted.has(
					`${edge.sourceFactId}\u001f${edge.relationType}\u001f${edge.targetFactId}`,
				),
		)
		.map((edge) => ({ ...edge, organizationId }));
}

export async function scoreAndRecordRetrievalOnlyObservation(
	db: DbClient,
	env: CloudflareEnv,
	input: {
		organizationId: string;
		runId: string;
		caseId: string;
		observationId: string;
		origin: "manual" | "builtin";
		observation: RetrievalOnlyObservation;
		latencyMs?: number;
		traceArtifactUri?: string;
		now: string;
	},
) {
	const [run, benchmarkCase] = await Promise.all([
		getGraphRetrievalBenchmarkRun(db, {
			organizationId: input.organizationId,
			runId: input.runId,
		}),
		getCase(db, input.organizationId, input.caseId),
	]);
	if (!run || !benchmarkCase) {
		throw new GraphRetrievalBenchmarkServiceError(
			"not_found",
			"Benchmark run or case was not found",
		);
	}
	if (run.status !== "running" || benchmarkCase.suiteId !== run.suiteId) {
		throw new GraphRetrievalBenchmarkServiceError(
			"invalid_case",
			"Observation must target a running run and a case from the same suite",
		);
	}
	if (run.variant === "graph") {
		await requireCertifiedGraphBenchmarkProjection(
			db,
			env,
			input.organizationId,
		);
	}
	const factIds = observationFactIds(benchmarkCase, input.observation);
	const canonicalFacts = await readCanonicalFacts(
		db,
		input.organizationId,
		factIds,
	);
	const canonicalFactIds = new Set(canonicalFacts.map((fact) => fact.id));
	const canonicalEdges = await readCanonicalEdges(
		db,
		input.organizationId,
		[
			...benchmarkCase.expectedEdges,
			...benchmarkCase.expectedPaths.flatMap((path) => path.edges),
			...input.observation.returnedEdges,
			...input.observation.returnedPaths.flatMap((path) => path.edges),
		],
		canonicalFactIds,
	);
	const scored = scoreGraphRetrievalCase({
		expectation: {
			organizationId: input.organizationId,
			validAt: benchmarkCase.validAt,
			expectedFactIds: benchmarkCase.expectedFactIds,
			expectedEdges: benchmarkCase.expectedEdges,
			expectedPaths: benchmarkCase.expectedPaths,
			forbiddenFactIds: benchmarkCase.forbiddenFactIds,
		},
		observation: {
			...input.observation,
			citedFactIds: [],
			claimSupport: [],
			answerScore: 0,
			inputTokens: 0,
			outputTokens: 0,
			latencyMs: Math.max(0, Math.round(input.latencyMs ?? 0)),
			costUsd: 0,
		},
		canonicalFacts,
		canonicalEdges,
		thresholds: EXACT_RETRIEVAL_ONLY_CASE_THRESHOLDS,
	});
	const result = await recordGraphRetrievalBenchmarkResult(db, {
		id: input.observationId,
		organizationId: input.organizationId,
		runId: input.runId,
		caseId: input.caseId,
		origin: input.origin,
		retrievedFactIds: input.observation.retrievedFactIds,
		returnedEdges: input.observation.returnedEdges,
		returnedPaths: input.observation.returnedPaths,
		answer: null,
		citedFactIds: [],
		claimSupport: [],
		metrics: scored.metrics,
		inputTokens: 0,
		outputTokens: 0,
		latencyMs: Math.max(0, Math.round(input.latencyMs ?? 0)),
		costUsd: 0,
		passed: scored.passed,
		failureReasons: scored.failureReasons,
		traceArtifactUri: input.traceArtifactUri,
		createdAt: input.now,
	});
	return { result, invalidPathIndexes: scored.invalidPathIndexes };
}

async function requirePair(
	db: DbClient,
	input: {
		organizationId: string;
		pairedRunKey: string;
		baselineRunId: string;
		graphRunId: string;
	},
): Promise<{
	baselineRun: GraphRetrievalBenchmarkRun;
	graphRun: GraphRetrievalBenchmarkRun;
}> {
	const [baselineRun, graphRun] = await Promise.all([
		getGraphRetrievalBenchmarkRun(db, {
			organizationId: input.organizationId,
			runId: input.baselineRunId,
		}),
		getGraphRetrievalBenchmarkRun(db, {
			organizationId: input.organizationId,
			runId: input.graphRunId,
		}),
	]);
	if (
		!baselineRun ||
		!graphRun ||
		baselineRun.variant !== "baseline" ||
		graphRun.variant !== "graph" ||
		baselineRun.pairedRunKey !== input.pairedRunKey ||
		graphRun.pairedRunKey !== input.pairedRunKey ||
		baselineRun.suiteId !== graphRun.suiteId ||
		baselineRun.suiteChecksum !== graphRun.suiteChecksum
	) {
		throw new GraphRetrievalBenchmarkServiceError(
			"invalid_pair",
			"Baseline and graph runs do not form the requested immutable pair",
		);
	}
	return { baselineRun, graphRun };
}

export async function executeRetrievalOnlyGraphBenchmarkPair(
	db: DbClient,
	env: CloudflareEnv,
	input: {
		organizationId: string;
		pairedRunKey: string;
		baselineRunId: string;
		graphRunId: string;
		now: string;
	},
) {
	const pair = await requirePair(db, input);
	if (!pairUsesBuiltinRetrievalHarness(pair)) {
		throw new GraphRetrievalBenchmarkServiceError(
			"invalid_pair",
			"Only the fixed built-in retrieval harness can execute an eligible pair",
		);
	}
	if (
		pair.baselineRun.status === "completed" &&
		pair.graphRun.status === "completed" &&
		pair.baselineRun.eligible &&
		pair.graphRun.eligible
	) {
		return pair;
	}
	if (
		pair.baselineRun.status !== "running" ||
		pair.graphRun.status !== "running"
	) {
		throw new GraphRetrievalBenchmarkServiceError(
			"invalid_pair",
			"Retrieval execution requires both paired runs to be running",
		);
	}
	const initialProjection = await requireCertifiedGraphBenchmarkProjection(
		db,
		env,
		input.organizationId,
	);
	requirePairProjectionSnapshot(pair, initialProjection);
	const cases = await listGraphRetrievalBenchmarkCases(db, {
		organizationId: input.organizationId,
		suiteId: pair.graphRun.suiteId,
		limit: 1000,
	});
	const graphClient = getGraphClient(env);
	if (!graphClient) {
		throw new GraphRetrievalBenchmarkServiceError(
			"projection_not_ready",
			"Graph DB is not configured",
		);
	}
	for (const benchmarkCase of cases) {
		const baselineStartedAt = performance.now();
		const baselineFacts = await readCanonicalFacts(
			db,
			input.organizationId,
			benchmarkCase.anchorFactIds,
		);
		const baselineObservation = buildAnchorOnlyObservation(
			baselineFacts.map((fact) => fact.id),
		);
		await scoreAndRecordRetrievalOnlyObservation(db, env, {
			organizationId: input.organizationId,
			runId: pair.baselineRun.id,
			caseId: benchmarkCase.id,
			observationId: await deterministicBenchmarkUuid({
				mode: GRAPH_RETRIEVAL_HARNESS_MODE,
				runId: pair.baselineRun.id,
				caseId: benchmarkCase.id,
			}),
			origin: "builtin",
			observation: baselineObservation,
			latencyMs: performance.now() - baselineStartedAt,
			now: input.now,
		});

		const startedAt = performance.now();
		const traversals = await Promise.all(
			[...new Set(benchmarkCase.anchorFactIds)]
				.sort()
				.map((anchorFactId) =>
					graphClient.traverse(
						anchorFactId,
						input.organizationId,
						GRAPH_RETRIEVAL_MAX_DEPTH,
						GRAPH_RETRIEVAL_MAX_NODES_PER_ANCHOR,
					),
				),
		);
		const observation = buildProjectedGraphObservation({
			anchorFactIds: benchmarkCase.anchorFactIds,
			expectedFactIds: benchmarkCase.expectedFactIds,
			traversals,
			maxDepth: GRAPH_RETRIEVAL_MAX_DEPTH,
		});
		await scoreAndRecordRetrievalOnlyObservation(db, env, {
			organizationId: input.organizationId,
			runId: pair.graphRun.id,
			caseId: benchmarkCase.id,
			observationId: await deterministicBenchmarkUuid({
				mode: GRAPH_RETRIEVAL_HARNESS_MODE,
				runId: pair.graphRun.id,
				caseId: benchmarkCase.id,
			}),
			origin: "builtin",
			observation,
			latencyMs: performance.now() - startedAt,
			now: input.now,
		});
	}
	const finalProjection = await requireCertifiedGraphBenchmarkProjection(
		db,
		env,
		input.organizationId,
	);
	requirePairProjectionSnapshot(pair, finalProjection);
	return completeEligibleGraphRetrievalBenchmarkRunPair(db, {
		organizationId: input.organizationId,
		pairedRunKey: input.pairedRunKey,
		baselineRunId: pair.baselineRun.id,
		graphRunId: pair.graphRun.id,
		completedAt: input.now,
	});
}

export async function evaluateAndRecordGraphBenchmarkGraduation(
	db: DbClient,
	env: CloudflareEnv,
	input: {
		organizationId: string;
		pairedRunKey: string;
		now: string;
	},
) {
	const projectionSnapshot = await requireCertifiedGraphBenchmarkProjection(
		db,
		env,
		input.organizationId,
	);
	const evaluated = await evaluateStoredGraphRetrievalGraduation(db, {
		organizationId: input.organizationId,
		pairedRunKey: input.pairedRunKey,
		mode: GRAPH_RETRIEVAL_GRADUATION_MODE,
		currentProjection: projectionSnapshot,
	});
	return recordGraphRetrievalGraduationEvaluation(db, {
		id: await deterministicBenchmarkUuid({
			pairedRunKey: input.pairedRunKey,
			evaluatorVersion: GRAPH_RETRIEVAL_GRADUATION_EVALUATOR_VERSION,
		}),
		organizationId: input.organizationId,
		suiteId: evaluated.suite.id,
		baselineRunId: evaluated.baselineRun.id,
		graphRunId: evaluated.graphRun.id,
		evaluatorVersion: GRAPH_RETRIEVAL_GRADUATION_EVALUATOR_VERSION,
		result: evaluated.result,
		projectionSnapshot,
		evaluatedAt: input.now,
	});
}
