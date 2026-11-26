import type { KernelRuntimeRun } from "../schema/cognitive-runtime";
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
import { coreTable } from "../core-store/client";
import { anyIds, jsonRead } from "../core-store/dialect";
import {
	kernelRuntimeEvents,
	kernelRuntimeRuns,
	kernelRuntimeRunStoredColumns,
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
	const table = coreTable(db, kernelRuntimeRuns);
	return db
		.select({
			id: table.id,
			organizationId: table.organizationId,
			status: table.status,
			metadata: table.metadata,
			createdAt: table.createdAt,
			delegatedTediId: table.delegatedTediId,
			childRunId: table.childRunId,
		})
		.from(table)
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				inArray(table.status, ["completed", "failed", "canceled"]),
				gte(table.createdAt, input.cutoff),
				isNotNull(table.metadata),
			),
		)
		.orderBy(desc(table.createdAt))
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
	const table = coreTable(db, harnessSubjectEvalResults);
	return db
		.select({ id: table.id })
		.from(table)
		.where(
			and(
				eq(table.orgId, input.organizationId),
				eq(table.subjectKind, "kernel"),
				eq(table.subjectId, input.subjectId),
				eq(table.harnessVersionId, input.harnessVersionId),
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
	const table = coreTable(db, harnessSubjectEvalResults);
	const ids = [...new Set(input.runIds)];
	const metadata = table.metadata;
	const runId = sql<string>`${jsonRead(db, metadata, ["runId"])}`;
	const source = jsonRead(db, metadata, ["source"]);
	const rows = await db
		.select({ runId })
		.from(table)
		.where(
			and(
				eq(table.orgId, input.organizationId),
				eq(table.subjectKind, "kernel"),
				eq(table.subjectId, `kernel:${input.organizationId}`),
				sql`${source} = 'kernel-route-correction'`,
				anyIds(db, runId, ids),
			),
		)
		.groupBy(runId)
		.limit(ids.length);
	return rows.map((row) => row.runId);
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
	const table = coreTable(db, kernelRuntimeEvents);
	const selectChunk = (chunk: string[]) =>
		db
			.select({
				runId: table.runId,
				kind: table.kind,
				payload: table.payload,
			})
			.from(table)
			.where(
				and(
					eq(table.organizationId, input.organizationId),
					inArray(table.runId, chunk),
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
	const table = coreTable(db, kernelRuntimeEvents);
	const validAction = jsonRead(db, table.payload, ["action"]);
	return db
		.select({
			id: table.id,
			runId: table.runId,
			createdAt: table.createdAt,
			payload: table.payload,
		})
		.from(table)
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				eq(table.kind, "decision.recorded"),
				gte(table.createdAt, input.cutoff),
				sql`${validAction} = 'kernel.route_corrected'`,
				input.after
					? or(
							gt(table.createdAt, input.after.createdAt),
							and(
								eq(table.createdAt, input.after.createdAt),
								gt(table.id, input.after.id),
							),
						)
					: undefined,
			),
		)
		.orderBy(asc(table.createdAt), asc(table.id))
		.limit(input.limit);
}

/** Resolve even an old corrected run, with the organization fence on every id. */
export async function listKernelRunsForCorrection(
	db: DbClient,
	input: { organizationId: string; runIds: string[] },
) {
	if (input.runIds.length === 0) return [];
	const table = coreTable(db, kernelRuntimeRuns);
	return db
		.select(kernelRuntimeRunStoredColumns)
		.from(table)
		.where(
			and(
				eq(table.organizationId, input.organizationId),
				anyIds(db, table.id, [...new Set(input.runIds)]),
			),
		);
}

/** This rare correction lookup preserves the version and original grade history. */
export async function listKernelEvalResultsForPriorRun(
	db: DbClient,
	input: { organizationId: string; runId: string },
) {
	const table = coreTable(db, harnessSubjectEvalResults);
	const runId = sql<string>`${jsonRead(db, table.metadata, ["runId"])}`;
	return db
		.select()
		.from(table)
		.where(
			and(
				eq(table.orgId, input.organizationId),
				eq(table.subjectKind, "kernel"),
				inArray(table.subjectId, [
					`kernel:${input.organizationId}`,
					`tedi-selection:${input.organizationId}`,
				]),
				sql`${runId} = ${input.runId}`,
			),
		)
		.orderBy(asc(table.createdAt), asc(table.id))
		.limit(40);
}

/** A correction revision may fall outside the bounded history window above. */
export async function getKernelCorrectionEvalRevision(
	db: DbClient,
	input: { organizationId: string; id: string },
) {
	const table = coreTable(db, harnessSubjectEvalResults);
	return (
		await db
			.select()
			.from(table)
			.where(
				and(
					eq(table.orgId, input.organizationId),
					eq(table.subjectKind, "kernel"),
					eq(table.id, input.id),
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
	const table = coreTable(db, tediRuntimeEvents);
	const selectChunk = (chunk: string[]) =>
		db
			.select({
				runId: table.runId,
				kind: table.kind,
				payload: table.payload,
				createdAt: table.createdAt,
			})
			.from(table)
			.where(
				and(
					eq(table.organizationId, input.organizationId),
					inArray(table.runId, chunk),
					inArray(table.kind, ["tool.started", "message.completed"]),
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
