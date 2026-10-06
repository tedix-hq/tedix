import "@orpc/openapi/extensions/route";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import { JsonValueSchema } from "../schemas/common";

const OrganizationIdSchema = z.uuid().optional();
const UriSchema = z.string().trim().min(1).max(2000);

export const GraphBenchmarkEdgeSchema = z.object({
	sourceFactId: z.string().min(1).max(200),
	targetFactId: z.string().min(1).max(200),
	relationType: z.string().min(1).max(120),
});

export const GraphBenchmarkPathSchema = z
	.object({
		factIds: z.array(z.string().min(1).max(200)).min(1).max(20),
		edges: z.array(GraphBenchmarkEdgeSchema).max(19),
	})
	.refine((path) => path.edges.length === path.factIds.length - 1, {
		message: "Path edges must connect every adjacent fact exactly once",
		path: ["edges"],
	});

export const GraphBenchmarkProjectionSnapshotSchema = z.object({
	configured: z.boolean(),
	healthy: z.boolean(),
	passesGate: z.boolean(),
	state: z.string().optional(),
	projectionEpoch: z.string().nullable().optional(),
	persistedWatermark: z.number().int().nonnegative().optional(),
	gdsWatermark: z.number().int().nonnegative().optional(),
	gdsEpoch: z.string().nullable().optional(),
	nodeMismatchCount: z.number().int().nonnegative().nullable().optional(),
	edgeMismatchCount: z.number().int().nonnegative().nullable().optional(),
	lifecycleMismatchCount: z.number().int().nonnegative().nullable().optional(),
	entityCoverage: z.number().min(0).max(1).nullable().optional(),
	edgeCoverage: z.number().min(0).max(1).nullable().optional(),
	certifiedAt: z.string().nullable().optional(),
});

export const GraphBenchmarkCaseMetricsSchema = z.object({
	factRecall: z.number().min(0).max(1),
	factPrecision: z.number().min(0).max(1),
	edgeRecall: z.number().min(0).max(1),
	edgePrecision: z.number().min(0).max(1),
	pathValidity: z.number().min(0).max(1),
	expectedPathCoverage: z.number().min(0).max(1),
	temporalAccuracy: z.number().min(0).max(1),
	forbiddenFactRate: z.number().min(0).max(1),
	citationRecall: z.number().min(0).max(1),
	citationPrecision: z.number().min(0).max(1),
	unsupportedInferenceRate: z.number().min(0).max(1),
	answerScore: z.number().min(0).max(1),
});

export const GraphBenchmarkAggregateMetricsSchema =
	GraphBenchmarkCaseMetricsSchema.extend({
		caseCount: z.number().int().nonnegative(),
		passedCaseCount: z.number().int().nonnegative(),
		p95LatencyMs: z.number().nonnegative(),
		meanLatencyMs: z.number().nonnegative(),
		meanInputTokens: z.number().nonnegative(),
		meanOutputTokens: z.number().nonnegative(),
		meanCostUsd: z.number().nonnegative(),
	});

export const GraphRetrievalBenchmarkSuiteSchema = z.object({
	id: z.string().min(1),
	organizationId: z.string().min(1),
	name: z.string(),
	version: z.number().int().positive(),
	status: z.enum(["draft", "locked", "retired"]),
	split: z.enum(["validation", "locked_test", "canary"]),
	revision: z.number().int().nonnegative(),
	caseCount: z.number().int().nonnegative(),
	definitionChecksum: z.string().nullable(),
	sourceCommit: z.string().nullable(),
	artifactUri: z.string().nullable(),
	createdByType: z.enum([
		"user",
		"tedi",
		"service",
		"api_key",
		"external_agent",
		"system",
	]),
	createdById: z.string(),
	lockedAt: z.string().nullable(),
	retiredAt: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});

export const GraphRetrievalBenchmarkCaseSchema = z.object({
	id: z.string().min(1),
	organizationId: z.string().min(1),
	suiteId: z.string().min(1),
	suiteRevision: z.number().int().nonnegative(),
	caseKey: z.string(),
	query: z.string(),
	anchorFactIds: z.array(z.string()),
	expectedFactIds: z.array(z.string()),
	expectedEdges: z.array(GraphBenchmarkEdgeSchema),
	expectedPaths: z.array(GraphBenchmarkPathSchema),
	forbiddenFactIds: z.array(z.string()),
	validAt: z.string(),
	answerRubric: z.record(z.string(), JsonValueSchema),
	artifactUri: z.string().nullable(),
	tags: z.array(z.string()),
	difficulty: z.enum(["basic", "intermediate", "advanced", "adversarial"]),
	checksum: z.string(),
	createdAt: z.string(),
});

export const GraphRetrievalBenchmarkRunSchema = z.object({
	id: z.string().min(1),
	organizationId: z.string().min(1),
	suiteId: z.string().min(1),
	suiteChecksum: z.string(),
	pairedRunKey: z.string(),
	variant: z.enum(["baseline", "graph"]),
	retrievalPolicyVersion: z.string(),
	harnessVersionId: z.string().nullable(),
	modelProvider: z.string(),
	modelId: z.string(),
	modelVersion: z.string(),
	projectionSnapshot: GraphBenchmarkProjectionSnapshotSchema,
	seed: z.number().int(),
	status: z.enum(["running", "completed", "failed"]),
	caseCount: z.number().int().nonnegative(),
	aggregateMetrics: GraphBenchmarkAggregateMetricsSchema.nullable(),
	totalInputTokens: z.number().int().nonnegative(),
	totalOutputTokens: z.number().int().nonnegative(),
	totalLatencyMs: z.number().int().nonnegative(),
	totalCostUsd: z.number().nonnegative(),
	eligible: z.boolean(),
	traceArtifactUri: z.string().nullable(),
	failureReason: z.string().nullable(),
	startedAt: z.string(),
	completedAt: z.string().nullable(),
});

export const GraphRetrievalBenchmarkResultSchema = z.object({
	id: z.string().min(1),
	organizationId: z.string().min(1),
	runId: z.string().min(1),
	caseId: z.string().min(1),
	origin: z.enum(["manual", "builtin"]),
	retrievedFactIds: z.array(z.string()),
	returnedEdges: z.array(GraphBenchmarkEdgeSchema),
	returnedPaths: z.array(GraphBenchmarkPathSchema),
	answer: z.string().nullable(),
	citedFactIds: z.array(z.string()),
	claimSupport: z.array(
		z.object({
			claimId: z.string(),
			citedFactIds: z.array(z.string()),
		}),
	),
	metrics: GraphBenchmarkCaseMetricsSchema,
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	latencyMs: z.number().int().nonnegative(),
	costUsd: z.number().nonnegative(),
	passed: z.boolean(),
	failureReasons: z.array(z.string()),
	traceArtifactUri: z.string().nullable(),
	createdAt: z.string(),
});

export const GraphRetrievalGraduationEvaluationSchema = z.object({
	id: z.string().min(1),
	organizationId: z.string().min(1),
	suiteId: z.string().min(1),
	baselineRunId: z.string().min(1),
	graphRunId: z.string().min(1),
	evaluatorVersion: z.string(),
	passed: z.boolean(),
	gates: z.record(
		z.string(),
		z.object({
			passed: z.boolean(),
			actual: z.union([z.number(), z.string(), z.boolean()]).nullable(),
			required: z.union([z.number(), z.string(), z.boolean()]),
		}),
	),
	pairedMetrics: z.record(z.string(), z.number()),
	projectionSnapshot: GraphBenchmarkProjectionSnapshotSchema,
	reasons: z.array(z.string()),
	evaluatedAt: z.string(),
});

const CaseDefinitionInputSchema = z
	.object({
		organizationId: OrganizationIdSchema,
		suiteId: z.uuid(),
		clientCaseId: z.uuid(),
		expectedSuiteRevision: z.number().int().nonnegative(),
		caseKey: z.string().trim().min(1).max(160),
		query: z.string().trim().min(1).max(10_000),
		anchorFactIds: z.array(z.string().min(1).max(200)).max(20).default([]),
		expectedFactIds: z.array(z.string().min(1).max(200)).max(200).default([]),
		expectedEdges: z.array(GraphBenchmarkEdgeSchema).max(400).default([]),
		expectedPaths: z.array(GraphBenchmarkPathSchema).max(100).default([]),
		forbiddenFactIds: z.array(z.string().min(1).max(200)).max(200).default([]),
		validAt: z.iso.datetime(),
		answerRubric: z.record(z.string(), z.unknown()).default({}),
		artifactUri: UriSchema.optional(),
		tags: z.array(z.string().min(1).max(100)).max(50).default([]),
		difficulty: z
			.enum(["basic", "intermediate", "advanced", "adversarial"])
			.default("intermediate"),
	})
	.refine(
		(input) =>
			input.expectedFactIds.length > 0 ||
			input.expectedEdges.length > 0 ||
			input.expectedPaths.length > 0,
		{
			message: "A benchmark case must declare an expected fact, edge, or path",
			path: ["expectedFactIds"],
		},
	);

export const graphRetrievalBenchmarksContract = oc
	.route({
		tags: ["graph-retrieval-benchmarks"],
		prefix: "/graph-retrieval-benchmarks",
	})
	.errors(baseErrors)
	.router({
		createSuite: oc
			.route({
				method: "POST",
				path: "/suites",
				summary: "Create a draft graph-retrieval gold suite",
				description:
					"Creates an attributable draft. External agents may contribute evidence, but cannot lock or graduate it.",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					clientSuiteId: z.uuid(),
					name: z.string().trim().min(1).max(200),
					version: z.number().int().positive(),
					split: z.enum(["validation", "locked_test", "canary"]),
					sourceCommit: z.string().trim().min(1).max(200).optional(),
					artifactUri: UriSchema.optional(),
				}),
			)
			.output(GraphRetrievalBenchmarkSuiteSchema),

		addCase: oc
			.route({
				method: "POST",
				path: "/suites/{suiteId}/cases",
				summary: "Append an immutable server-checksummed gold case",
				description:
					"The case is immutable at D1. The server, not the caller, computes its definition checksum and advances the suite revision with CAS.",
				successStatus: 201,
			})
			.input(CaseDefinitionInputSchema)
			.output(GraphRetrievalBenchmarkCaseSchema),

		lockSuite: oc
			.route({
				method: "POST",
				path: "/suites/{suiteId}/lock",
				summary: "Authority-lock a benchmark suite",
				description:
					"Owner/admin/platform authority or an accountable admin-scoped tedi recomputes and seals the suite checksum server-side.",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					suiteId: z.uuid(),
					expectedRevision: z.number().int().positive(),
					minimumCaseCount: z.number().int().min(1).max(1000).default(20),
				}),
			)
			.output(GraphRetrievalBenchmarkSuiteSchema),

		getSuite: oc
			.route({
				method: "GET",
				path: "/suites/{suiteId}",
				summary: "Read a benchmark suite and its immutable cases",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					suiteId: z.uuid(),
				}),
			)
			.output(
				z.object({
					suite: GraphRetrievalBenchmarkSuiteSchema,
					cases: z.array(GraphRetrievalBenchmarkCaseSchema),
				}),
			),

		startPair: oc
			.route({
				method: "POST",
				path: "/suites/{suiteId}/paired-runs",
				summary: "Start a fixed retrieval-only baseline/graph pair",
				description:
					"Captures one server-derived certified projection snapshot for both variants with a fixed server-owned harness identity and seed. Every case must contain anchors and a nontrivial expected path.",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					suiteId: z.uuid(),
					baselineRunId: z.uuid(),
					graphRunId: z.uuid(),
					pairedRunKey: z.string().trim().min(1).max(200),
				}),
			)
			.output(
				z.object({
					mode: z.literal("retrieval_only_anchor_vs_neo4j_v1"),
					graduationMode: z.literal("retrieval_only"),
					answerMetricsEligible: z.literal(false),
					projectionSnapshot: GraphBenchmarkProjectionSnapshotSchema,
					baselineRun: GraphRetrievalBenchmarkRunSchema,
					graphRun: GraphRetrievalBenchmarkRunSchema,
				}),
			),

		recordObservation: oc
			.route({
				method: "POST",
				path: "/runs/{runId}/cases/{caseId}/observations",
				summary: "Record and server-score a retrieval observation",
				description:
					"Accepts retrieval outputs, never caller-computed quality metrics. D1 revalidates organization scope, temporal validity, facts, edges, and paths before immutable scoring.",
				successStatus: 201,
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					runId: z.uuid(),
					caseId: z.uuid(),
					clientObservationId: z.uuid(),
					retrievedFactIds: z.array(z.string().min(1).max(200)).max(500),
					returnedEdges: z
						.array(GraphBenchmarkEdgeSchema)
						.max(1000)
						.default([]),
					returnedPaths: z.array(GraphBenchmarkPathSchema).max(200).default([]),
					traceArtifactUri: UriSchema.optional(),
				}),
			)
			.output(
				z.object({
					evaluationScope: z.literal("retrieval_only"),
					answerMetricsEligible: z.literal(false),
					invalidPathIndexes: z.array(z.number().int().nonnegative()),
					result: GraphRetrievalBenchmarkResultSchema,
				}),
			),

		completeRun: oc
			.route({
				method: "POST",
				path: "/runs/{runId}/complete",
				summary: "Complete an immutable benchmark run",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					runId: z.uuid(),
					traceArtifactUri: UriSchema.optional(),
				}),
			)
			.output(GraphRetrievalBenchmarkRunSchema),

		executePair: oc
			.route({
				method: "POST",
				path: "/paired-runs/{pairedRunKey}/execute-retrieval",
				summary: "Execute deterministic anchor versus graph retrieval",
				description:
					"Runs anchor-only baseline and server-bounded Neo4j expansion over every locked case, then revalidates all graph output against canonical D1 before completion. Depth and fanout are fixed server policy, not caller inputs.",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					pairedRunKey: z.string().trim().min(1).max(200),
					baselineRunId: z.uuid(),
					graphRunId: z.uuid(),
				}),
			)
			.output(
				z.object({
					mode: z.literal("retrieval_only_anchor_vs_neo4j_v1"),
					graduationMode: z.literal("retrieval_only"),
					answerMetricsEligible: z.literal(false),
					baselineRun: GraphRetrievalBenchmarkRunSchema,
					graphRun: GraphRetrievalBenchmarkRunSchema,
				}),
			),

		evaluatePair: oc
			.route({
				method: "POST",
				path: "/paired-runs/{pairedRunKey}/graduation",
				summary: "Authority-evaluate and persist a graduation decision",
				description:
					"Rechecks the current certified projection watermark/epoch against the immutable run snapshot, evaluates the explicit retrieval-only fail-closed policy, and appends immutable authority evidence without claiming answer quality.",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					pairedRunKey: z.string().trim().min(1).max(200),
				}),
			)
			.output(GraphRetrievalGraduationEvaluationSchema),

		getRun: oc
			.route({
				method: "GET",
				path: "/runs/{runId}",
				summary: "Read a benchmark run and its immutable results",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					runId: z.uuid(),
				}),
			)
			.output(
				z.object({
					run: GraphRetrievalBenchmarkRunSchema,
					results: z.array(GraphRetrievalBenchmarkResultSchema),
				}),
			),

		getGate: oc
			.route({
				method: "GET",
				path: "/paired-runs/{pairedRunKey}/graduation",
				summary: "Read current projection state and persisted gate evidence",
			})
			.input(
				z.object({
					organizationId: OrganizationIdSchema,
					pairedRunKey: z.string().trim().min(1).max(200),
				}),
			)
			.output(
				z.object({
					currentProjection: GraphBenchmarkProjectionSnapshotSchema,
					evaluation: GraphRetrievalGraduationEvaluationSchema.nullable(),
				}),
			),
	});

export type GraphRetrievalBenchmarksContract =
	typeof graphRetrievalBenchmarksContract;
