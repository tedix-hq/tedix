import {
	and,
	asc,
	desc,
	eq,
	gt,
	gte,
	inArray,
	isNotNull,
	or,
	sql,
} from "drizzle-orm";
import type { DbClient } from "../client";
import {
	kernelRuntimeEvents,
	kernelRuntimeRuns,
	tediRuntimeEvents,
} from "../schema/cognitive-runtime";
import { harnessSubjectEvalResults } from "../schema/harness-versions";
import { chunkForBoundParams } from "../utils/batch";

/** D1 caps bound parameters at 100 per statement; keep IN() lists ≤50. */
const D1_IN_LIST_CHUNK = 50;

export async function listSettledKernelRunsForEvaluation(
	db: DbClient,
	input: { organizationId: string; cutoff: string; limit: number },
) {
	return db
		.select({
			id: kernelRuntimeRuns.id,
			organizationId: kernelRuntimeRuns.organizationId,
			status: kernelRuntimeRuns.status,
			metadata: kernelRuntimeRuns.metadata,
			createdAt: kernelRuntimeRuns.createdAt,
			delegatedTediId: kernelRuntimeRuns.delegatedTediId,
			childRunId: kernelRuntimeRuns.childRunId,
		})
		.from(kernelRuntimeRuns)
		.where(
			and(
				eq(kernelRuntimeRuns.organizationId, input.organizationId),
				inArray(kernelRuntimeRuns.status, ["completed", "failed", "canceled"]),
				gte(kernelRuntimeRuns.createdAt, input.cutoff),
				isNotNull(kernelRuntimeRuns.metadata),
			),
		)
		.orderBy(desc(kernelRuntimeRuns.createdAt))
		.limit(input.limit);
}

export async function listExistingKernelEvalResultIds(
	db: DbClient,
	input: {
		organizationId: string;
		subjectId: string;
		harnessVersionId: string;
		limit: number;
	},
) {
	return db
		.select({ id: harnessSubjectEvalResults.id })
		.from(harnessSubjectEvalResults)
		.where(
			and(
				eq(harnessSubjectEvalResults.orgId, input.organizationId),
				eq(harnessSubjectEvalResults.subjectKind, "kernel"),
				eq(harnessSubjectEvalResults.subjectId, input.subjectId),
				eq(harnessSubjectEvalResults.harnessVersionId, input.harnessVersionId),
			),
		)
		.limit(input.limit);
}

/** A late base grade must not revive a run already corrected on a newer run.
 * One grouped row per requested run keeps the result bounded to the batch. */
export async function listCorrectedKernelRunIds(
	db: DbClient,
	input: { organizationId: string; runIds: string[] },
): Promise<string[]> {
	if (input.runIds.length === 0) return [];
	const metadata = harnessSubjectEvalResults.metadata;
	const runId = sql<string>`CASE WHEN json_valid(${metadata}) THEN json_extract(${metadata}, '$.runId') ELSE NULL END`;
	const source = sql<string>`CASE WHEN json_valid(${metadata}) THEN json_extract(${metadata}, '$.source') ELSE NULL END`;
	const corrected: string[] = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(input.runIds)],
		D1_IN_LIST_CHUNK,
	)) {
		const rows = await db
			.select({ runId })
			.from(harnessSubjectEvalResults)
			.where(
				and(
					eq(harnessSubjectEvalResults.orgId, input.organizationId),
					eq(harnessSubjectEvalResults.subjectKind, "kernel"),
					eq(
						harnessSubjectEvalResults.subjectId,
						`kernel:${input.organizationId}`,
					),
					sql`${source} = 'kernel-route-correction'`,
					inArray(runId, chunk),
				),
			)
			.groupBy(runId)
			.limit(chunk.length);
		corrected.push(...rows.map((row) => row.runId));
	}
	return corrected;
}

export async function listKernelEvaluationEvents(
	db: DbClient,
	input: {
		organizationId: string;
		runIds: string[];
		limitPerChunk?: number;
	},
) {
	if (input.runIds.length === 0) return [];
	const selectChunk = (chunk: string[]) =>
		db
			.select({
				runId: kernelRuntimeEvents.runId,
				kind: kernelRuntimeEvents.kind,
				payload: kernelRuntimeEvents.payload,
			})
			.from(kernelRuntimeEvents)
			.where(
				and(
					eq(kernelRuntimeEvents.organizationId, input.organizationId),
					inArray(kernelRuntimeEvents.runId, chunk),
				),
			);
	const rows: Awaited<ReturnType<typeof selectChunk>> = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(input.runIds)],
		D1_IN_LIST_CHUNK,
	)) {
		rows.push(
			...(input.limitPerChunk
				? await selectChunk(chunk).limit(input.limitPerChunk)
				: await selectChunk(chunk)),
		);
	}
	return rows;
}

/** Corrections are events on a NEW run, so the prior run's age cannot bound this read. */
export async function listKernelRouteCorrectionEvents(
	db: DbClient,
	input: {
		organizationId: string;
		cutoff: string;
		limit: number;
		after?: { createdAt: string; id: string };
	},
) {
	const validAction = sql`CASE WHEN json_valid(${kernelRuntimeEvents.payload}) THEN json_extract(${kernelRuntimeEvents.payload}, '$.action') ELSE NULL END`;
	return db
		.select({
			id: kernelRuntimeEvents.id,
			runId: kernelRuntimeEvents.runId,
			createdAt: kernelRuntimeEvents.createdAt,
			payload: kernelRuntimeEvents.payload,
		})
		.from(kernelRuntimeEvents)
		.where(
			and(
				eq(kernelRuntimeEvents.organizationId, input.organizationId),
				eq(kernelRuntimeEvents.kind, "decision.recorded"),
				gte(kernelRuntimeEvents.createdAt, input.cutoff),
				sql`${validAction} = 'kernel.route_corrected'`,
				input.after
					? or(
							gt(kernelRuntimeEvents.createdAt, input.after.createdAt),
							and(
								eq(kernelRuntimeEvents.createdAt, input.after.createdAt),
								gt(kernelRuntimeEvents.id, input.after.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(asc(kernelRuntimeEvents.createdAt), asc(kernelRuntimeEvents.id))
		.limit(input.limit);
}

/** Resolve even an old corrected run, with the organization fence on every id. */
export async function listKernelRunsForCorrection(
	db: DbClient,
	input: { organizationId: string; runIds: string[] },
) {
	if (input.runIds.length === 0) return [];
	const rows: Array<typeof kernelRuntimeRuns.$inferSelect> = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(input.runIds)],
		D1_IN_LIST_CHUNK,
	)) {
		rows.push(
			...(await db
				.select()
				.from(kernelRuntimeRuns)
				.where(
					and(
						eq(kernelRuntimeRuns.organizationId, input.organizationId),
						inArray(kernelRuntimeRuns.id, chunk),
					),
				)),
		);
	}
	return rows;
}

/** This rare correction lookup preserves the version and original grade history. */
export async function listKernelEvalResultsForPriorRun(
	db: DbClient,
	input: { organizationId: string; runId: string },
) {
	const runId = sql`CASE WHEN json_valid(${harnessSubjectEvalResults.metadata}) THEN json_extract(${harnessSubjectEvalResults.metadata}, '$.runId') ELSE NULL END`;
	return db
		.select()
		.from(harnessSubjectEvalResults)
		.where(
			and(
				eq(harnessSubjectEvalResults.orgId, input.organizationId),
				eq(harnessSubjectEvalResults.subjectKind, "kernel"),
				inArray(harnessSubjectEvalResults.subjectId, [
					`kernel:${input.organizationId}`,
					`tedi-selection:${input.organizationId}`,
				]),
				sql`${runId} = ${input.runId}`,
			),
		)
		.orderBy(
			asc(harnessSubjectEvalResults.createdAt),
			asc(harnessSubjectEvalResults.id),
		)
		.limit(40);
}

/** A correction revision may fall outside the bounded history window above. */
export async function getKernelCorrectionEvalRevision(
	db: DbClient,
	input: { organizationId: string; id: string },
) {
	return (
		await db
			.select()
			.from(harnessSubjectEvalResults)
			.where(
				and(
					eq(harnessSubjectEvalResults.orgId, input.organizationId),
					eq(harnessSubjectEvalResults.subjectKind, "kernel"),
					eq(harnessSubjectEvalResults.id, input.id),
				),
			)
			.limit(1)
	)[0];
}

export async function listChildTurnEvidenceEvents(
	db: DbClient,
	input: { organizationId: string; runIds: string[] },
) {
	if (input.runIds.length === 0) return [];
	const selectChunk = (chunk: string[]) =>
		db
			.select({
				runId: tediRuntimeEvents.runId,
				kind: tediRuntimeEvents.kind,
				payload: tediRuntimeEvents.payload,
				createdAt: tediRuntimeEvents.createdAt,
			})
			.from(tediRuntimeEvents)
			.where(
				and(
					eq(tediRuntimeEvents.organizationId, input.organizationId),
					inArray(tediRuntimeEvents.runId, chunk),
					inArray(tediRuntimeEvents.kind, [
						"tool.started",
						"message.completed",
					]),
				),
			);
	const rows: Awaited<ReturnType<typeof selectChunk>> = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(input.runIds)],
		D1_IN_LIST_CHUNK,
	)) {
		rows.push(...(await selectChunk(chunk)));
	}
	return rows;
}
