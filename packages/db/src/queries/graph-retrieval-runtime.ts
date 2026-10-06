import { and, desc, eq, inArray } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import { graphProjectionReadiness } from "../schema/graph-projection";
import {
	graphRetrievalBenchmarkCases,
	graphRetrievalBenchmarkRuns,
	graphRetrievalGraduationEvaluations,
} from "../schema/graph-retrieval-benchmarks";
import { memoryEdges, memoryFacts } from "../schema/memory-graph";
import { chunkForBoundParams } from "../utils/batch";

/** D1 caps bound parameters at 100 per statement; keep IN() lists ≤50. */
const D1_IN_LIST_CHUNK = 50;

export async function getGraphProjectionReadinessSnapshot(
	db: DbClient,
	organizationId: string,
) {
	const [row] = await db
		.select()
		.from(graphProjectionReadiness)
		.where(eq(graphProjectionReadiness.organizationId, organizationId))
		.limit(1);
	return row ?? null;
}

export async function getGraphRetrievalBenchmarkCaseById(
	db: DbClient,
	input: { organizationId: string; caseId: string },
) {
	const [row] = await db
		.select()
		.from(graphRetrievalBenchmarkCases)
		.where(
			and(
				eq(graphRetrievalBenchmarkCases.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkCases.id, input.caseId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function listCanonicalBenchmarkFacts(
	db: DbClient,
	input: { organizationId: string; factIds: string[] },
) {
	if (input.factIds.length === 0) return [];
	const selectChunk = (chunk: string[]) =>
		db
			.select({
				id: memoryFacts.id,
				organizationId: memoryFacts.organizationId,
				validFrom: memoryFacts.validFrom,
				validTo: memoryFacts.validTo,
				archivedAt: memoryFacts.archivedAt,
			})
			.from(memoryFacts)
			.where(
				and(
					eq(memoryFacts.organizationId, input.organizationId),
					inArray(memoryFacts.id, chunk),
				),
			);
	const rows: Awaited<ReturnType<typeof selectChunk>> = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(input.factIds)],
		D1_IN_LIST_CHUNK,
	)) {
		rows.push(...(await selectChunk(chunk)));
	}
	return rows;
}

export async function listCanonicalBenchmarkEdges(
	db: DbClient,
	input: { organizationId: string; sourceFactIds: string[] },
) {
	if (input.sourceFactIds.length === 0) return [];
	const sourceFacts = alias(memoryFacts, "benchmark_source_facts");
	const targetFacts = alias(memoryFacts, "benchmark_target_facts");
	const selectChunk = (chunk: string[]) =>
		db
			.select({
				sourceFactId: memoryEdges.sourceFactId,
				targetFactId: memoryEdges.targetFactId,
				relationType: memoryEdges.relationType,
			})
			.from(memoryEdges)
			.innerJoin(
				sourceFacts,
				and(
					eq(sourceFacts.id, memoryEdges.sourceFactId),
					eq(sourceFacts.organizationId, input.organizationId),
				),
			)
			.innerJoin(
				targetFacts,
				and(
					eq(targetFacts.id, memoryEdges.targetFactId),
					eq(targetFacts.organizationId, input.organizationId),
				),
			)
			.where(inArray(memoryEdges.sourceFactId, chunk));
	const rows: Awaited<ReturnType<typeof selectChunk>> = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(input.sourceFactIds)],
		D1_IN_LIST_CHUNK,
	)) {
		rows.push(...(await selectChunk(chunk)));
	}
	return rows;
}

export async function getLatestGraphRetrievalPairEvaluation(
	db: DbClient,
	input: { organizationId: string; pairedRunKey: string },
) {
	const [graphRun] = await db
		.select({ id: graphRetrievalBenchmarkRuns.id })
		.from(graphRetrievalBenchmarkRuns)
		.where(
			and(
				eq(graphRetrievalBenchmarkRuns.organizationId, input.organizationId),
				eq(graphRetrievalBenchmarkRuns.pairedRunKey, input.pairedRunKey),
				eq(graphRetrievalBenchmarkRuns.variant, "graph"),
			),
		)
		.limit(1);
	if (!graphRun) return null;
	const [evaluation] = await db
		.select()
		.from(graphRetrievalGraduationEvaluations)
		.where(
			and(
				eq(
					graphRetrievalGraduationEvaluations.organizationId,
					input.organizationId,
				),
				eq(graphRetrievalGraduationEvaluations.graphRunId, graphRun.id),
			),
		)
		.orderBy(desc(graphRetrievalGraduationEvaluations.evaluatedAt))
		.limit(1);
	return evaluation ?? null;
}
