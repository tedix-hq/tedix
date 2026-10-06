import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type SkillSchedule,
	skillEntries,
	skillSchedules,
} from "../schema/cognitive";

export async function upsertSkillSchedule(
	db: DbClient,
	input: {
		organizationId: string;
		skillId: string;
		tediId: string;
		cron: string;
		params: Record<string, JsonValue>;
		enabled: boolean;
		nextFireAt: string;
	},
): Promise<SkillSchedule> {
	const now = new Date().toISOString();
	await db
		.insert(skillSchedules)
		.values({
			id: crypto.randomUUID(),
			...input,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoUpdate({
			target: skillSchedules.skillId,
			set: {
				organizationId: input.organizationId,
				tediId: input.tediId,
				cron: input.cron,
				params: input.params,
				enabled: input.enabled,
				nextFireAt: input.nextFireAt,
				lastError: null,
				lastBudgetBlockedAt: null,
				lastBudgetBlockedReason: null,
				lastBudgetResetAt: null,
				lastBudgetAdmissionClass: null,
				updatedAt: now,
			},
		});
	const [row] = await db
		.select()
		.from(skillSchedules)
		.where(eq(skillSchedules.skillId, input.skillId))
		.limit(1);
	if (!row) throw new Error("skill schedule upsert did not return a row");
	return row;
}

export async function deleteSkillSchedule(
	db: DbClient,
	skillId: string,
): Promise<void> {
	await db.delete(skillSchedules).where(eq(skillSchedules.skillId, skillId));
}

export async function getSkillSchedule(
	db: DbClient,
	skillId: string,
): Promise<SkillSchedule | undefined> {
	const [row] = await db
		.select()
		.from(skillSchedules)
		.where(eq(skillSchedules.skillId, skillId))
		.limit(1);
	return row;
}

export async function listDueSkillSchedules(
	db: DbClient,
	now: string,
	limit = 50,
): Promise<SkillSchedule[]> {
	return db
		.select()
		.from(skillSchedules)
		.where(
			and(
				eq(skillSchedules.enabled, true),
				lte(skillSchedules.nextFireAt, now),
			),
		)
		.orderBy(asc(skillSchedules.nextFireAt))
		.limit(Math.min(Math.max(limit, 1), 200));
}

export async function listSkillSchedules(
	db: DbClient,
	organizationId: string,
	options: {
		skillId?: string;
		tediId?: string;
		enabled?: boolean;
		limit?: number;
	},
): Promise<SkillSchedule[]> {
	const conditions = [eq(skillSchedules.organizationId, organizationId)];
	if (options.skillId)
		conditions.push(eq(skillSchedules.skillId, options.skillId));
	if (options.tediId)
		conditions.push(eq(skillSchedules.tediId, options.tediId));
	if (options.enabled !== undefined) {
		conditions.push(eq(skillSchedules.enabled, options.enabled));
	}
	return db
		.select()
		.from(skillSchedules)
		.where(and(...conditions))
		.orderBy(asc(skillSchedules.nextFireAt))
		.limit(Math.min(Math.max(options.limit ?? 100, 1), 200));
}

export async function listSkillSchedulesPage(
	db: DbClient,
	organizationId: string,
	options: {
		enabled?: boolean;
		limit?: number;
		offset?: number;
		query?: string;
		skillId?: string;
		tediId?: string;
	},
): Promise<{ schedules: SkillSchedule[]; total: number }> {
	const conditions = [eq(skillSchedules.organizationId, organizationId)];
	if (options.enabled !== undefined) {
		conditions.push(eq(skillSchedules.enabled, options.enabled));
	}
	if (options.skillId) {
		conditions.push(eq(skillSchedules.skillId, options.skillId));
	}
	if (options.tediId) {
		conditions.push(eq(skillSchedules.tediId, options.tediId));
	}
	const query = options.query?.trim().toLowerCase();
	if (query) {
		const pattern = `%${escapeLikePattern(query)}%`;
		conditions.push(sql`(
			lower(${skillSchedules.cron}) LIKE ${pattern} ESCAPE '\\'
			OR EXISTS (
				SELECT 1 FROM ${skillEntries}
				WHERE ${skillEntries.id} = ${skillSchedules.skillId}
				AND (
					lower(${skillEntries.title}) LIKE ${pattern} ESCAPE '\\'
					OR lower(coalesce(${skillEntries.slug}, '')) LIKE ${pattern} ESCAPE '\\'
					OR lower(coalesce(${skillEntries.description}, '')) LIKE ${pattern} ESCAPE '\\'
				)
			)
		)`);
	}
	const whereClause = and(...conditions);
	const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
	const offset = Math.max(options.offset ?? 0, 0);
	const [schedules, total] = await Promise.all([
		db
			.select()
			.from(skillSchedules)
			.where(whereClause)
			.orderBy(asc(skillSchedules.nextFireAt))
			.limit(limit)
			.offset(offset),
		db.$count(skillSchedules, whereClause),
	]);
	return { schedules, total };
}

function escapeLikePattern(value: string): string {
	return value.replace(/[\\%_]/g, "\\$&");
}

export async function recordSkillScheduleDispatch(
	db: DbClient,
	input: {
		scheduleId: string;
		scheduledFireAt: string;
		nextFireAt: string;
		runId: string;
	},
): Promise<void> {
	await db
		.update(skillSchedules)
		.set({
			lastFireAt: input.scheduledFireAt,
			lastRunId: input.runId,
			lastError: null,
			lastBudgetBlockedAt: null,
			lastBudgetBlockedReason: null,
			lastBudgetResetAt: null,
			lastBudgetAdmissionClass: null,
			nextFireAt: input.nextFireAt,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(skillSchedules.id, input.scheduleId),
				eq(skillSchedules.nextFireAt, input.scheduledFireAt),
			),
		);
}

/**
 * Advance a schedule PAST the current occurrence WITHOUT dispatching a run,
 * because the owning tedi's background inference budget is exhausted for the
 * day (a dispatch would only be rejected at provider admission). Mirrors
 * {@link recordSkillScheduleDispatch}'s CAS on `nextFireAt` so a concurrent
 * scanner cannot double-advance, but records machine-readable budget state
 * separately from `lastError` and leaves `lastRunId` untouched. Advancing to
 * the next occurrence — rather than leaving the row due — is what makes the
 * suppression self-releasing: each subsequent occurrence re-probes the budget
 * and dispatches once the window resets.
 */
export async function recordSkillScheduleSuppressed(
	db: DbClient,
	input: {
		scheduleId: string;
		scheduledFireAt: string;
		nextFireAt: string;
		reason: string;
		resetAt: string;
		admissionClass: "background" | "governed_learning";
	},
): Promise<void> {
	await db
		.update(skillSchedules)
		.set({
			lastFireAt: input.scheduledFireAt,
			lastError: null,
			lastBudgetBlockedAt: input.scheduledFireAt,
			lastBudgetBlockedReason: input.reason.slice(0, 1_000),
			lastBudgetResetAt: input.resetAt,
			lastBudgetAdmissionClass: input.admissionClass,
			nextFireAt: input.nextFireAt,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(skillSchedules.id, input.scheduleId),
				eq(skillSchedules.nextFireAt, input.scheduledFireAt),
			),
		);
}

export async function recordSkillScheduleError(
	db: DbClient,
	scheduleId: string,
	error: string,
): Promise<void> {
	await db
		.update(skillSchedules)
		.set({
			lastError: error.slice(0, 1_000),
			lastBudgetBlockedAt: null,
			lastBudgetBlockedReason: null,
			lastBudgetResetAt: null,
			lastBudgetAdmissionClass: null,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(skillSchedules.id, scheduleId));
}
