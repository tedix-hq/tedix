import { AsyncLocalStorage } from "node:async_hooks";
import { eq, getColumns, sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import { batchNonEmpty, chunkForBoundParams } from "../utils/batch";
import {
	platformCronCheckpoints,
	platformCronExecutions,
} from "../schema/platform-cron-executions";
import { getAffectedRows } from "../utils/d1-result";

// Leave a generous margin for slow cron jobs before treating a lost finish as abandoned.
export const PLATFORM_CRON_RUNNING_ABANDONED_HOURS = 6;

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

type CheckpointAdvance = {
	scheduleId: string;
	through: string;
	cursor?: typeof platformCronCheckpoints.$inferSelect.cursor;
	mode: "newer" | "numeric" | "cas";
	previous?: string | null;
};
type CronWrites = {
	receipts: PlatformCronExecutionFinish[];
	checkpoints: CheckpointAdvance[];
};
const cronWrites = new AsyncLocalStorage<CronWrites>();

/** Scope collection to one invocation, including its awaited background paths. */
export async function withPlatformCronWriteBatch<T>(
	db: DbQueryClient,
	run: () => Promise<T>,
	flush: (write: () => Promise<void>) => Promise<void>,
): Promise<T> {
	const writes: CronWrites = { receipts: [], checkpoints: [] };
	return cronWrites.run(writes, async () => {
		let failed = false;
		try {
			return await run();
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			try {
				await flush(() => writePlatformCronBatch(db, writes));
			} catch (error) {
				// The caller logs flush errors; preserve the original dispatch failure.
				if (!failed) throw error;
			}
		}
	});
}

function buildCheckpointStatement(
	db: DbQueryClient,
	advances: CheckpointAdvance[],
) {
	// JSON rows keep the parameter count independent of chunk length.
	const rows = JSON.stringify(advances);
	const incoming = (field: string) =>
		sql`(SELECT json_extract(value, ${"$." + field}) FROM json_each(${rows}) WHERE json_extract(value, '$.scheduleId') = excluded.schedule_id LIMIT 1)`;
	return db
		.insert(platformCronCheckpoints)
		.select(
			db
				.select({
					scheduleId: sql<string>`json_extract(value, '$.scheduleId')`.as(
						"schedule_id",
					),
					through: sql<string>`json_extract(value, '$.through')`.as("through"),
					cursor: sql<
						typeof platformCronCheckpoints.$inferSelect.cursor
					>`json_extract(value, '$.cursor')`.as("cursor"),
				})
				.from(sql`json_each(${rows})`)
				.where(sql`1`),
		)
		.onConflictDoUpdate({
			target: platformCronCheckpoints.scheduleId,
			set: {
				through: sql`excluded.through`,
				cursor: sql`CASE WHEN ${incoming("cursor")} IS NOT NULL THEN excluded.cursor ELSE ${platformCronCheckpoints.cursor} END`,
			},
			setWhere: sql`CASE ${incoming("mode")}
			WHEN 'newer' THEN ${platformCronCheckpoints.through} < excluded.through
			WHEN 'numeric' THEN CAST(${platformCronCheckpoints.through} AS INTEGER) < CAST(excluded.through AS INTEGER)
			WHEN 'cas' THEN ${platformCronCheckpoints.through} = ${incoming("previous")}
			ELSE 0 END`,
		});
}

export async function advancePlatformCronCheckpoint(
	db: DbQueryClient,
	advance: CheckpointAdvance,
): Promise<void> {
	const writes = cronWrites.getStore();
	if (writes) {
		const previous = writes.checkpoints.find(
			(row) => row.scheduleId === advance.scheduleId,
		);
		if (previous) {
			// Repeated monotonic advances collapse to the furthest boundary. CAS
			// advances retain the original fence while moving the target forward.
			if (
				advance.mode === "cas"
					? advance.previous === previous.through
					: advance.mode === "numeric"
						? Number(advance.through) > Number(previous.through)
						: advance.through > previous.through
			) {
				Object.assign(
					previous,
					advance,
					advance.mode === "cas" ? { previous: previous.previous } : {},
				);
			}
		} else writes.checkpoints.push(advance);
		return;
	}
	await buildCheckpointStatement(db, [advance]);
}

async function writePlatformCronBatch(
	db: DbQueryClient,
	writes: CronWrites,
): Promise<void> {
	const statements = chunkForBoundParams(writes.receipts, 50).map((receipts) =>
		db
			.insert(platformCronExecutions)
			.select(
				db
					.select({
						id: sql<string>`json_extract(value, '$.id')`.as("id"),
						scheduleId: sql<string>`json_extract(value, '$.scheduleId')`.as(
							"schedule_id",
						),
						cron: sql<string>`json_extract(value, '$.cron')`.as("cron"),
						scheduledAt: sql<string>`json_extract(value, '$.scheduledAt')`.as(
							"scheduled_at",
						),
						startedAt: sql<string>`json_extract(value, '$.startedAt')`.as(
							"started_at",
						),
						finishedAt: sql<string>`json_extract(value, '$.finishedAt')`.as(
							"finished_at",
						),
						status: sql<
							"success" | "failure"
						>`json_extract(value, '$.status')`.as("status"),
						durationMs: sql<number>`json_extract(value, '$.durationMs')`.as(
							"duration_ms",
						),
						affectedRowCounts: sql<
							Record<string, number>
						>`json_extract(value, '$.affectedRowCounts')`.as(
							"affected_row_counts",
						),
						error: sql<string | null>`json_extract(value, '$.error')`.as(
							"error",
						),
					})
					.from(sql`json_each(${JSON.stringify(receipts)})`)
					.where(sql`1`),
			)
			.onConflictDoUpdate({
				target: [
					platformCronExecutions.scheduleId,
					platformCronExecutions.scheduledAt,
				],
				set: {
					status: sql`excluded.status`,
					finishedAt: sql`excluded.finished_at`,
					durationMs: sql`excluded.duration_ms`,
					affectedRowCounts: sql`excluded.affected_row_counts`,
					error: sql`excluded.error`,
				},
				setWhere: eq(platformCronExecutions.status, "running"),
			}),
	);
	const checkpoints = chunkForBoundParams(writes.checkpoints, 50).map((rows) =>
		buildCheckpointStatement(db, rows),
	);
	const all = [...statements, ...checkpoints];
	if (all.length) await db.batch(batchNonEmpty(all));
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
	const writes = cronWrites.getStore();
	if (writes) {
		writes.receipts.push(stamp);
		return;
	}

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

/** Read a named progress marker kept apart from the receipts and their retention. */
export async function getPlatformCronCheckpoint(
	db: DbClient,
	scheduleId: string,
): Promise<string | null> {
	const [row] = await db
		.select({ through: platformCronCheckpoints.through })
		.from(platformCronCheckpoints)
		.where(eq(platformCronCheckpoints.scheduleId, scheduleId))
		.limit(1);
	return row?.through ?? null;
}

export async function putPlatformCronCheckpoint(
	db: DbClient,
	scheduleId: string,
	through: string,
): Promise<void> {
	await db
		.insert(platformCronCheckpoints)
		.values({ scheduleId, through })
		.onConflictDoUpdate({
			target: platformCronCheckpoints.scheduleId,
			set: { through },
		});
}
