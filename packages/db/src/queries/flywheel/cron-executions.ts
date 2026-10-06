import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	GOVERNED_LEARNING_SCHEDULES,
	GOVERNED_LEARNING_SKILL_SLUGS,
} from "@tedix/api-contract/utils/governed-learning";
import { sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { tediCronExecutions } from "../../schema/cron-executions";

interface FlywheelAccess {
	tediId: string;
	orgId: string;
}

export interface CronExecutionSummaryRow {
	cronName: string;
	status: string;
	startedAt: string;
	finishedAt: string | null;
	mechanism?: "legacy_cron" | "scheduled_skill_workflow";
	runId?: string | null;
}

export interface CronExecutionCountRow {
	cronName: string;
	cnt: number;
}

/**
 * The six cognitive-loop crons the flywheel health surface tracks, with their
 * expected intervals (mirrors the DEFAULT_CRON_TEMPLATES schedules in
 * `schema/control-plane.ts`: 0 *\/8, 0 *\/4, 0 *\/6, 0 5, 0 4, 30 *\/6).
 */
export const EXPECTED_COGNITIVE_CRONS = GOVERNED_LEARNING_SCHEDULES;
export const COGNITIVE_SKILL_SLUGS = GOVERNED_LEARNING_SKILL_SLUGS;

/** Grace multiplier over a cron's expected interval before it counts as dark. */
export const CRON_DARKNESS_GRACE_FACTOR = 1.5;

export interface CronExecutionStartStamp {
	fireKey: string;
	cronName: string;
	runId?: string | null;
	/** ISO 8601 dispatch time. */
	startedAt: string;
}

export interface CronExecutionFinishStamp {
	fireKey: string;
	cronName: string;
	runId?: string | null;
	/** ISO 8601 dispatch time — used only when the start stamp was lost. */
	startedAt: string;
	/** ISO 8601 settle time. */
	finishedAt: string;
	status: "success" | "failure";
	transitions?: Record<string, JsonValue> | null;
	error?: string | null;
}

/**
 * Stamp a cron fire as `running`. Upserts on (tediId, fireKey) so an alarm
 * re-fire of the same schedule slot resets the row instead of duplicating.
 */
export async function recordCronExecutionStart(
	db: DbClient,
	access: FlywheelAccess,
	stamp: CronExecutionStartStamp,
): Promise<void> {
	await db
		.insert(tediCronExecutions)
		.values({
			id: crypto.randomUUID(),
			tediId: access.tediId,
			orgId: access.orgId,
			cronName: stamp.cronName,
			fireKey: stamp.fireKey,
			runId: stamp.runId ?? null,
			status: "running",
			startedAt: stamp.startedAt,
		})
		.onConflictDoUpdate({
			target: [tediCronExecutions.tediId, tediCronExecutions.fireKey],
			set: {
				cronName: stamp.cronName,
				runId: stamp.runId ?? null,
				status: "running",
				startedAt: stamp.startedAt,
				finishedAt: null,
				transitions: null,
				error: null,
			},
		});
}

/**
 * Seal a cron fire terminal (`success`/`failure`) with its transitions
 * summary. Upserts so a finish whose start stamp was lost (e.g. a transient
 * API outage at dispatch) still lands as a complete record.
 */
export async function recordCronExecutionFinish(
	db: DbClient,
	access: FlywheelAccess,
	stamp: CronExecutionFinishStamp,
): Promise<void> {
	await db
		.insert(tediCronExecutions)
		.values({
			id: crypto.randomUUID(),
			tediId: access.tediId,
			orgId: access.orgId,
			cronName: stamp.cronName,
			fireKey: stamp.fireKey,
			runId: stamp.runId ?? null,
			status: stamp.status,
			startedAt: stamp.startedAt,
			finishedAt: stamp.finishedAt,
			transitions: stamp.transitions ?? null,
			error: stamp.error ?? null,
		})
		.onConflictDoUpdate({
			target: [tediCronExecutions.tediId, tediCronExecutions.fireKey],
			set: {
				status: stamp.status,
				finishedAt: stamp.finishedAt,
				transitions: stamp.transitions ?? null,
				error: stamp.error ?? null,
				...(stamp.runId ? { runId: stamp.runId } : {}),
			},
		});
}

/**
 * Latest execution per cron name. Uses SQLite's documented bare-column-with-
 * MAX() semantics: `status`/`finished_at` come from the same row as the
 * MAX(started_at).
 */
export async function getLatestCronExecutions(
	db: DbClient,
	access: FlywheelAccess,
): Promise<CronExecutionSummaryRow[]> {
	const cronNames = sql.join(
		EXPECTED_COGNITIVE_CRONS.map((cron) => sql`${cron.name}`),
		sql`, `,
	);
	const skillSlugs = sql.join(
		COGNITIVE_SKILL_SLUGS.map((slug) => sql`${slug}`),
		sql`, `,
	);
	return db.all<CronExecutionSummaryRow>(
		sql`WITH executions AS (
			SELECT cron_name as cronName, status, started_at as startedAt,
				finished_at as finishedAt, 'legacy_cron' as mechanism,
				run_id as runId
			FROM tedi_cron_executions
			WHERE tedi_id = ${access.tediId} AND org_id = ${access.orgId}
				AND cron_name IN (${cronNames})
			UNION ALL
			SELECT replace(replace(skill_slug, 'platform-', ''), '-dogfood', '') as cronName,
				CASE
					WHEN status = 'completed' THEN 'success'
					WHEN status IN ('failed', 'canceled') THEN 'failure'
					ELSE 'running'
				END as status,
				started_at as startedAt, completed_at as finishedAt,
				'scheduled_skill_workflow' as mechanism, id as runId
			FROM skill_runs
			WHERE tedi_id = ${access.tediId}
				AND organization_id = ${access.orgId}
				AND created_by = 'schedule'
				AND skill_slug IN (${skillSlugs})
		)
		SELECT cronName, status, MAX(startedAt) as startedAt,
			finishedAt, mechanism, runId
		FROM executions
		GROUP BY cronName`,
	);
}

/** Count executions per cron name since the given ISO timestamp. */
export async function getCronExecutionCounts(
	db: DbClient,
	access: FlywheelAccess,
	since: string,
): Promise<CronExecutionCountRow[]> {
	const cronNames = sql.join(
		EXPECTED_COGNITIVE_CRONS.map((cron) => sql`${cron.name}`),
		sql`, `,
	);
	const skillSlugs = sql.join(
		COGNITIVE_SKILL_SLUGS.map((slug) => sql`${slug}`),
		sql`, `,
	);
	return db.all<CronExecutionCountRow>(
		sql`WITH executions AS (
			SELECT cron_name as cronName, started_at as startedAt
			FROM tedi_cron_executions
			WHERE tedi_id = ${access.tediId} AND org_id = ${access.orgId}
				AND cron_name IN (${cronNames})
			UNION ALL
			SELECT replace(replace(skill_slug, 'platform-', ''), '-dogfood', '') as cronName,
				started_at as startedAt
			FROM skill_runs
			WHERE tedi_id = ${access.tediId}
				AND organization_id = ${access.orgId}
				AND created_by = 'schedule'
				AND skill_slug IN (${skillSlugs})
		)
		SELECT cronName, count(*) as cnt
		FROM executions
		WHERE startedAt >= ${since}
		GROUP BY cronName`,
	);
}

export interface CronFlywheelHealthEntry {
	name: string;
	mechanism: "legacy_cron" | "scheduled_skill_workflow" | null;
	lastRunId: string | null;
	lastExecutedAt: string | null;
	lastSuccess: boolean | null;
	executionsLast24h: number;
	expectedIntervalHours: number;
	overdue: boolean;
	state:
		| "healthy"
		| "disabled"
		| "running"
		| "failed"
		| "overdue"
		| "never_ran"
		| "budget_blocked";
	budgetBlockedAt: string | null;
	budgetBlockedReason: string | null;
	budgetResetAt: string | null;
	budgetBlockActive: boolean;
	budgetAdmissionClass: "background" | "governed_learning" | null;
}

export interface GovernedLearningScheduleStateRow {
	cronName: string;
	enabled: boolean | number;
	lastBudgetBlockedAt: string | null;
	lastBudgetBlockedReason: string | null;
	lastBudgetResetAt: string | null;
	lastBudgetAdmissionClass: string | null;
}

/** Latest canonical schedule budget state for the six governed-learning loops. */
export async function getGovernedLearningScheduleStates(
	db: DbClient,
	access: FlywheelAccess,
): Promise<GovernedLearningScheduleStateRow[]> {
	const skillSlugs = sql.join(
		COGNITIVE_SKILL_SLUGS.map((slug) => sql`${slug}`),
		sql`, `,
	);
	return db.all<GovernedLearningScheduleStateRow>(
		sql`SELECT
				replace(replace(se.slug, 'platform-', ''), '-dogfood', '') as cronName,
				ss.enabled as enabled,
				ss.last_budget_blocked_at as lastBudgetBlockedAt,
				ss.last_budget_blocked_reason as lastBudgetBlockedReason,
				ss.last_budget_reset_at as lastBudgetResetAt,
				ss.last_budget_admission_class as lastBudgetAdmissionClass
			FROM skill_schedules ss
			INNER JOIN skill_entries se ON se.id = ss.skill_id
			WHERE ss.tedi_id = ${access.tediId}
				AND ss.organization_id = ${access.orgId}
				AND se.slug IN (${skillSlugs})`,
	);
}

/**
 * Pure projection of the execution ledger onto the six expected cognitive
 * crons: exact name matching, `lastSuccess: null` while a fire is still
 * running (or never fired), overdue past CRON_DARKNESS_GRACE_FACTOR× the
 * expected interval.
 */
export function buildCronFlywheelHealth(
	latest: CronExecutionSummaryRow[],
	counts: CronExecutionCountRow[],
	nowMs: number,
	scheduleStates: GovernedLearningScheduleStateRow[] = [],
	enabledCronNames?: ReadonlySet<string>,
): CronFlywheelHealthEntry[] {
	const latestByName = new Map(latest.map((row) => [row.cronName, row]));
	const countByName = new Map(counts.map((row) => [row.cronName, row.cnt]));
	const scheduleByName = new Map(
		scheduleStates.map((row) => [row.cronName, row]),
	);

	return EXPECTED_COGNITIVE_CRONS.map((cron) => {
		const disabled =
			enabledCronNames !== undefined && !enabledCronNames.has(cron.name);
		const last = latestByName.get(cron.name);
		const lastExecutedAt = last?.startedAt ?? null;
		const lastSuccess =
			last === undefined || last.status === "running"
				? null
				: last.status === "success";

		let overdue = true;
		if (lastExecutedAt) {
			const elapsed = nowMs - new Date(lastExecutedAt).getTime();
			const expectedMs = cron.intervalHours * 60 * 60 * 1000;
			overdue = elapsed > expectedMs * CRON_DARKNESS_GRACE_FACTOR;
		}
		const schedule = scheduleByName.get(cron.name);
		const budgetBlockedAt = schedule?.lastBudgetBlockedAt ?? null;
		const budgetResetAt = schedule?.lastBudgetResetAt ?? null;
		const budgetAdmissionClass =
			schedule?.lastBudgetAdmissionClass === "background" ||
			schedule?.lastBudgetAdmissionClass === "governed_learning"
				? schedule.lastBudgetAdmissionClass
				: null;
		const budgetBlocked = budgetBlockedAt !== null;
		const state: CronFlywheelHealthEntry["state"] = disabled
			? "disabled"
			: budgetBlocked
				? "budget_blocked"
				: last?.status === "running"
					? "running"
					: last?.status === "failure"
						? "failed"
						: !last
							? "never_ran"
							: overdue
								? "overdue"
								: "healthy";

		return {
			name: cron.name,
			mechanism: last?.mechanism ?? null,
			lastRunId: last?.runId ?? null,
			lastExecutedAt,
			lastSuccess,
			executionsLast24h: countByName.get(cron.name) ?? 0,
			expectedIntervalHours: cron.intervalHours,
			overdue: disabled ? false : overdue,
			state,
			budgetBlockedAt,
			budgetBlockedReason: schedule?.lastBudgetBlockedReason ?? null,
			budgetResetAt,
			budgetBlockActive: Boolean(
				budgetResetAt && new Date(budgetResetAt).getTime() > nowMs,
			),
			budgetAdmissionClass,
		};
	});
}
