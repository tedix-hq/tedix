import { eq, getColumns, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import { platformCronExecutions } from "../schema/platform-cron-executions";
import { getAffectedRows } from "../utils/d1-result";

export const PLATFORM_CRON_RECEIPT_RETENTION_DAYS = 90;
// Leave a generous margin for slow cron jobs before treating a lost finish as abandoned.
export const PLATFORM_CRON_RUNNING_ABANDONED_HOURS = 6;
export const PLATFORM_CRON_MAX_AFFECTED_ROW_KEYS = 32;

export interface PlatformCronExecutionStart {
	id: string;
	scheduleId: string;
	cron: string;
	scheduledAt: string;
	startedAt: string;
}

export interface PlatformCronExecutionFinish extends PlatformCronExecutionStart {
	finishedAt: string;
	status: "success" | "failure";
	durationMs: number;
	affectedRowCounts: Record<string, number>;
	error?: string | null;
}

export interface PlatformCronExecutionSummary {
	scheduleId: string;
	latestId: string;
	latestStatus: "running" | "success" | "failure";
	latestScheduledAt: string;
	latestStartedAt: string;
	latestFinishedAt: string | null;
	latestDurationMs: number | null;
	latestAffectedRowCounts: Record<string, number>;
	latestError: string | null;
	lastSuccessAt: string | null;
	lastFailureAt: string | null;
}

/** One bounded, current summary per observed logical platform schedule. */
export async function listPlatformCronExecutionSummaries(
	db: DbClient,
): Promise<PlatformCronExecutionSummary[]> {
	const ranked = db.$with("ranked").as(
		db
			.select({
				...getColumns(platformCronExecutions),
				latestRank: sql<number>`ROW_NUMBER() OVER (
					PARTITION BY ${platformCronExecutions.scheduleId}
					ORDER BY ${platformCronExecutions.scheduledAt} DESC, ${platformCronExecutions.startedAt} DESC
				)`.as("latest_rank"),
			})
			.from(platformCronExecutions),
	);
	// Raw driver values: the JSON column is parsed below, exactly as stored.
	const latest = (column: AnySQLiteColumn, name: string) =>
		sql<unknown>`MAX(CASE WHEN ${ranked.latestRank} = 1 THEN ${column} END)`.as(
			name,
		);
	const rows: Array<Record<string, unknown>> = await db
		.with(ranked)
		.select({
			scheduleId: sql<unknown>`${ranked.scheduleId}`.as("scheduleId"),
			latestId: latest(ranked.id, "latestId"),
			latestStatus: latest(ranked.status, "latestStatus"),
			latestScheduledAt: latest(ranked.scheduledAt, "latestScheduledAt"),
			latestStartedAt: latest(ranked.startedAt, "latestStartedAt"),
			latestFinishedAt: latest(ranked.finishedAt, "latestFinishedAt"),
			latestDurationMs: latest(ranked.durationMs, "latestDurationMs"),
			latestAffectedRowCounts: latest(
				ranked.affectedRowCounts,
				"latestAffectedRowCounts",
			),
			latestError: latest(ranked.error, "latestError"),
			lastSuccessAt:
				sql<unknown>`MAX(CASE WHEN ${ranked.status} = 'success' THEN ${ranked.finishedAt} END)`.as(
					"lastSuccessAt",
				),
			lastFailureAt:
				sql<unknown>`MAX(CASE WHEN ${ranked.status} = 'failure' THEN ${ranked.finishedAt} END)`.as(
					"lastFailureAt",
				),
		})
		.from(ranked)
		.groupBy(ranked.scheduleId)
		.orderBy(ranked.scheduleId);

	return rows.map((row) => ({
		scheduleId: String(row.scheduleId),
		latestId: String(row.latestId),
		latestStatus: String(
			row.latestStatus,
		) as PlatformCronExecutionSummary["latestStatus"],
		latestScheduledAt: String(row.latestScheduledAt),
		latestStartedAt: String(row.latestStartedAt),
		latestFinishedAt:
			typeof row.latestFinishedAt === "string" ? row.latestFinishedAt : null,
		latestDurationMs:
			row.latestDurationMs === null || row.latestDurationMs === undefined
				? null
				: Number(row.latestDurationMs),
		latestAffectedRowCounts: JSON.parse(
			typeof row.latestAffectedRowCounts === "string"
				? row.latestAffectedRowCounts
				: "{}",
		) as Record<string, number>,
		latestError: typeof row.latestError === "string" ? row.latestError : null,
		lastSuccessAt:
			typeof row.lastSuccessAt === "string" ? row.lastSuccessAt : null,
		lastFailureAt:
			typeof row.lastFailureAt === "string" ? row.lastFailureAt : null,
	}));
}

/**
 * Open one deterministic fire receipt. A duplicate delivery never resets a
 * terminal receipt to running or creates a second row.
 */
export async function recordPlatformCronExecutionStart(
	db: DbClient,
	stamp: PlatformCronExecutionStart,
): Promise<boolean> {
	const result = await db
		.insert(platformCronExecutions)
		.values({ ...stamp, status: "running", affectedRowCounts: {} })
		.onConflictDoNothing({
			target: [
				platformCronExecutions.scheduleId,
				platformCronExecutions.scheduledAt,
			],
		});
	return getAffectedRows(result) === 1;
}

/**
 * Seal a running receipt, or create a terminal receipt if the start write was
 * lost. A duplicate delivery cannot rewrite an already-terminal outcome.
 */
export async function recordPlatformCronExecutionFinish(
	db: DbClient,
	stamp: PlatformCronExecutionFinish,
): Promise<void> {
	await db
		.insert(platformCronExecutions)
		.values(stamp)
		.onConflictDoUpdate({
			target: [
				platformCronExecutions.scheduleId,
				platformCronExecutions.scheduledAt,
			],
			set: {
				status: stamp.status,
				finishedAt: stamp.finishedAt,
				durationMs: stamp.durationMs,
				affectedRowCounts: stamp.affectedRowCounts,
				error: stamp.error ?? null,
			},
			setWhere: eq(platformCronExecutions.status, "running"),
		});
}

/** Recover lost finish writes before retention; elapsed wall time is not job duration. */
export async function terminalizeAbandonedPlatformCronExecutions(
	db: DbClient,
	now: string,
	batchSize = 5_000,
	maxBatches = 10,
): Promise<number> {
	const startedBefore = new Date(
		Date.parse(now) - PLATFORM_CRON_RUNNING_ABANDONED_HOURS * 3_600_000,
	).toISOString();
	let terminalized = 0;
	for (let i = 0; i < maxBatches; i++) {
		const result = await db.update(platformCronExecutions).set({
			status: "failure",
			finishedAt: now,
			durationMs: null,
			error: "Cron receipt abandoned: no finish recorded within six hours",
		}).where(sql`${platformCronExecutions.status} = 'running'
				and ${platformCronExecutions.id} in (
					select ${platformCronExecutions.id}
					from ${platformCronExecutions}
					where ${platformCronExecutions.status} = 'running'
						and ${platformCronExecutions.startedAt} < ${startedBefore}
					order by ${platformCronExecutions.startedAt}, ${platformCronExecutions.id}
					limit ${batchSize}
				)`);
		const rows = getAffectedRows(result);
		terminalized += rows;
		if (rows < batchSize) break;
	}
	return terminalized;
}

export async function prunePlatformCronExecutions(
	db: DbClient,
	createdBefore: string,
	batchSize = 5_000,
	maxBatches = 10,
): Promise<number> {
	let deleted = 0;
	for (let i = 0; i < maxBatches; i++) {
		const result = await db.delete(platformCronExecutions).where(
			sql`${platformCronExecutions.id} in (
				select ${platformCronExecutions.id}
				from ${platformCronExecutions}
				where ${platformCronExecutions.createdAt} < ${createdBefore}
					and ${platformCronExecutions.status} <> 'running'
				limit ${batchSize}
			)`,
		);
		const rows = getAffectedRows(result);
		deleted += rows;
		if (rows < batchSize) break;
	}
	return deleted;
}
