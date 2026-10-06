import type {
	GraphBenchmarkAggregateMetrics,
	GraphBenchmarkCaseMetrics,
	GraphBenchmarkClaimSupport,
	GraphBenchmarkEdge,
	GraphBenchmarkGraduationGates,
	GraphBenchmarkPath,
	GraphBenchmarkProjectionSnapshot,
} from "../schema/graph-retrieval-benchmarks";

export interface CanonicalBenchmarkFact {
	id: string;
	organizationId: string;
	validFrom: string | null;
	validTo: string | null;
	archivedAt: string | null;
}

export interface CanonicalBenchmarkEdge extends GraphBenchmarkEdge {
	organizationId: string;
}

export interface GraphRetrievalCaseExpectation {
	organizationId: string;
	validAt: string;
	expectedFactIds: string[];
	expectedEdges: GraphBenchmarkEdge[];
	expectedPaths: GraphBenchmarkPath[];
	forbiddenFactIds: string[];
}

export interface GraphRetrievalCaseObservation {
	retrievedFactIds: string[];
	returnedEdges: GraphBenchmarkEdge[];
	returnedPaths: GraphBenchmarkPath[];
	citedFactIds: string[];
	claimSupport: GraphBenchmarkClaimSupport[];
	answerScore: number;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
	costUsd: number;
}

export interface GraphRetrievalCaseThresholds {
	minFactRecall: number;
	minFactPrecision: number;
	minEdgeRecall: number;
	minEdgePrecision: number;
	minPathValidity: number;
	minExpectedPathCoverage: number;
	minTemporalAccuracy: number;
	maxForbiddenFactRate: number;
	maxUnsupportedInferenceRate: number;
	minAnswerScore: number;
}

export const DEFAULT_GRAPH_RETRIEVAL_CASE_THRESHOLDS: GraphRetrievalCaseThresholds =
	{
		minFactRecall: 0.8,
		minFactPrecision: 0.8,
		minEdgeRecall: 0.8,
		minEdgePrecision: 0.8,
		minPathValidity: 1,
		minExpectedPathCoverage: 0.8,
		minTemporalAccuracy: 1,
		maxForbiddenFactRate: 0,
		maxUnsupportedInferenceRate: 0,
		minAnswerScore: 0.8,
	};

export const EXACT_RETRIEVAL_ONLY_CASE_THRESHOLDS: GraphRetrievalCaseThresholds =
	{
		minFactRecall: 1,
		minFactPrecision: 1,
		minEdgeRecall: 1,
		minEdgePrecision: 1,
		minPathValidity: 1,
		minExpectedPathCoverage: 1,
		minTemporalAccuracy: 1,
		maxForbiddenFactRate: 0,
		maxUnsupportedInferenceRate: 0,
		minAnswerScore: 0,
	};

export interface ScoredGraphRetrievalCase {
	metrics: GraphBenchmarkCaseMetrics;
	passed: boolean;
	failureReasons: string[];
	invalidPathIndexes: number[];
}

function clampUnit(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(1, value));
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function ratio(
	numerator: number,
	denominator: number,
	emptyValue: number,
): number {
	return denominator === 0 ? emptyValue : numerator / denominator;
}

function recall(expected: Set<string>, observed: Set<string>): number {
	let found = 0;
	for (const id of expected) if (observed.has(id)) found++;
	return ratio(found, expected.size, 1);
}

function precision(expected: Set<string>, observed: Set<string>): number {
	let correct = 0;
	for (const id of observed) if (expected.has(id)) correct++;
	return ratio(correct, observed.size, 1);
}

function edgeKey(edge: GraphBenchmarkEdge): string {
	return `${edge.sourceFactId}\u001f${edge.relationType}\u001f${edge.targetFactId}`;
}

function pathKey(path: GraphBenchmarkPath): string {
	return `${path.factIds.join("\u001e")}::${path.edges
		.map(edgeKey)
		.join("\u001e")}`;
}

function parsedTime(value: string | null): number | null {
	if (value === null) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

export function isCanonicalFactValidAt(
	fact: CanonicalBenchmarkFact,
	organizationId: string,
	validAt: string,
): boolean {
	if (fact.organizationId !== organizationId) return false;
	const at = parsedTime(validAt);
	if (at === null) return false;
	const from = parsedTime(fact.validFrom);
	const to = parsedTime(fact.validTo);
	const archived = parsedTime(fact.archivedAt);
	if (fact.validFrom !== null && from === null) return false;
	if (fact.validTo !== null && to === null) return false;
	if (fact.archivedAt !== null && archived === null) return false;
	return (
		(from === null || from <= at) &&
		(to === null || at < to) &&
		(archived === null || at < archived)
	);
}

/**
 * A path is valid only when every node is a canonical, org-scoped fact active
 * at `validAt`, every returned edge exists in canonical D1, and the declared
 * edges connect each adjacent node. Neo4j's own path result is never accepted
 * as proof of its correctness.
 */
export function validateCanonicalGraphPath(
	path: GraphBenchmarkPath,
	input: {
		organizationId: string;
		validAt: string;
		factsById: ReadonlyMap<string, CanonicalBenchmarkFact>;
		canonicalEdgeKeys: ReadonlySet<string>;
	},
): boolean {
	if (
		path.factIds.length === 0 ||
		path.edges.length !== path.factIds.length - 1
	) {
		return false;
	}
	for (const factId of path.factIds) {
		const fact = input.factsById.get(factId);
		if (
			!fact ||
			!isCanonicalFactValidAt(fact, input.organizationId, input.validAt)
		) {
			return false;
		}
	}
	for (let index = 0; index < path.edges.length; index++) {
		const edge = path.edges[index];
		if (!edge) return false;
		const left = path.factIds[index];
		const right = path.factIds[index + 1];
		const connects =
			(edge.sourceFactId === left && edge.targetFactId === right) ||
			(edge.sourceFactId === right && edge.targetFactId === left);
		if (!connects || !input.canonicalEdgeKeys.has(edgeKey(edge))) return false;
	}
	return true;
}

export function scoreGraphRetrievalCase(input: {
	expectation: GraphRetrievalCaseExpectation;
	observation: GraphRetrievalCaseObservation;
	canonicalFacts: CanonicalBenchmarkFact[];
	canonicalEdges: CanonicalBenchmarkEdge[];
	thresholds?: Partial<GraphRetrievalCaseThresholds>;
}): ScoredGraphRetrievalCase {
	const thresholds = {
		...DEFAULT_GRAPH_RETRIEVAL_CASE_THRESHOLDS,
		...input.thresholds,
	};
	const expectedFacts = new Set(unique(input.expectation.expectedFactIds));
	const retrievedFacts = new Set(unique(input.observation.retrievedFactIds));
	const expectedEdges = new Set(input.expectation.expectedEdges.map(edgeKey));
	const returnedEdges = new Set(input.observation.returnedEdges.map(edgeKey));
	const forbidden = new Set(unique(input.expectation.forbiddenFactIds));
	const cited = new Set(unique(input.observation.citedFactIds));
	const factsById = new Map(
		input.canonicalFacts.map((fact) => [fact.id, fact]),
	);
	const canonicalEdgeKeys = new Set(
		input.canonicalEdges
			.filter(
				(edge) => edge.organizationId === input.expectation.organizationId,
			)
			.map(edgeKey),
	);

	const validRetrieved = [...retrievedFacts].filter((id) => {
		const fact = factsById.get(id);
		return (
			fact !== undefined &&
			isCanonicalFactValidAt(
				fact,
				input.expectation.organizationId,
				input.expectation.validAt,
			)
		);
	});
	const forbiddenRetrieved = [...retrievedFacts].filter((id) =>
		forbidden.has(id),
	);
	const invalidPathIndexes: number[] = [];
	const validReturnedPathKeys = new Set<string>();
	input.observation.returnedPaths.forEach((path, index) => {
		if (
			validateCanonicalGraphPath(path, {
				organizationId: input.expectation.organizationId,
				validAt: input.expectation.validAt,
				factsById,
				canonicalEdgeKeys,
			})
		) {
			validReturnedPathKeys.add(pathKey(path));
		} else {
			invalidPathIndexes.push(index);
		}
	});
	const expectedPathKeys = new Set(
		input.expectation.expectedPaths.map(pathKey),
	);
	let coveredExpectedPaths = 0;
	for (const expectedPath of expectedPathKeys) {
		if (validReturnedPathKeys.has(expectedPath)) coveredExpectedPaths++;
	}
	const supportedClaims = input.observation.claimSupport.filter((claim) =>
		unique(claim.citedFactIds).some((factId) => {
			const fact = factsById.get(factId);
			return (
				cited.has(factId) &&
				retrievedFacts.has(factId) &&
				!forbidden.has(factId) &&
				fact !== undefined &&
				isCanonicalFactValidAt(
					fact,
					input.expectation.organizationId,
					input.expectation.validAt,
				)
			);
		}),
	).length;

	const metrics: GraphBenchmarkCaseMetrics = {
		factRecall: recall(expectedFacts, retrievedFacts),
		factPrecision: precision(expectedFacts, retrievedFacts),
		edgeRecall: recall(expectedEdges, returnedEdges),
		edgePrecision: precision(expectedEdges, returnedEdges),
		pathValidity: ratio(
			input.observation.returnedPaths.length - invalidPathIndexes.length,
			input.observation.returnedPaths.length,
			expectedPathKeys.size === 0 ? 1 : 0,
		),
		expectedPathCoverage: ratio(coveredExpectedPaths, expectedPathKeys.size, 1),
		temporalAccuracy: ratio(validRetrieved.length, retrievedFacts.size, 1),
		forbiddenFactRate: ratio(forbiddenRetrieved.length, retrievedFacts.size, 0),
		citationRecall: recall(expectedFacts, cited),
		citationPrecision: precision(expectedFacts, cited),
		unsupportedInferenceRate: ratio(
			input.observation.claimSupport.length - supportedClaims,
			input.observation.claimSupport.length,
			0,
		),
		answerScore: clampUnit(input.observation.answerScore),
	};

	const failureReasons: string[] = [];
	const minimums: Array<[keyof GraphBenchmarkCaseMetrics, number, string]> = [
		["factRecall", thresholds.minFactRecall, "fact recall"],
		["factPrecision", thresholds.minFactPrecision, "fact precision"],
		["edgeRecall", thresholds.minEdgeRecall, "edge recall"],
		["edgePrecision", thresholds.minEdgePrecision, "edge precision"],
		["pathValidity", thresholds.minPathValidity, "path validity"],
		[
			"expectedPathCoverage",
			thresholds.minExpectedPathCoverage,
			"expected path coverage",
		],
		["temporalAccuracy", thresholds.minTemporalAccuracy, "temporal accuracy"],
		["answerScore", thresholds.minAnswerScore, "answer score"],
	];
	for (const [metric, minimum, label] of minimums) {
		if (metrics[metric] < minimum) {
			failureReasons.push(`${label} ${metrics[metric]} < ${minimum}`);
		}
	}
	if (metrics.forbiddenFactRate > thresholds.maxForbiddenFactRate) {
		failureReasons.push(
			`forbidden fact rate ${metrics.forbiddenFactRate} > ${thresholds.maxForbiddenFactRate}`,
		);
	}
	if (
		metrics.unsupportedInferenceRate > thresholds.maxUnsupportedInferenceRate
	) {
		failureReasons.push(
			`unsupported inference rate ${metrics.unsupportedInferenceRate} > ${thresholds.maxUnsupportedInferenceRate}`,
		);
	}
	return {
		metrics,
		passed: failureReasons.length === 0,
		failureReasons,
		invalidPathIndexes,
	};
}

export interface PersistableScoredCase {
	caseId: string;
	metrics: GraphBenchmarkCaseMetrics;
	passed: boolean;
	inputTokens: number;
	outputTokens: number;
	latencyMs: number;
	costUsd: number;
}

function mean(values: number[]): number {
	return values.length === 0
		? 0
		: values.reduce((sum, value) => sum + value, 0) / values.length;
}

function p95(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

export function aggregateGraphRetrievalCases(
	results: PersistableScoredCase[],
): GraphBenchmarkAggregateMetrics {
	const metric = (key: keyof GraphBenchmarkCaseMetrics) =>
		mean(results.map((result) => result.metrics[key]));
	return {
		caseCount: results.length,
		passedCaseCount: results.filter((result) => result.passed).length,
		factRecall: metric("factRecall"),
		factPrecision: metric("factPrecision"),
		edgeRecall: metric("edgeRecall"),
		edgePrecision: metric("edgePrecision"),
		pathValidity: metric("pathValidity"),
		expectedPathCoverage: metric("expectedPathCoverage"),
		temporalAccuracy: metric("temporalAccuracy"),
		forbiddenFactRate: metric("forbiddenFactRate"),
		citationRecall: metric("citationRecall"),
		citationPrecision: metric("citationPrecision"),
		unsupportedInferenceRate: metric("unsupportedInferenceRate"),
		answerScore: metric("answerScore"),
		p95LatencyMs: p95(results.map((result) => result.latencyMs)),
		meanLatencyMs: mean(results.map((result) => result.latencyMs)),
		meanInputTokens: mean(results.map((result) => result.inputTokens)),
		meanOutputTokens: mean(results.map((result) => result.outputTokens)),
		meanCostUsd: mean(results.map((result) => result.costUsd)),
	};
}

export interface PairedGraphRetrievalMetrics {
	pairedCaseCount: number;
	answerScoreLift: number;
	factRecallLift: number;
	factPrecisionLift: number;
	edgeRecallLift: number;
	pathValidityLift: number;
	expectedPathCoverageLift: number;
	temporalAccuracyLift: number;
	unsupportedInferenceRateDelta: number;
	forbiddenFactRateDelta: number;
	p95LatencyMsDelta: number;
	meanTokenDelta: number;
	meanCostUsdDelta: number;
}

export function comparePairedGraphRetrievalCases(input: {
	baseline: PersistableScoredCase[];
	graph: PersistableScoredCase[];
}): {
	baseline: GraphBenchmarkAggregateMetrics;
	graph: GraphBenchmarkAggregateMetrics;
	paired: PairedGraphRetrievalMetrics;
	missingBaselineCaseIds: string[];
	missingGraphCaseIds: string[];
} {
	const baselineByCase = new Map(
		input.baseline.map((result) => [result.caseId, result]),
	);
	const graphByCase = new Map(
		input.graph.map((result) => [result.caseId, result]),
	);
	const pairedCaseIds = [...baselineByCase.keys()].filter((id) =>
		graphByCase.has(id),
	);
	const pairedBaseline = pairedCaseIds.map(
		(id) => baselineByCase.get(id) as PersistableScoredCase,
	);
	const pairedGraph = pairedCaseIds.map(
		(id) => graphByCase.get(id) as PersistableScoredCase,
	);
	const baseline = aggregateGraphRetrievalCases(pairedBaseline);
	const graph = aggregateGraphRetrievalCases(pairedGraph);
	return {
		baseline,
		graph,
		paired: {
			pairedCaseCount: pairedCaseIds.length,
			answerScoreLift: graph.answerScore - baseline.answerScore,
			factRecallLift: graph.factRecall - baseline.factRecall,
			factPrecisionLift: graph.factPrecision - baseline.factPrecision,
			edgeRecallLift: graph.edgeRecall - baseline.edgeRecall,
			pathValidityLift: graph.pathValidity - baseline.pathValidity,
			expectedPathCoverageLift:
				graph.expectedPathCoverage - baseline.expectedPathCoverage,
			temporalAccuracyLift: graph.temporalAccuracy - baseline.temporalAccuracy,
			unsupportedInferenceRateDelta:
				graph.unsupportedInferenceRate - baseline.unsupportedInferenceRate,
			forbiddenFactRateDelta:
				graph.forbiddenFactRate - baseline.forbiddenFactRate,
			p95LatencyMsDelta: graph.p95LatencyMs - baseline.p95LatencyMs,
			meanTokenDelta:
				graph.meanInputTokens +
				graph.meanOutputTokens -
				baseline.meanInputTokens -
				baseline.meanOutputTokens,
			meanCostUsdDelta: graph.meanCostUsd - baseline.meanCostUsd,
		},
		missingBaselineCaseIds: [...graphByCase.keys()].filter(
			(id) => !baselineByCase.has(id),
		),
		missingGraphCaseIds: [...baselineByCase.keys()].filter(
			(id) => !graphByCase.has(id),
		),
	};
}

export type GraphRetrievalGraduationMode = "answer_quality" | "retrieval_only";

export interface GraphRetrievalGraduationPolicy {
	mode: GraphRetrievalGraduationMode;
	minPairedCases: number;
	minAnswerScoreLift: number;
	minExpectedPathCoverageLift: number;
	minGraphExpectedPathCoverage: number;
	minGraphFactPrecision: number;
	minGraphEdgePrecision: number;
	minGraphPathValidity: number;
	minGraphTemporalAccuracy: number;
	maxGraphUnsupportedInferenceRate: number;
	maxGraphForbiddenFactRate: number;
	maxFactPrecisionRegression: number;
	maxP95LatencyRatio: number;
	minBaselineP95LatencyMsForRatio: number;
	maxRetrievalGraphP95LatencyMs: number;
	maxMeanTokenRatio: number;
	maxMeanCostRatio: number;
}

export const DEFAULT_GRAPH_RETRIEVAL_GRADUATION_POLICY: GraphRetrievalGraduationPolicy =
	{
		mode: "answer_quality",
		minPairedCases: 20,
		minAnswerScoreLift: 0.02,
		minExpectedPathCoverageLift: 0,
		minGraphExpectedPathCoverage: 1,
		minGraphFactPrecision: 1,
		minGraphEdgePrecision: 1,
		minGraphPathValidity: 1,
		minGraphTemporalAccuracy: 1,
		maxGraphUnsupportedInferenceRate: 0,
		maxGraphForbiddenFactRate: 0,
		maxFactPrecisionRegression: 0.01,
		maxP95LatencyRatio: 1.25,
		minBaselineP95LatencyMsForRatio: 5,
		maxRetrievalGraphP95LatencyMs: 500,
		maxMeanTokenRatio: 1.15,
		maxMeanCostRatio: 1.15,
	};

/**
 * Retrieval-only graduation deliberately excludes answer, token, and model-cost
 * gates. It still requires exact graph grounding and uses a measured baseline
 * latency ratio once that baseline is large enough to be stable. Sub-5ms
 * baselines are rounded/noisy at ledger precision, so they use a bounded
 * absolute graph latency instead.
 */
export const RETRIEVAL_ONLY_GRAPH_RETRIEVAL_GRADUATION_POLICY: GraphRetrievalGraduationPolicy =
	{
		...DEFAULT_GRAPH_RETRIEVAL_GRADUATION_POLICY,
		mode: "retrieval_only",
		minAnswerScoreLift: 0,
		// Graph expansion does more work than a single anchor lookup; cap the
		// measured penalty at 5x while retaining a 500ms interactive p95 ceiling.
		maxP95LatencyRatio: 5,
	};

function finite(value: number): boolean {
	return Number.isFinite(value);
}

function boundedRatio(candidate: number, baseline: number): number | null {
	if (
		!finite(candidate) ||
		!finite(baseline) ||
		candidate < 0 ||
		baseline < 0
	) {
		return null;
	}
	if (baseline === 0) return candidate === 0 ? 1 : null;
	return candidate / baseline;
}

export interface GraphRetrievalGraduationResult {
	passed: boolean;
	gates: GraphBenchmarkGraduationGates;
	reasons: string[];
	pairedMetrics: Record<string, number>;
}

function projectionIdentity(
	snapshot: GraphBenchmarkProjectionSnapshot | null,
): string | null {
	if (
		!snapshot ||
		!Number.isInteger(snapshot.persistedWatermark) ||
		typeof snapshot.projectionEpoch !== "string" ||
		snapshot.projectionEpoch.trim().length === 0
	) {
		return null;
	}
	return `${snapshot.projectionEpoch}@${snapshot.persistedWatermark}`;
}

/**
 * A benchmark can certify only the projection it actually exercised. Health
 * at evaluation time is insufficient if the D1 watermark/epoch moved after
 * the immutable run snapshot was captured.
 */
export function matchesCertifiedGraphBenchmarkProjectionSnapshot(
	immutable: GraphBenchmarkProjectionSnapshot | null,
	current: GraphBenchmarkProjectionSnapshot | null,
): boolean {
	return (
		immutable?.configured === true &&
		immutable.healthy === true &&
		immutable.passesGate === true &&
		current?.configured === true &&
		current.healthy === true &&
		current.passesGate === true &&
		projectionIdentity(immutable) !== null &&
		projectionIdentity(immutable) === projectionIdentity(current)
	);
}

/**
 * Fail-closed graduation. Missing snapshots, mismatched pairing, incomplete
 * runs, non-finite metrics, and zero-denominator regressions all fail rather
 * than being silently interpreted as green.
 */
export function evaluateGraphRetrievalGraduation(input: {
	suite: {
		status: "draft" | "locked" | "retired";
		split: "validation" | "locked_test" | "canary";
		caseCount: number;
	};
	pairIntegrity: {
		sameSuiteChecksum: boolean;
		sameModel: boolean;
		sameRetrievalPolicy: boolean;
		sameSeed: boolean;
		baselineCompleted: boolean;
		graphCompleted: boolean;
		baselineEligible: boolean;
		graphEligible: boolean;
		sameProjectionSnapshot: boolean;
		noMissingCases: boolean;
	};
	projection: GraphBenchmarkProjectionSnapshot | null;
	currentProjection: GraphBenchmarkProjectionSnapshot | null;
	baseline: GraphBenchmarkAggregateMetrics | null;
	graph: GraphBenchmarkAggregateMetrics | null;
	paired: PairedGraphRetrievalMetrics | null;
	mode?: GraphRetrievalGraduationMode;
	policy?: Partial<Omit<GraphRetrievalGraduationPolicy, "mode">>;
}): GraphRetrievalGraduationResult {
	const mode = input.mode ?? DEFAULT_GRAPH_RETRIEVAL_GRADUATION_POLICY.mode;
	const basePolicy =
		mode === "retrieval_only"
			? RETRIEVAL_ONLY_GRAPH_RETRIEVAL_GRADUATION_POLICY
			: DEFAULT_GRAPH_RETRIEVAL_GRADUATION_POLICY;
	const policy = {
		...basePolicy,
		...input.policy,
		mode,
	};
	const gates: GraphBenchmarkGraduationGates = {};
	const gate = (
		name: string,
		passed: boolean,
		actual: number | string | boolean | null,
		required: number | string | boolean,
	) => {
		gates[name] = { passed, actual, required };
	};

	gate("graduation_mode", true, mode, mode);
	gate(
		"locked_suite",
		input.suite.status === "locked",
		input.suite.status,
		"locked",
	);
	gate(
		"protected_split",
		input.suite.split === "locked_test" || input.suite.split === "canary",
		input.suite.split,
		"locked_test_or_canary",
	);
	for (const [name, value] of Object.entries(input.pairIntegrity)) {
		gate(`pair_${name}`, value, value, true);
	}
	gate(
		"projection_configured",
		input.projection?.configured === true,
		input.projection?.configured ?? null,
		true,
	);
	gate(
		"projection_healthy",
		input.projection?.healthy === true,
		input.projection?.healthy ?? null,
		true,
	);
	gate(
		"projection_passes_gate",
		input.projection?.passesGate === true,
		input.projection?.passesGate ?? null,
		true,
	);
	gate(
		"current_projection_passes_gate",
		input.currentProjection?.passesGate === true,
		input.currentProjection?.passesGate ?? null,
		true,
	);
	gate(
		"projection_snapshot_current",
		matchesCertifiedGraphBenchmarkProjectionSnapshot(
			input.projection,
			input.currentProjection,
		),
		projectionIdentity(input.currentProjection),
		projectionIdentity(input.projection) ?? "certified_projection_identity",
	);

	const baseline = input.baseline;
	const graph = input.graph;
	const paired = input.paired;
	const pairedCases = paired?.pairedCaseCount ?? 0;
	gate(
		"minimum_paired_cases",
		pairedCases >= policy.minPairedCases &&
			pairedCases === input.suite.caseCount,
		pairedCases,
		Math.max(policy.minPairedCases, input.suite.caseCount),
	);
	if (mode === "retrieval_only") {
		gate(
			"graph_all_cases_passed",
			graph !== null &&
				graph.caseCount === pairedCases &&
				graph.passedCaseCount === pairedCases,
			graph ? `${graph.passedCaseCount}/${graph.caseCount}` : null,
			`${pairedCases}/${pairedCases}`,
		);
	}

	const validAggregate =
		baseline !== null &&
		graph !== null &&
		paired !== null &&
		Object.values(baseline).every(
			(value) => typeof value !== "number" || finite(value),
		) &&
		Object.values(graph).every(
			(value) => typeof value !== "number" || finite(value),
		) &&
		Object.values(paired).every(
			(value) => typeof value !== "number" || finite(value),
		);
	gate("finite_complete_metrics", validAggregate, validAggregate, true);

	const answerLift = paired?.answerScoreLift ?? Number.NaN;
	const pathLift = paired?.expectedPathCoverageLift ?? Number.NaN;
	const factPrecisionRegression =
		baseline && graph
			? baseline.factPrecision - graph.factPrecision
			: Number.NaN;
	if (mode === "answer_quality") {
		gate(
			"answer_score_lift",
			finite(answerLift) && answerLift >= policy.minAnswerScoreLift,
			finite(answerLift) ? answerLift : null,
			policy.minAnswerScoreLift,
		);
	}
	gate(
		"expected_path_coverage_lift",
		finite(pathLift) && pathLift >= policy.minExpectedPathCoverageLift,
		finite(pathLift) ? pathLift : null,
		policy.minExpectedPathCoverageLift,
	);
	gate(
		"graph_expected_path_coverage",
		graph !== null &&
			finite(graph.expectedPathCoverage) &&
			graph.expectedPathCoverage >= policy.minGraphExpectedPathCoverage,
		graph?.expectedPathCoverage ?? null,
		policy.minGraphExpectedPathCoverage,
	);
	gate(
		"graph_fact_precision",
		graph !== null &&
			finite(graph.factPrecision) &&
			graph.factPrecision >= policy.minGraphFactPrecision,
		graph?.factPrecision ?? null,
		policy.minGraphFactPrecision,
	);
	gate(
		"graph_edge_precision",
		graph !== null &&
			finite(graph.edgePrecision) &&
			graph.edgePrecision >= policy.minGraphEdgePrecision,
		graph?.edgePrecision ?? null,
		policy.minGraphEdgePrecision,
	);
	gate(
		"graph_path_validity",
		graph !== null &&
			finite(graph.pathValidity) &&
			graph.pathValidity >= policy.minGraphPathValidity,
		graph?.pathValidity ?? null,
		policy.minGraphPathValidity,
	);
	gate(
		"graph_temporal_accuracy",
		graph !== null &&
			finite(graph.temporalAccuracy) &&
			graph.temporalAccuracy >= policy.minGraphTemporalAccuracy,
		graph?.temporalAccuracy ?? null,
		policy.minGraphTemporalAccuracy,
	);
	gate(
		"unsupported_inference",
		graph !== null &&
			finite(graph.unsupportedInferenceRate) &&
			graph.unsupportedInferenceRate <= policy.maxGraphUnsupportedInferenceRate,
		graph?.unsupportedInferenceRate ?? null,
		policy.maxGraphUnsupportedInferenceRate,
	);
	gate(
		"forbidden_fact_rate",
		graph !== null &&
			finite(graph.forbiddenFactRate) &&
			graph.forbiddenFactRate <= policy.maxGraphForbiddenFactRate,
		graph?.forbiddenFactRate ?? null,
		policy.maxGraphForbiddenFactRate,
	);
	gate(
		"fact_precision_regression",
		finite(factPrecisionRegression) &&
			factPrecisionRegression <= policy.maxFactPrecisionRegression,
		finite(factPrecisionRegression) ? factPrecisionRegression : null,
		policy.maxFactPrecisionRegression,
	);

	const latencyRatio =
		baseline && graph
			? boundedRatio(graph.p95LatencyMs, baseline.p95LatencyMs)
			: null;
	const tokenRatio =
		baseline && graph
			? boundedRatio(
					graph.meanInputTokens + graph.meanOutputTokens,
					baseline.meanInputTokens + baseline.meanOutputTokens,
				)
			: null;
	const costRatio =
		baseline && graph
			? boundedRatio(graph.meanCostUsd, baseline.meanCostUsd)
			: null;
	const measuredBaselineLatency =
		baseline !== null &&
		finite(baseline.p95LatencyMs) &&
		baseline.p95LatencyMs >= policy.minBaselineP95LatencyMsForRatio;
	const latencyActual = measuredBaselineLatency
		? latencyRatio
		: (graph?.p95LatencyMs ?? null);
	const latencyRequired = measuredBaselineLatency
		? policy.maxP95LatencyRatio
		: policy.maxRetrievalGraphP95LatencyMs;
	gate(
		"p95_latency_budget",
		mode === "retrieval_only"
			? latencyActual !== null &&
					finite(latencyActual) &&
					latencyActual <= latencyRequired
			: latencyRatio !== null && latencyRatio <= policy.maxP95LatencyRatio,
		mode === "retrieval_only" ? latencyActual : latencyRatio,
		mode === "retrieval_only" ? latencyRequired : policy.maxP95LatencyRatio,
	);
	if (mode === "retrieval_only") {
		gate(
			"retrieval_latency_basis",
			true,
			measuredBaselineLatency
				? "measured_baseline_ratio"
				: "absolute_graph_latency_ms",
			measuredBaselineLatency
				? "measured_baseline_ratio"
				: "absolute_graph_latency_ms",
		);
	} else {
		gate(
			"mean_token_budget",
			tokenRatio !== null && tokenRatio <= policy.maxMeanTokenRatio,
			tokenRatio,
			policy.maxMeanTokenRatio,
		);
		gate(
			"mean_cost_budget",
			costRatio !== null && costRatio <= policy.maxMeanCostRatio,
			costRatio,
			policy.maxMeanCostRatio,
		);
	}

	const reasons = Object.entries(gates)
		.filter(([, value]) => !value.passed)
		.map(
			([name, value]) =>
				`${name}: actual=${String(value.actual)} required=${String(value.required)}`,
		);
	return {
		passed: reasons.length === 0,
		gates,
		reasons,
		pairedMetrics: paired
			? Object.fromEntries(
					Object.entries(paired).filter(
						(entry): entry is [string, number] => typeof entry[1] === "number",
					),
				)
			: {},
	};
}
