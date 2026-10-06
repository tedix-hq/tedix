import type {
	HarnessEvalResult,
	HarnessEvalRun,
	HarnessEvalSummary,
	HarnessSubjectEvalResult,
	HarnessSubjectEvalRun,
} from "@tedix/api-contract/schemas/harness-version";
import { DEFAULT_EVAL_LANE } from "@tedix/api-contract/schemas/harness-version";
import { and, desc, eq } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type HarnessEvalResultRow,
	type HarnessEvalRunRow,
	type HarnessSubjectEvalResultRow,
	type HarnessSubjectEvalRunRow,
	harnessEvalResults,
	harnessEvalRuns,
	harnessVersions,
	harnessSubjectEvalResults,
	harnessSubjectEvalRuns,
} from "../../schema/harness-versions";
import { tedis } from "../../schema/tedis";
import { optionalJsonObject } from "./persistence-json";
import type { HarnessSubjectRef } from "./subjects";
import { effectiveKernelEvalRows } from "./effective-kernel-evals";

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Roll an ordered (newest-first) list of eval results for ONE harness version
 * into the `HarnessEvalSummary` shape the promotion gate reads. Pure — exported
 * so it can be unit-tested without D1. Lanes with a null/empty `lane` collapse
 * to `DEFAULT_EVAL_LANE`. `latestPassByLane` reflects the most recent eval per
 * lane (input MUST be sorted newest-first).
 */
export function summarizeEvalResults(
	harnessVersionId: string,
	resultsNewestFirst: readonly Pick<
		HarnessEvalResultRow,
		"passed" | "lane" | "score" | "createdAt"
	>[],
): HarnessEvalSummary {
	let passedCount = 0;
	let failedCount = 0;
	const lanes: string[] = [];
	const latestPassByLane: Record<string, boolean> = {};

	for (const r of resultsNewestFirst) {
		if (r.passed) passedCount++;
		else failedCount++;
		const lane = r.lane && r.lane.length > 0 ? r.lane : DEFAULT_EVAL_LANE;
		if (!(lane in latestPassByLane)) {
			// First time we see a lane (newest-first) is its latest eval.
			latestPassByLane[lane] = r.passed;
			lanes.push(lane);
		}
	}

	const latest = resultsNewestFirst[0];
	return {
		harnessVersionId,
		total: resultsNewestFirst.length,
		passedCount,
		failedCount,
		latestScore: latest ? latest.score : null,
		latestCreatedAt: latest ? latest.createdAt : null,
		lanes,
		latestPassByLane,
	};
}

export interface ListEvalResultsOptions {
	harnessVersionId?: string;
	tediId?: string;
	limit?: number;
}

/**
 * Eval results filtered by harness version and/or tedi, newest first. At least
 * one of `harnessVersionId` / `tediId` SHOULD be supplied; with neither, this
 * returns the most recent results across all tedis (bounded by `limit`).
 */
export async function listEvalResults(
	db: DbClient,
	options: ListEvalResultsOptions,
): Promise<HarnessEvalResultRow[]> {
	const conditions = [];
	if (options.harnessVersionId) {
		conditions.push(
			eq(harnessEvalResults.harnessVersionId, options.harnessVersionId),
		);
	}
	if (options.tediId) {
		conditions.push(eq(harnessEvalResults.tediId, options.tediId));
	}
	const base = db.select().from(harnessEvalResults);
	const filtered =
		conditions.length > 0 ? base.where(and(...conditions)) : base;
	const rows = await filtered
		.orderBy(desc(harnessEvalResults.createdAt))
		.limit(options.limit ?? 50);
	return rows;
}

/**
 * Aggregate the full eval ledger for one harness version into a
 * `HarnessEvalSummary` (the shape `evalGateForCertification` reads). Pulls all
 * results for the version newest-first, then folds via `summarizeEvalResults`.
 */
export async function getEvalSummaryForVersion(
	db: DbClient,
	harnessVersionId: string,
): Promise<HarnessEvalSummary> {
	const rows = await db
		.select()
		.from(harnessEvalResults)
		.where(eq(harnessEvalResults.harnessVersionId, harnessVersionId))
		.orderBy(desc(harnessEvalResults.createdAt));
	return summarizeEvalResults(harnessVersionId, rows);
}

/**
 * Insert one eval result. Conflict-do-nothing on `id` so a retried emission
 * (the eval runner emits via durable retries) is idempotent. Callers pass a
 * stable `id` (e.g. `her_{harnessVersionId}_{lane}_{runId}`).
 */
export async function recordEvalResult(
	db: DbClient,
	result: HarnessEvalResult,
): Promise<boolean> {
	const version = (
		await db
			.select({
				id: harnessVersions.id,
				tediId: harnessVersions.tediId,
				orgId: harnessVersions.orgId,
			})
			.from(harnessVersions)
			.where(eq(harnessVersions.id, result.harnessVersionId))
			.limit(1)
	)[0];
	const tedi = (
		await db
			.select({ organizationId: tedis.organizationId })
			.from(tedis)
			.where(eq(tedis.id, result.tediId))
			.limit(1)
	)[0];
	if (
		!version ||
		!tedi ||
		tedi.organizationId !== (result.orgId ?? null) ||
		version.tediId !== result.tediId ||
		(version.orgId !== null && version.orgId !== (result.orgId ?? null))
	) {
		return false;
	}
	await db
		.insert(harnessEvalResults)
		.values({
			id: result.id,
			harnessVersionId: result.harnessVersionId,
			tediId: result.tediId,
			orgId: result.orgId ?? null,
			score: result.score,
			gates: result.gates ?? {},
			passed: result.passed,
			lane: result.lane ?? null,
			taskSetId: result.taskSetId ?? null,
			metadata:
				optionalJsonObject(result.metadata, "harness_eval_results.metadata") ??
				null,
			createdAt: result.createdAt,
		})
		.onConflictDoNothing({ target: harnessEvalResults.id });
	const expectedMetadata =
		optionalJsonObject(result.metadata, "harness_eval_results.metadata") ??
		null;
	const persisted = (
		await db
			.select()
			.from(harnessEvalResults)
			.where(eq(harnessEvalResults.id, result.id))
			.limit(1)
	)[0];
	return (
		persisted?.harnessVersionId === result.harnessVersionId &&
		persisted.tediId === result.tediId &&
		persisted.orgId === (result.orgId ?? null) &&
		persisted.score === result.score &&
		sameJson(persisted.gates, result.gates ?? {}) &&
		persisted.passed === result.passed &&
		persisted.lane === (result.lane ?? null) &&
		persisted.taskSetId === (result.taskSetId ?? null) &&
		sameJson(persisted.metadata, expectedMetadata) &&
		persisted.createdAt === result.createdAt
	);
}

// ============================================================================
// Eval runs (grouping) + promotion workflow
// ============================================================================

/** Insert an eval run. Conflict-do-nothing on PK so a retried record is idempotent. */
export async function recordEvalRun(
	db: DbClient,
	run: HarnessEvalRun,
): Promise<boolean> {
	const version = (
		await db
			.select({
				id: harnessVersions.id,
				tediId: harnessVersions.tediId,
				orgId: harnessVersions.orgId,
			})
			.from(harnessVersions)
			.where(eq(harnessVersions.id, run.harnessVersionId))
			.limit(1)
	)[0];
	const tedi = (
		await db
			.select({ organizationId: tedis.organizationId })
			.from(tedis)
			.where(eq(tedis.id, run.tediId))
			.limit(1)
	)[0];
	if (
		!version ||
		!tedi ||
		tedi.organizationId !== (run.orgId ?? null) ||
		version.tediId !== run.tediId ||
		(version.orgId !== null && version.orgId !== (run.orgId ?? null))
	) {
		return false;
	}
	await db
		.insert(harnessEvalRuns)
		.values({
			id: run.id,
			harnessVersionId: run.harnessVersionId,
			tediId: run.tediId,
			orgId: run.orgId ?? null,
			lane: run.lane,
			taskSetId: run.taskSetId,
			total: run.total,
			passed: run.passed,
			failed: run.failed,
			meanScore: run.meanScore,
			eligible: run.eligible,
			report: run.report ?? null,
			metadata:
				optionalJsonObject(run.metadata, "harness_eval_runs.metadata") ?? null,
			createdAt: run.createdAt,
		})
		.onConflictDoNothing({ target: harnessEvalRuns.id });
	const expectedMetadata =
		optionalJsonObject(run.metadata, "harness_eval_runs.metadata") ?? null;
	const persisted = (
		await db
			.select()
			.from(harnessEvalRuns)
			.where(eq(harnessEvalRuns.id, run.id))
			.limit(1)
	)[0];
	return (
		persisted?.harnessVersionId === run.harnessVersionId &&
		persisted.tediId === run.tediId &&
		persisted.orgId === (run.orgId ?? null) &&
		persisted.lane === run.lane &&
		persisted.taskSetId === run.taskSetId &&
		persisted.total === run.total &&
		persisted.passed === run.passed &&
		persisted.failed === run.failed &&
		persisted.meanScore === run.meanScore &&
		persisted.eligible === run.eligible &&
		sameJson(persisted.report, run.report ?? null) &&
		sameJson(persisted.metadata, expectedMetadata) &&
		persisted.createdAt === run.createdAt
	);
}

/** Eval runs for one tedi, newest first, optionally filtered by version. */
export async function listEvalRuns(
	db: DbClient,
	input: { tediId: string; harnessVersionId?: string; limit?: number },
): Promise<HarnessEvalRunRow[]> {
	const where = input.harnessVersionId
		? and(
				eq(harnessEvalRuns.tediId, input.tediId),
				eq(harnessEvalRuns.harnessVersionId, input.harnessVersionId),
			)
		: eq(harnessEvalRuns.tediId, input.tediId);
	const rows = await db
		.select()
		.from(harnessEvalRuns)
		.where(where)
		.orderBy(desc(harnessEvalRuns.createdAt))
		.limit(input.limit ?? 50);
	return rows;
}
// ============================================================================
// Subject-keyed eval results + runs (kernel / non-tedi actors)
// ============================================================================

/**
 * Insert one subject eval result. Conflict-do-nothing on `id` so a retried
 * emission is idempotent. Callers pass a stable id like `kser:{harnessVersionId}:{runId}`.
 */
export async function recordSubjectEvalResult(
	db: DbClient,
	result: HarnessSubjectEvalResult,
): Promise<void> {
	await db
		.insert(harnessSubjectEvalResults)
		.values({
			id: result.id,
			subjectKind: result.subjectKind,
			subjectId: result.subjectId,
			tediId: result.tediId ?? null,
			orgId: result.orgId ?? null,
			harnessVersionId: result.harnessVersionId,
			score: result.score,
			gates: result.gates ?? {},
			passed: result.passed,
			lane: result.lane ?? null,
			taskSetId: result.taskSetId ?? null,
			metadata:
				optionalJsonObject(
					result.metadata,
					"harness_subject_eval_results.metadata",
				) ?? null,
			createdAt: result.createdAt,
		})
		.onConflictDoNothing({ target: harnessSubjectEvalResults.id });
}

/** Insert one subject eval run and reject a retry whose immutable payload changed. */
export async function recordSubjectEvalRun(
	db: DbClient,
	run: HarnessSubjectEvalRun,
): Promise<boolean> {
	await db
		.insert(harnessSubjectEvalRuns)
		.values({
			id: run.id,
			subjectKind: run.subjectKind,
			subjectId: run.subjectId,
			tediId: run.tediId ?? null,
			orgId: run.orgId ?? null,
			harnessVersionId: run.harnessVersionId,
			lane: run.lane,
			taskSetId: run.taskSetId,
			total: run.total,
			passed: run.passed,
			failed: run.failed,
			meanScore: run.meanScore,
			eligible: run.eligible,
			report: run.report ?? null,
			metadata:
				optionalJsonObject(
					run.metadata,
					"harness_subject_eval_runs.metadata",
				) ?? null,
			createdAt: run.createdAt,
		})
		.onConflictDoNothing({ target: harnessSubjectEvalRuns.id });
	const expectedMetadata =
		optionalJsonObject(run.metadata, "harness_subject_eval_runs.metadata") ??
		null;
	const persisted = (
		await db
			.select()
			.from(harnessSubjectEvalRuns)
			.where(eq(harnessSubjectEvalRuns.id, run.id))
			.limit(1)
	)[0];
	return (
		persisted?.subjectKind === run.subjectKind &&
		persisted.subjectId === run.subjectId &&
		persisted.tediId === (run.tediId ?? null) &&
		persisted.orgId === (run.orgId ?? null) &&
		persisted.harnessVersionId === run.harnessVersionId &&
		persisted.lane === run.lane &&
		persisted.taskSetId === run.taskSetId &&
		persisted.total === run.total &&
		persisted.passed === run.passed &&
		persisted.failed === run.failed &&
		persisted.meanScore === run.meanScore &&
		persisted.eligible === run.eligible &&
		sameJson(persisted.report, run.report ?? null) &&
		sameJson(persisted.metadata, expectedMetadata) &&
		persisted.createdAt === run.createdAt
	);
}

export interface ListSubjectEvalResultsOptions extends HarnessSubjectRef {
	harnessVersionId?: string;
	limit?: number;
}

/**
 * Subject eval results filtered by subject key and optionally harness version,
 * newest first.
 */
export async function listSubjectEvalResults(
	db: DbClient,
	options: ListSubjectEvalResultsOptions,
): Promise<HarnessSubjectEvalResultRow[]> {
	const conditions = [
		eq(harnessSubjectEvalResults.subjectKind, options.subjectKind),
		eq(harnessSubjectEvalResults.subjectId, options.subjectId),
	];
	if (options.harnessVersionId) {
		conditions.push(
			eq(harnessSubjectEvalResults.harnessVersionId, options.harnessVersionId),
		);
	}
	const limit = options.limit ?? 200;
	const rows = await db
		.select()
		.from(harnessSubjectEvalResults)
		.where(and(...conditions))
		.orderBy(
			desc(harnessSubjectEvalResults.createdAt),
			desc(harnessSubjectEvalResults.id),
		)
		.limit(options.subjectKind === "kernel" ? limit * 2 : limit);
	return options.subjectKind === "kernel"
		? effectiveKernelEvalRows(rows, limit)
		: rows;
}

/**
 * Aggregate eval results for one subject key into a summary. Mirrors
 * `summarizeEvalResults` but operates over `harnessSubjectEvalResults`.
 */
export async function summarizeSubjectEvalResults(
	db: DbClient,
	options: ListSubjectEvalResultsOptions,
): Promise<HarnessEvalSummary> {
	const harnessVersionId = options.harnessVersionId ?? "";
	const results = await listSubjectEvalResults(db, {
		...options,
		limit: options.limit ?? 200,
	});
	return summarizeEvalResults(harnessVersionId, results);
}

export interface ListSubjectEvalRunsOptions extends HarnessSubjectRef {
	harnessVersionId?: string;
	limit?: number;
}

/** Subject eval runs newest first. */
export async function listSubjectEvalRuns(
	db: DbClient,
	options: ListSubjectEvalRunsOptions,
): Promise<HarnessSubjectEvalRunRow[]> {
	const conditions = [
		eq(harnessSubjectEvalRuns.subjectKind, options.subjectKind),
		eq(harnessSubjectEvalRuns.subjectId, options.subjectId),
	];
	if (options.harnessVersionId) {
		conditions.push(
			eq(harnessSubjectEvalRuns.harnessVersionId, options.harnessVersionId),
		);
	}
	const rows = await db
		.select()
		.from(harnessSubjectEvalRuns)
		.where(and(...conditions))
		.orderBy(desc(harnessSubjectEvalRuns.createdAt))
		.limit(options.limit ?? 50);
	return rows;
}
