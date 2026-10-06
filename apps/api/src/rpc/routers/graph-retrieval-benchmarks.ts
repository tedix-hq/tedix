import { implement } from "@orpc/server";
import { graphRetrievalBenchmarksContract } from "@tedix/api-contract/contracts/graph-retrieval-benchmarks";
import { isPlatformPrincipal } from "@tedix/auth/types";
import { type AuditActorType, insertAuditEvent } from "@tedix/db/queries/audit";
import {
	completeGraphRetrievalBenchmarkRun,
	getGraphRetrievalBenchmarkRun,
	getGraphRetrievalBenchmarkSuite,
	listGraphRetrievalBenchmarkCases,
	listGraphRetrievalBenchmarkResults,
} from "@tedix/db/queries/graph-retrieval-benchmarks";
import { getLatestGraphRetrievalPairEvaluation } from "@tedix/db/queries/graph-retrieval-runtime";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import { getTediById } from "@tedix/db/queries/tedis";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

const graphBenchmarkOs = implement(
	graphRetrievalBenchmarksContract,
).$context<BaseContext>();
const authed = graphBenchmarkOs.use(withAuth);
const loadGraphBenchmarkServices = () =>
	import("../../services/graph-retrieval-benchmarks");
const loadGraphBenchmarkHarness = () =>
	import("../../services/graph-retrieval-benchmark-harness");

type BenchmarkActor = {
	type: Exclude<AuditActorType, "anonymous" | "kernel" | "m2m">;
	id: string;
};

export function resolveGraphBenchmarkActor(
	context: BaseContext,
): BenchmarkActor {
	if (context.externalAgentPrincipalId) {
		return { type: "external_agent", id: context.externalAgentPrincipalId };
	}
	if (context.tediId) {
		return { type: "tedi", id: context.tediId };
	}
	if (context.authType === "user" && context.user?.sub) {
		return { type: "user", id: context.user.sub };
	}
	if (context.authType === "apikey" && context.apiKey?.id) {
		return { type: "api_key", id: context.apiKey.id };
	}
	if (context.serviceAccount?.clientId) {
		return { type: "service", id: context.serviceAccount.clientId };
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"A stable accountable principal is required for benchmark writes",
	);
}

export function resolveGraphBenchmarkOrganizationId(
	context: BaseContext,
	requestedOrganizationId?: string,
): string {
	const scopedOrganizationId =
		context.organizationId ?? context.apiKey?.organizationId;
	if (
		requestedOrganizationId &&
		scopedOrganizationId &&
		requestedOrganizationId !== scopedOrganizationId
	) {
		const crossOrgPlatformPrincipal =
			!context.externalAgentPrincipalId &&
			!context.tediId &&
			isPlatformPrincipal(context);
		if (!crossOrgPlatformPrincipal) {
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Benchmark access cannot cross the authenticated organization scope",
			);
		}
		return requestedOrganizationId;
	}
	const resolved = requestedOrganizationId ?? scopedOrganizationId;
	if (!resolved) {
		throw createError(
			ErrorCodes.UNAUTHORIZED,
			"Organization scope is required for graph benchmarks",
		);
	}
	return resolved;
}

async function requireGraphBenchmarkGovernanceActor(
	context: BaseContext,
	organizationId: string,
): Promise<BenchmarkActor> {
	const actor = resolveGraphBenchmarkActor(context);
	if (actor.type === "user") {
		if (isPlatformPrincipal(context)) return actor;
		const membership = await getMemberByUserId(
			context.db,
			organizationId,
			actor.id,
		);
		if (
			membership?.status === "active" &&
			(membership.role === "owner" || membership.role === "admin")
		) {
			return actor;
		}
	}
	if (actor.type === "tedi" && isPlatformPrincipal(context)) {
		const tedi = await getTediById(context.db, actor.id);
		if (tedi?.organizationId === organizationId && tedi.status === "active") {
			return actor;
		}
	}
	if (
		(actor.type === "api_key" || actor.type === "service") &&
		isPlatformPrincipal(context)
	) {
		return actor;
	}
	throw createError(
		ErrorCodes.FORBIDDEN,
		"Locking or graduating a graph benchmark requires an owner/admin, platform authority, or active admin-scoped tedi",
	);
}

async function recordBenchmarkAudit(
	context: BaseContext,
	input: {
		organizationId: string;
		actor: BenchmarkActor;
		action: string;
		resourceType: string;
		resourceId: string;
		metadata?: Record<string, unknown>;
	},
): Promise<void> {
	const { GRAPH_RETRIEVAL_HARNESS_MODE } = await loadGraphBenchmarkHarness();
	await insertAuditEvent(context.db, {
		organizationId: input.organizationId,
		actorType: input.actor.type,
		actorId: input.actor.id,
		action: input.action,
		resourceType: input.resourceType,
		resourceId: input.resourceId,
		metadata: {
			...input.metadata,
			externalAgentSessionId: context.externalAgentSessionId ?? null,
			harnessMode: GRAPH_RETRIEVAL_HARNESS_MODE,
		},
		ipAddress: context.headers.get("CF-Connecting-IP"),
		userAgent: context.headers.get("User-Agent"),
	});
}

function rethrowGraphBenchmarkError(error: unknown): never {
	if (
		error instanceof Error &&
		(error.name === "GraphRetrievalBenchmarkServiceError" ||
			error.name === "GraphRetrievalBenchmarkError")
	) {
		const reason = (error as Error & { reason?: string }).reason;
		switch (reason) {
			case "not_found":
			case "run_not_found":
			case "suite_not_found":
				throw createError(ErrorCodes.NOT_FOUND, error.message);
			case "projection_not_ready":
				throw createError(ErrorCodes.CONFLICT, error.message);
			case "invalid_case":
			case "invalid_pair":
			case "suite_not_locked":
			case "suite_retired":
				throw createError(ErrorCodes.BAD_REQUEST, error.message);
			default:
				throw createError(ErrorCodes.CONFLICT, error.message);
		}
	}
	throw error;
}

const createSuite = authed.createSuite
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const organizationId = resolveGraphBenchmarkOrganizationId(
			context,
			input.organizationId,
		);
		const actor = resolveGraphBenchmarkActor(context);
		try {
			const { createDraftGraphBenchmark } = await loadGraphBenchmarkServices();
			const suite = await createDraftGraphBenchmark(context.db, {
				id: input.clientSuiteId,
				organizationId,
				name: input.name,
				version: input.version,
				split: input.split,
				sourceCommit: input.sourceCommit,
				artifactUri: input.artifactUri,
				actor,
				now: new Date().toISOString(),
			});
			await recordBenchmarkAudit(context, {
				organizationId,
				actor,
				action: "graph_benchmark.suite.created",
				resourceType: "graph_retrieval_benchmark_suite",
				resourceId: suite.id,
				metadata: { version: suite.version, split: suite.split },
			});
			return suite;
		} catch (error) {
			rethrowGraphBenchmarkError(error);
		}
	});

const addCase = authed.addCase
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const organizationId = resolveGraphBenchmarkOrganizationId(
			context,
			input.organizationId,
		);
		const actor = resolveGraphBenchmarkActor(context);
		try {
			const { addServerChecksummedGraphBenchmarkCase } =
				await loadGraphBenchmarkServices();
			const benchmarkCase = await addServerChecksummedGraphBenchmarkCase(
				context.db,
				{
					id: input.clientCaseId,
					organizationId,
					suiteId: input.suiteId,
					expectedSuiteRevision: input.expectedSuiteRevision,
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
					now: new Date().toISOString(),
				},
			);
			await recordBenchmarkAudit(context, {
				organizationId,
				actor,
				action: "graph_benchmark.case.appended",
				resourceType: "graph_retrieval_benchmark_suite",
				resourceId: input.suiteId,
				metadata: {
					caseId: benchmarkCase.id,
					caseKey: benchmarkCase.caseKey,
					checksum: benchmarkCase.checksum,
					suiteRevision: benchmarkCase.suiteRevision,
				},
			});
			return benchmarkCase;
		} catch (error) {
			rethrowGraphBenchmarkError(error);
		}
	});

const lockSuite = authed.lockSuite
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const organizationId = resolveGraphBenchmarkOrganizationId(
			context,
			input.organizationId,
		);
		const actor = await requireGraphBenchmarkGovernanceActor(
			context,
			organizationId,
		);
		try {
			const { lockServerChecksummedGraphBenchmarkSuite } =
				await loadGraphBenchmarkServices();
			const suite = await lockServerChecksummedGraphBenchmarkSuite(context.db, {
				organizationId,
				suiteId: input.suiteId,
				expectedRevision: input.expectedRevision,
				minimumCaseCount: input.minimumCaseCount,
				now: new Date().toISOString(),
			});
			await recordBenchmarkAudit(context, {
				organizationId,
				actor,
				action: "graph_benchmark.suite.locked",
				resourceType: "graph_retrieval_benchmark_suite",
				resourceId: suite.id,
				metadata: {
					caseCount: suite.caseCount,
					definitionChecksum: suite.definitionChecksum,
				},
			});
			return suite;
		} catch (error) {
			rethrowGraphBenchmarkError(error);
		}
	});

const getSuite = authed.getSuite
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const organizationId = resolveGraphBenchmarkOrganizationId(
			context,
			input.organizationId,
		);
		const [suite, cases] = await Promise.all([
			getGraphRetrievalBenchmarkSuite(context.db, {
				organizationId,
				suiteId: input.suiteId,
			}),
			listGraphRetrievalBenchmarkCases(context.db, {
				organizationId,
				suiteId: input.suiteId,
				limit: 1000,
			}),
		]);
		if (!suite)
			throw createError(ErrorCodes.NOT_FOUND, "Benchmark suite not found");
		return { suite, cases };
	});

const startPair = authed.startPair
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const organizationId = resolveGraphBenchmarkOrganizationId(
			context,
			input.organizationId,
		);
		const actor = resolveGraphBenchmarkActor(context);
		try {
			const { startGraphBenchmarkPair } = await loadGraphBenchmarkServices();
			const {
				GRAPH_RETRIEVAL_GRADUATION_MODE,
				GRAPH_RETRIEVAL_HARNESS_MODE,
				GRAPH_RETRIEVAL_SEED,
			} = await loadGraphBenchmarkHarness();
			const pair = await startGraphBenchmarkPair(context.db, context.env, {
				organizationId,
				suiteId: input.suiteId,
				baselineRunId: input.baselineRunId,
				graphRunId: input.graphRunId,
				pairedRunKey: input.pairedRunKey,
				now: new Date().toISOString(),
			});
			await recordBenchmarkAudit(context, {
				organizationId,
				actor,
				action: "graph_benchmark.pair.started",
				resourceType: "graph_retrieval_benchmark_pair",
				resourceId: input.pairedRunKey,
				metadata: {
					suiteId: input.suiteId,
					baselineRunId: pair.baselineRun.id,
					graphRunId: pair.graphRun.id,
					seed: GRAPH_RETRIEVAL_SEED,
					projectionSnapshot: pair.projectionSnapshot,
				},
			});
			return {
				mode: GRAPH_RETRIEVAL_HARNESS_MODE,
				graduationMode: GRAPH_RETRIEVAL_GRADUATION_MODE,
				answerMetricsEligible: false as const,
				...pair,
			};
		} catch (error) {
			rethrowGraphBenchmarkError(error);
		}
	});

const recordObservation = authed.recordObservation
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const organizationId = resolveGraphBenchmarkOrganizationId(
			context,
			input.organizationId,
		);
		const actor = resolveGraphBenchmarkActor(context);
		try {
			const { scoreAndRecordRetrievalOnlyObservation } =
				await loadGraphBenchmarkServices();
			const scored = await scoreAndRecordRetrievalOnlyObservation(
				context.db,
				context.env,
				{
					organizationId,
					runId: input.runId,
					caseId: input.caseId,
					observationId: input.clientObservationId,
					origin: "manual",
					observation: {
						retrievedFactIds: input.retrievedFactIds,
						returnedEdges: input.returnedEdges,
						returnedPaths: input.returnedPaths,
					},
					traceArtifactUri: input.traceArtifactUri,
					now: new Date().toISOString(),
				},
			);
			await recordBenchmarkAudit(context, {
				organizationId,
				actor,
				action: "graph_benchmark.observation.recorded",
				resourceType: "graph_retrieval_benchmark_run",
				resourceId: input.runId,
				metadata: {
					caseId: input.caseId,
					observationId: scored.result.id,
					passedRetrievalThresholds: scored.result.passed,
				},
			});
			return {
				evaluationScope: "retrieval_only" as const,
				answerMetricsEligible: false as const,
				...scored,
			};
		} catch (error) {
			rethrowGraphBenchmarkError(error);
		}
	});

const completeRun = authed.completeRun
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const organizationId = resolveGraphBenchmarkOrganizationId(
			context,
			input.organizationId,
		);
		const actor = resolveGraphBenchmarkActor(context);
		try {
			const run = await completeGraphRetrievalBenchmarkRun(context.db, {
				organizationId,
				runId: input.runId,
				traceArtifactUri: input.traceArtifactUri,
				completedAt: new Date().toISOString(),
			});
			await recordBenchmarkAudit(context, {
				organizationId,
				actor,
				action: "graph_benchmark.run.completed",
				resourceType: "graph_retrieval_benchmark_run",
				resourceId: run.id,
				metadata: { variant: run.variant, caseCount: run.caseCount },
			});
			return run;
		} catch (error) {
			rethrowGraphBenchmarkError(error);
		}
	});

const executePair = authed.executePair
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const organizationId = resolveGraphBenchmarkOrganizationId(
			context,
			input.organizationId,
		);
		const actor = resolveGraphBenchmarkActor(context);
		try {
			const { executeRetrievalOnlyGraphBenchmarkPair } =
				await loadGraphBenchmarkServices();
			const {
				GRAPH_RETRIEVAL_GRADUATION_MODE,
				GRAPH_RETRIEVAL_HARNESS_MODE,
				GRAPH_RETRIEVAL_MAX_DEPTH,
				GRAPH_RETRIEVAL_MAX_NODES_PER_ANCHOR,
			} = await loadGraphBenchmarkHarness();
			const pair = await executeRetrievalOnlyGraphBenchmarkPair(
				context.db,
				context.env,
				{
					organizationId,
					pairedRunKey: input.pairedRunKey,
					baselineRunId: input.baselineRunId,
					graphRunId: input.graphRunId,
					now: new Date().toISOString(),
				},
			);
			await recordBenchmarkAudit(context, {
				organizationId,
				actor,
				action: "graph_benchmark.pair.executed",
				resourceType: "graph_retrieval_benchmark_pair",
				resourceId: input.pairedRunKey,
				metadata: {
					baselineRunId: pair.baselineRun.id,
					graphRunId: pair.graphRun.id,
					maxDepth: GRAPH_RETRIEVAL_MAX_DEPTH,
					maxNodesPerAnchor: GRAPH_RETRIEVAL_MAX_NODES_PER_ANCHOR,
					answerMetricsEligible: false,
				},
			});
			return {
				mode: GRAPH_RETRIEVAL_HARNESS_MODE,
				graduationMode: GRAPH_RETRIEVAL_GRADUATION_MODE,
				answerMetricsEligible: false as const,
				...pair,
			};
		} catch (error) {
			rethrowGraphBenchmarkError(error);
		}
	});

const evaluatePair = authed.evaluatePair
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const organizationId = resolveGraphBenchmarkOrganizationId(
			context,
			input.organizationId,
		);
		const actor = await requireGraphBenchmarkGovernanceActor(
			context,
			organizationId,
		);
		try {
			const { evaluateAndRecordGraphBenchmarkGraduation } =
				await loadGraphBenchmarkServices();
			const evaluation = await evaluateAndRecordGraphBenchmarkGraduation(
				context.db,
				context.env,
				{
					organizationId,
					pairedRunKey: input.pairedRunKey,
					now: new Date().toISOString(),
				},
			);
			await recordBenchmarkAudit(context, {
				organizationId,
				actor,
				action: "graph_benchmark.graduation.recorded",
				resourceType: "graph_retrieval_benchmark_pair",
				resourceId: input.pairedRunKey,
				metadata: {
					evaluationId: evaluation.id,
					passed: evaluation.passed,
					reasons: evaluation.reasons,
				},
			});
			return evaluation;
		} catch (error) {
			rethrowGraphBenchmarkError(error);
		}
	});

const getRun = authed.getRun
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const organizationId = resolveGraphBenchmarkOrganizationId(
			context,
			input.organizationId,
		);
		const [run, results] = await Promise.all([
			getGraphRetrievalBenchmarkRun(context.db, {
				organizationId,
				runId: input.runId,
			}),
			listGraphRetrievalBenchmarkResults(context.db, {
				organizationId,
				runId: input.runId,
				limit: 2000,
			}),
		]);
		if (!run)
			throw createError(ErrorCodes.NOT_FOUND, "Benchmark run not found");
		return { run, results };
	});

const getGate = authed.getGate
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		const organizationId = resolveGraphBenchmarkOrganizationId(
			context,
			input.organizationId,
		);
		const { readGraphBenchmarkProjectionSnapshot } =
			await loadGraphBenchmarkServices();
		const [currentProjection, evaluation] = await Promise.all([
			readGraphBenchmarkProjectionSnapshot(
				context.db,
				context.env,
				organizationId,
			),
			getLatestGraphRetrievalPairEvaluation(context.db, {
				organizationId,
				pairedRunKey: input.pairedRunKey,
			}),
		]);
		return { currentProjection, evaluation };
	});

export const graphRetrievalBenchmarksContractRouter = graphBenchmarkOs.router({
	createSuite,
	addCase,
	lockSuite,
	getSuite,
	startPair,
	recordObservation,
	completeRun,
	executePair,
	evaluatePair,
	getRun,
	getGate,
});

export type GraphRetrievalBenchmarksContractRouter =
	typeof graphRetrievalBenchmarksContractRouter;
