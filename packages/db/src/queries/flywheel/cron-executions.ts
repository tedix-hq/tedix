import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	GOVERNED_LEARNING_SCHEDULES,
	GOVERNED_LEARNING_SKILL_SLUGS,
} from "@tedix/api-contract/utils/governed-learning";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../../client";
import {
	skillEntries,
	skillRuns,
	skillSchedules,
} from "../../schema/cognitive";
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

/** Scheduled skill-workflow slug `platform-<name>-dogfood` → cron name. */
const scheduledCronName = sql<string>`replace(replace(${skillRuns.skillSlug}, 'platform-', ''), '-dogfood', '')`;

function legacyCronScope(access: FlywheelAccess) {
	return and(
		eq(tediCronExecutions.tediId, access.tediId),
		eq(tediCronExecutions.orgId, access.orgId),
		inArray(
			tediCronExecutions.cronName,
			EXPECTED_COGNITIVE_CRONS.map((cron) => cron.name),
		),
	);
}

function scheduledSkillRunScope(access: FlywheelAccess) {
	return and(
		eq(skillRuns.tediId, access.tediId),
		eq(skillRuns.organizationId, access.orgId),
		eq(skillRuns.createdBy, "schedule"),
		inArray(skillRuns.skillSlug, [...COGNITIVE_SKILL_SLUGS]),
	);
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
	const executions = db.$with("executions").as(
		unionAll(
			db
				.select({
					cronName: sql<string>`${tediCronExecutions.cronName}`.as("cronName"),
					status: sql<string>`${tediCronExecutions.status}`.as("status"),
					startedAt: sql<string>`${tediCronExecutions.startedAt}`.as(
						"startedAt",
					),
					finishedAt: sql<string | null>`${tediCronExecutions.finishedAt}`.as(
						"finishedAt",
					),
					mechanism: sql<
						CronExecutionSummaryRow["mechanism"]
					>`'legacy_cron'`.as("mechanism"),
					runId: sql<string | null>`${tediCronExecutions.runId}`.as("runId"),
				})
				.from(tediCronExecutions)
				.where(legacyCronScope(access)),
			db
				.select({
					cronName: scheduledCronName.as("cronName"),
					status: sql<string>`CASE
						WHEN ${skillRuns.status} = 'completed' THEN 'success'
						WHEN ${skillRuns.status} IN ('failed', 'canceled') THEN 'failure'
						ELSE 'running'
					END`.as("status"),
					startedAt: sql<string>`${skillRuns.startedAt}`.as("startedAt"),
					finishedAt: sql<string | null>`${skillRuns.completedAt}`.as(
						"finishedAt",
					),
					mechanism: sql<
						CronExecutionSummaryRow["mechanism"]
					>`'scheduled_skill_workflow'`.as("mechanism"),
					runId: sql<string | null>`${skillRuns.id}`.as("runId"),
				})
				.from(skillRuns)
				.where(scheduledSkillRunScope(access)),
		),
	);
	return db
		.with(executions)
		.select({
			cronName: executions.cronName,
			status: executions.status,
			startedAt: sql<string>`MAX(${executions.startedAt})`.as("startedAt"),
			finishedAt: executions.finishedAt,
			mechanism: executions.mechanism,
			runId: executions.runId,
		})
		.from(executions)
		.groupBy(executions.cronName);
}

/** Count executions per cron name since the given ISO timestamp. */
export async function getCronExecutionCounts(
	db: DbClient,
	access: FlywheelAccess,
	since: string,
): Promise<CronExecutionCountRow[]> {
	const executions = db.$with("executions").as(
		unionAll(
			db
				.select({
					cronName: sql<string>`${tediCronExecutions.cronName}`.as("cronName"),
					startedAt: sql<string>`${tediCronExecutions.startedAt}`.as(
						"startedAt",
					),
				})
				.from(tediCronExecutions)
				.where(legacyCronScope(access)),
			db
				.select({
					cronName: scheduledCronName.as("cronName"),
					startedAt: sql<string>`${skillRuns.startedAt}`.as("startedAt"),
				})
				.from(skillRuns)
				.where(scheduledSkillRunScope(access)),
		),
	);
	return db
		.with(executions)
		.select({
			cronName: executions.cronName,
			cnt: sql<number>`count(*)`.as("cnt"),
		})
		.from(executions)
		.where(gte(executions.startedAt, since))
		.groupBy(executions.cronName);
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
	return db
		.select({
			cronName:
				sql<string>`replace(replace(${skillEntries.slug}, 'platform-', ''), '-dogfood', '')`.as(
					"cronName",
				),
			// Raw 0/1, as the row type allows.
			enabled: sql<boolean | number>`${skillSchedules.enabled}`.as("enabled"),
			lastBudgetBlockedAt: skillSchedules.lastBudgetBlockedAt,
			lastBudgetBlockedReason: skillSchedules.lastBudgetBlockedReason,
			lastBudgetResetAt: skillSchedules.lastBudgetResetAt,
			lastBudgetAdmissionClass: sql<
				string | null
			>`${skillSchedules.lastBudgetAdmissionClass}`.as(
				"lastBudgetAdmissionClass",
			),
		})
		.from(skillSchedules)
		.innerJoin(skillEntries, eq(skillEntries.id, skillSchedules.skillId))
		.where(
			and(
				eq(skillSchedules.tediId, access.tediId),
				eq(skillSchedules.organizationId, access.orgId),
				inArray(skillEntries.slug, [...COGNITIVE_SKILL_SLUGS]),
			),
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
