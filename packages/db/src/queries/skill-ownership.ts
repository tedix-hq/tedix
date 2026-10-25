/**
 * Skill ownership transfer: which tedi owns a skill and runs its schedule.
 *
 * The scheduler only dispatches a schedule whose tedi matches the skill's
 * owner, so the owner and the schedule move together in one batch, with the
 * audit event that names the previous owner. The audit row is inserted from
 * the moved skill row, so a lost race (the owner changed after the caller's
 * read) writes nothing at all.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { auditEvents } from "../schema/audit-events";
import {
	type SkillSchedule,
	skillEntries,
	skillRuns,
	skillSchedules,
} from "../schema/cognitive";

/** Run states that still execute, or wait to, under the run's tedi. */
const IN_FLIGHT_RUN_STATUSES = ["queued", "running", "paused"] as const;

export interface InFlightSkillRun {
	id: string;
	tediId: string;
	status: string;
	startedAt: string | null;
}

/** Runs of one skill that have not reached a terminal state, newest first. */
export async function listInFlightSkillRuns(
	db: DbClient,
	params: { organizationId: string; skillId: string; limit?: number },
): Promise<InFlightSkillRun[]> {
	return db
		.select({
			id: skillRuns.id,
			tediId: skillRuns.tediId,
			status: skillRuns.status,
			startedAt: skillRuns.startedAt,
		})
		.from(skillRuns)
		.where(
			and(
				eq(skillRuns.organizationId, params.organizationId),
				eq(skillRuns.skillId, params.skillId),
				inArray(skillRuns.status, [...IN_FLIGHT_RUN_STATUSES]),
			),
		)
		.orderBy(desc(skillRuns.startedAt))
		.limit(Math.min(Math.max(params.limit ?? 20, 1), 100));
}

export interface SkillReference {
	id: string;
	slug: string | null;
	title: string;
	tediId: string | null;
}

/**
 * Non-archived skills a request names: by id, slug or exact title first; a
 * title that merely contains the words only when nothing matched exactly.
 */
export async function findSkillsByReference(
	db: DbClient,
	params: { organizationId: string; reference: string; limit?: number },
): Promise<SkillReference[]> {
	const reference = params.reference.trim();
	if (!reference) return [];
	const lowered = reference.toLowerCase();
	const columns = {
		id: skillEntries.id,
		slug: skillEntries.slug,
		title: skillEntries.title,
		tediId: skillEntries.tediId,
	};
	const scope = and(
		eq(skillEntries.organizationId, params.organizationId),
		sql`coalesce(${skillEntries.lifecycleState}, '') <> 'archived'`,
	);
	const limit = Math.min(Math.max(params.limit ?? 5, 1), 20);
	const exact = await db
		.select(columns)
		.from(skillEntries)
		.where(
			and(
				scope,
				sql`(${skillEntries.id} = ${reference} OR ${skillEntries.slug} = ${lowered} OR lower(${skillEntries.title}) = ${lowered})`,
			),
		)
		.limit(limit);
	if (exact.length > 0) return exact;
	return db
		.select(columns)
		.from(skillEntries)
		.where(and(scope, sql`instr(lower(${skillEntries.title}), ${lowered}) > 0`))
		.orderBy(skillEntries.title)
		.limit(limit);
}

export interface MoveSkillToTediParams {
	organizationId: string;
	skillId: string;
	/** The owner the caller read; null for a skill that had none. */
	fromTediId: string | null;
	toTediId: string;
	audit: {
		actorId: string;
		actorType: string;
		action: string;
		metadata: Record<string, JsonValue>;
	};
	now?: Date;
}

export interface MoveSkillToTediResult {
	moved: boolean;
	auditEventId: string | null;
	schedule: SkillSchedule | null;
}

/**
 * Move a skill's ownership and its schedule to another tedi in one D1 batch.
 * The schedule keeps its cron, params, enabled state and next fire; only its
 * tedi changes. `moved` is false when the owner was no longer `fromTediId`.
 */
export async function moveSkillToTedi(
	db: DbClient,
	params: MoveSkillToTediParams,
): Promise<MoveSkillToTediResult> {
	const now = params.now ?? new Date();
	const updatedAt = now.toISOString();
	const auditEventId = crypto.randomUUID();
	// The row this batch's first statement wrote: the target owner AND this
	// write's timestamp, so a concurrent move to the same target is not mistaken
	// for ours.
	const movedSkill = and(
		eq(skillEntries.id, params.skillId),
		eq(skillEntries.organizationId, params.organizationId),
		eq(skillEntries.tediId, params.toTediId),
		eq(skillEntries.updatedAt, updatedAt),
	);
	const [skillRows] = await db.batch([
		db
			.update(skillEntries)
			.set({ tediId: params.toTediId, updatedAt })
			.where(
				and(
					eq(skillEntries.id, params.skillId),
					eq(skillEntries.organizationId, params.organizationId),
					params.fromTediId === null
						? isNull(skillEntries.tediId)
						: eq(skillEntries.tediId, params.fromTediId),
				),
			)
			.returning({ id: skillEntries.id }),
		db
			.update(skillSchedules)
			.set({ tediId: params.toTediId, updatedAt })
			.where(
				and(
					eq(skillSchedules.skillId, params.skillId),
					eq(skillSchedules.organizationId, params.organizationId),
					sql`exists (select 1 from ${skillEntries} where ${movedSkill})`,
				),
			),
		db.insert(auditEvents).select(
			db
				.select({
					id: sql<string>`${auditEventId}`.as("id"),
					organizationId: skillEntries.organizationId,
					actorId: sql<string>`${params.audit.actorId}`.as("actor_id"),
					actorType: sql<string>`${params.audit.actorType}`.as("actor_type"),
					action: sql<string>`${params.audit.action}`.as("action"),
					resourceType: sql<string>`'skill'`.as("resource_type"),
					resourceId: skillEntries.id,
					metadata: sql<string>`${JSON.stringify(params.audit.metadata)}`.as(
						"metadata",
					),
					ipAddress: sql<null>`NULL`.as("ip_address"),
					userAgent: sql<null>`NULL`.as("user_agent"),
					timestamp: sql<number>`${Math.floor(now.getTime() / 1000)}`.as(
						"timestamp",
					),
				})
				.from(skillEntries)
				.where(movedSkill),
		),
	]);
	const moved = skillRows.length > 0;
	const [schedule] = await db
		.select()
		.from(skillSchedules)
		.where(
			and(
				eq(skillSchedules.skillId, params.skillId),
				eq(skillSchedules.organizationId, params.organizationId),
			),
		)
		.limit(1);
	return {
		moved,
		auditEventId: moved ? auditEventId : null,
		schedule: schedule ?? null,
	};
}
