import { eq, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { platformCronExecutions } from "../schema/platform-cron-executions";
import { getAffectedRows } from "../utils/d1-result";

export const PLATFORM_CRON_RECEIPT_RETENTION_DAYS = 90;
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
	const rows = (await db.all(sql`
		WITH ranked AS (
			SELECT *,
				ROW_NUMBER() OVER (
					PARTITION BY schedule_id ORDER BY scheduled_at DESC, started_at DESC
				) AS latest_rank
			FROM platform_cron_executions
		)
		SELECT
			schedule_id AS scheduleId,
			MAX(CASE WHEN latest_rank = 1 THEN id END) AS latestId,
			MAX(CASE WHEN latest_rank = 1 THEN status END) AS latestStatus,
			MAX(CASE WHEN latest_rank = 1 THEN scheduled_at END) AS latestScheduledAt,
			MAX(CASE WHEN latest_rank = 1 THEN started_at END) AS latestStartedAt,
			MAX(CASE WHEN latest_rank = 1 THEN finished_at END) AS latestFinishedAt,
			MAX(CASE WHEN latest_rank = 1 THEN duration_ms END) AS latestDurationMs,
			MAX(CASE WHEN latest_rank = 1 THEN affected_row_counts END) AS latestAffectedRowCounts,
			MAX(CASE WHEN latest_rank = 1 THEN error END) AS latestError,
			MAX(CASE WHEN status = 'success' THEN finished_at END) AS lastSuccessAt,
			MAX(CASE WHEN status = 'failure' THEN finished_at END) AS lastFailureAt
		FROM ranked
		GROUP BY schedule_id
		ORDER BY schedule_id
	`)) as Array<Record<string, unknown>>;

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
