import { AsyncLocalStorage } from "node:async_hooks";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { alias as sqliteAlias } from "drizzle-orm/sqlite-core";
import { alias as pgAlias } from "drizzle-orm/pg-core";
import { coreTable } from "../core-store/client";
import {
	booleanValue,
	coreStore,
	jsonParameter,
	jsonRead,
} from "../core-store/dialect";
import type { DbClient } from "../client";
import type { DbQueryClient } from "../query-client";
import { batchNonEmpty, chunkForBoundParams } from "../utils/batch";
import {
	platformCronCheckpoints as d1Checkpoints,
	platformCronExecutions as d1Executions,
} from "../schema/platform-cron-executions";

function jsonRows(db: DbQueryClient, rows: unknown) {
	return coreStore(db) === "postgres"
		? sql`jsonb_array_elements(${jsonParameter(db, rows)})`
		: sql`json_each(${jsonParameter(db, rows)})`;
}

function rowField(
	db: DbQueryClient,
	field: string,
	kind: "text" | "number" | "json" = "text",
) {
	return jsonRead(db, sql`value`, [field], kind);
}

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
	cursor?: typeof d1Checkpoints.$inferSelect.cursor;
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
	const platformCronCheckpoints = coreTable(db, d1Checkpoints);
	const incoming = (field: string) =>
		sql`(SELECT ${rowField(db, field)} FROM ${jsonRows(db, advances)} WHERE ${rowField(db, "scheduleId")} = excluded.schedule_id LIMIT 1)`;
	return db
		.insert(platformCronCheckpoints)
		.select(
			db
				.select({
					scheduleId: sql<string>`${rowField(db, "scheduleId")}`.as(
						"schedule_id",
					),
					through: sql<string>`${rowField(db, "through")}`.as("through"),
					cursor: sql<
						typeof d1Checkpoints.$inferSelect.cursor
					>`${rowField(db, "cursor", "json")}`.as("cursor"),
				})
				.from(jsonRows(db, advances))
				.where(booleanValue(db, true)),
		)
		.onConflictDoUpdate({
			target: platformCronCheckpoints.scheduleId,
			set: {
				through: sql`excluded.through`,
				cursor: sql`CASE WHEN ${incoming("cursor")} IS NOT NULL THEN excluded.cursor ELSE ${platformCronCheckpoints.cursor} END`,
			},
			setWhere: sql`CASE ${incoming("mode")}
			WHEN 'newer' THEN ${platformCronCheckpoints.through} < excluded.through
			WHEN 'numeric' THEN CAST(${platformCronCheckpoints.through} AS BIGINT) < CAST(excluded.through AS BIGINT)
			WHEN 'cas' THEN ${platformCronCheckpoints.through} = ${incoming("previous")}
			ELSE ${booleanValue(db, false)} END`,
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
	const platformCronExecutions = coreTable(db, d1Executions);
	const statements = chunkForBoundParams(writes.receipts, 50).map((receipts) =>
		db
			.insert(platformCronExecutions)
			.select(
				db
					.select({
						id: sql<string>`${rowField(db, "id")}`.as("id"),
						scheduleId: sql<string>`${rowField(db, "scheduleId")}`.as(
							"schedule_id",
						),
						cron: sql<string>`${rowField(db, "cron")}`.as("cron"),
						scheduledAt: sql<string>`${rowField(db, "scheduledAt")}`.as(
							"scheduled_at",
						),
						startedAt: sql<string>`${rowField(db, "startedAt")}`.as(
							"started_at",
						),
						finishedAt: sql<string>`${rowField(db, "finishedAt")}`.as(
							"finished_at",
						),
						status: sql<"success" | "failure">`${rowField(db, "status")}`.as(
							"status",
						),
						durationMs: sql<number>`${rowField(db, "durationMs", "number")}`.as(
							"duration_ms",
						),
						affectedRowCounts: sql<
							Record<string, number>
						>`${rowField(db, "affectedRowCounts", "json")}`.as(
							"affected_row_counts",
						),
						error: sql<string | null>`${rowField(db, "error")}`.as("error"),
					})
					.from(jsonRows(db, receipts))
					.where(booleanValue(db, true)),
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
	/** Terminal timestamps cover receipts scheduled in the last 24 hours. */
	lastSuccessAt: string | null;
	lastFailureAt: string | null;
	countsLast24h: { running: number; success: number; failure: number };
}

/** Latest receipt per requested schedule, plus an indexed 24-hour window. */
export async function listPlatformCronExecutionSummaries(
	db: DbQueryClient,
	scheduleIds: readonly string[],
	now = new Date(),
): Promise<PlatformCronExecutionSummary[]> {
	const platformCronExecutions = coreTable(db, d1Executions);
	const alias =
		coreStore(db) === "postgres"
			? (pgAlias as unknown as typeof sqliteAlias)
			: sqliteAlias;
	const since = new Date(now.getTime() - 86_400_000).toISOString();
	const requested = db
		.$with("requested")
		.as(
			db
				.selectDistinct({ scheduleId: sql<string>`value`.as("schedule_id") })
				.from(
					coreStore(db) === "postgres"
						? sql`jsonb_array_elements_text(${jsonParameter(db, scheduleIds)})`
						: jsonRows(db, scheduleIds),
				),
		);
	const r = alias(platformCronExecutions, "r");
	// Drive the time range from the catalog so retained history is never scanned.
	const recent = db.$with("recent").as(
		db
			.select({
				scheduleId: sql<string>`${r.scheduleId}`.as("recent_schedule_id"),
				runningCount:
					sql<number>`sum(case when ${r.status} = 'running' then 1 else 0 end)`.as(
						"running_count",
					),
				successCount:
					sql<number>`sum(case when ${r.status} = 'success' then 1 else 0 end)`.as(
						"success_count",
					),
				failureCount:
					sql<number>`sum(case when ${r.status} = 'failure' then 1 else 0 end)`.as(
						"failure_count",
					),
				lastSuccessAt: sql<
					string | null
				>`max(case when ${r.status} = 'success' then ${r.finishedAt} end)`.as(
					"last_success_at",
				),
				lastFailureAt: sql<
					string | null
				>`max(case when ${r.status} = 'failure' then ${r.finishedAt} end)`.as(
					"last_failure_at",
				),
			})
			.from(requested)
			.crossJoin(r)
			.where(
				and(
					eq(r.scheduleId, requested.scheduleId),
					gte(r.scheduledAt, since),
					lte(r.scheduledAt, now.toISOString()),
				),
			)
			.groupBy(r.scheduleId),
	);
	const p = alias(platformCronExecutions, "p");
	const latestReceipt = alias(platformCronExecutions, "latest_receipt");
	const rows = await db
		.with(requested, recent)
		.select({
			scheduleId: p.scheduleId,
			latestId: p.id,
			latestStatus: p.status,
			latestScheduledAt: p.scheduledAt,
			latestStartedAt: p.startedAt,
			latestFinishedAt: p.finishedAt,
			latestDurationMs: p.durationMs,
			latestAffectedRowCounts: p.affectedRowCounts,
			latestError: p.error,
			lastSuccessAt: recent.lastSuccessAt,
			lastFailureAt: recent.lastFailureAt,
			runningCount: sql<number>`coalesce(${recent.runningCount}, 0)`.mapWith(
				Number,
			),
			successCount: sql<number>`coalesce(${recent.successCount}, 0)`.mapWith(
				Number,
			),
			failureCount: sql<number>`coalesce(${recent.failureCount}, 0)`.mapWith(
				Number,
			),
		})
		.from(requested)
		.innerJoin(
			p,
			eq(
				p.id,
				db
					.select({ id: latestReceipt.id })
					.from(latestReceipt)
					.where(eq(latestReceipt.scheduleId, requested.scheduleId))
					.orderBy(desc(latestReceipt.scheduledAt))
					.limit(1),
			),
		)
		.leftJoin(recent, eq(recent.scheduleId, requested.scheduleId))
		.orderBy(requested.scheduleId);

	return rows.map(({ runningCount, successCount, failureCount, ...row }) => ({
		...row,
		countsLast24h: {
			running: runningCount,
			success: successCount,
			failure: failureCount,
		},
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
	const platformCronExecutions = coreTable(db, d1Executions);
	const result = await db
		.insert(platformCronExecutions)
		.values({ ...stamp, status: "running", affectedRowCounts: {} })
		.onConflictDoNothing({
			target: [
				platformCronExecutions.scheduleId,
				platformCronExecutions.scheduledAt,
			],
		})
		.returning({ id: platformCronExecutions.id });
	return result.length === 1;
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
		// Postgres cannot target one row twice in an INSERT; keep the first finish.
		if (
			!writes.receipts.some(
				(row) =>
					row.scheduleId === stamp.scheduleId &&
					row.scheduledAt === stamp.scheduledAt,
			)
		)
			writes.receipts.push(stamp);
		return;
	}

	const platformCronExecutions = coreTable(db, d1Executions);
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
	const platformCronExecutions = coreTable(db, d1Executions);
	const startedBefore = new Date(
		Date.parse(now) - PLATFORM_CRON_RUNNING_ABANDONED_HOURS * 3_600_000,
	).toISOString();
	let terminalized = 0;
	for (let i = 0; i < maxBatches; i++) {
		const result = await db
			.update(platformCronExecutions)
			.set({
				status: "failure",
				finishedAt: now,
				durationMs: null,
				error: "Cron receipt abandoned: no finish recorded within six hours",
			})
			.where(sql`${platformCronExecutions.status} = 'running'
				and ${platformCronExecutions.id} in (
					select ${platformCronExecutions.id}
					from ${platformCronExecutions}
					where ${platformCronExecutions.status} = 'running'
						and ${platformCronExecutions.startedAt} < ${startedBefore}
					order by ${platformCronExecutions.startedAt}, ${platformCronExecutions.id}
					limit ${batchSize}
				)`)
			.returning({ id: platformCronExecutions.id });
		const rows = result.length;
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
	const platformCronCheckpoints = coreTable(db, d1Checkpoints);
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
	const platformCronCheckpoints = coreTable(db, d1Checkpoints);
	await db
		.insert(platformCronCheckpoints)
		.values({ scheduleId, through })
		.onConflictDoUpdate({
			target: platformCronCheckpoints.scheduleId,
			set: { through },
		});
}
