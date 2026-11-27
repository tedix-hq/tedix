import { and, eq, exists, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import type { DbClient } from "../../client";
import { coreTable } from "../../core-store/client";
import { coreStore } from "../../core-store/dialect";
import {
	skillEntries,
	skillSchedules,
	type NewSkillEntry,
	type SkillEntry,
} from "../../schema/cognitive";
import { disableSkillScheduleInContent } from "../skill-schedules";
import { paceLayerForLifecycle } from "../skill-lifecycle";
import { resolveSkillMcpAppBindings } from "./skill-mcp-bindings";

function removableCopy(db: object, now: Date, abandonedOnly: boolean) {
	const cutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
	if (coreStore(db) === "postgres")
		return sql`skill_entries.source_skill_id IS NOT NULL
		AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(skill_entries.tags) = 'array' THEN skill_entries.tags ELSE '[]'::jsonb END) AS tag(value) WHERE tag.value = 'workflow-improvement')
		AND skill_entries.improvement_adoption IS NULL
		AND NOT EXISTS (SELECT 1 FROM skill_runs r WHERE r.skill_id = skill_entries.id
			AND r.status NOT IN ('completed', 'failed', 'canceled'))
		AND EXISTS (SELECT 1 FROM skill_entries main WHERE main.id = skill_entries.source_skill_id
			AND main.organization_id = skill_entries.organization_id
			AND strpos(coalesce(main.revision_reasoning, ''), 'Workflow improvement ' || skill_entries.id || ' activated by ') = 0
			AND (${!abandonedOnly}::boolean OR main.revision > skill_entries.source_revision
				OR (skill_entries.lifecycle_state = 'draft'
					AND coalesce(skill_entries.updated_at, skill_entries.created_at)::timestamptz <= ${cutoff}::timestamptz)))`;
	return sql`skill_entries.source_skill_id IS NOT NULL
		AND EXISTS (SELECT 1 FROM json_each(skill_entries.tags) WHERE value = 'workflow-improvement')
		AND skill_entries.improvement_adoption IS NULL
		AND NOT EXISTS (SELECT 1 FROM skill_runs r WHERE r.skill_id = skill_entries.id
			AND r.status NOT IN ('completed', 'failed', 'canceled'))
		AND EXISTS (SELECT 1 FROM skill_entries main WHERE main.id = skill_entries.source_skill_id
			AND main.organization_id = skill_entries.organization_id
			AND instr(coalesce(main.revision_reasoning, ''), 'Workflow improvement ' || skill_entries.id || ' activated by ') = 0
			AND (${!abandonedOnly} OR main.revision > skill_entries.source_revision
				OR (skill_entries.lifecycle_state = 'draft'
					AND julianday(coalesce(skill_entries.updated_at, skill_entries.created_at)) <= julianday(${cutoff}))))`;
}

/** History and cascade deletion commit together, using the same live guards. */
export async function removeSkillImprovementCopy(
	db: DbQueryClient,
	params: {
		organizationId: string;
		id: string;
		reason: string;
		abandonedOnly?: boolean;
		now?: Date;
	},
): Promise<boolean> {
	const now = params.now ?? new Date();
	const [copy] = await db
		.select({ sourceSkillId: skillEntries.sourceSkillId })
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.id, params.id),
				eq(skillEntries.organizationId, params.organizationId),
			),
		)
		.limit(1);
	if (!copy?.sourceSkillId) return false;
	const eligible = and(
		eq(skillEntries.id, params.id),
		eq(skillEntries.organizationId, params.organizationId),
		eq(skillEntries.sourceSkillId, copy.sourceSkillId),
		removableCopy(db, now, params.abandonedOnly ?? false),
	)!;
	const note = `Removed 1 workflow improvement copy (${params.id}): ${params.reason}`;
	if (coreStore(db) === "postgres") {
		// Postgres has no changes(): the note reads the DELETE receipt in the same statement.
		const removed = db
			.$with("removed", { id: skillEntries.id })
			.as(
				db
					.delete(skillEntries)
					.where(eligible)
					.returning({ id: skillEntries.id })
					.getSQL(),
			);
		const noted = db.$with("noted", { id: skillEntries.id }).as(
			db
				.update(skillEntries)
				.set({
					revisionReasoning: sql`coalesce(${skillEntries.revisionReasoning} || chr(10), '') || ${note}`,
				})
				.where(
					and(
						eq(skillEntries.organizationId, params.organizationId),
						eq(skillEntries.id, copy.sourceSkillId),
						sql`EXISTS (SELECT 1 FROM ${removed})`,
					),
				)
				.returning({ id: skillEntries.id })
				.getSQL(),
		);
		const rows = await db
			.with(removed, noted)
			.select({ id: removed.id })
			.from(removed);
		return rows.length === 1;
	}
	const [removed] = await db.batch([
		db.delete(skillEntries).where(eligible).returning({ id: skillEntries.id }),
		db
			.update(skillEntries)
			.set({
				revisionReasoning: sql`coalesce(${skillEntries.revisionReasoning} || char(10), '') || ${note}`,
			})
			.where(
				and(
					eq(skillEntries.organizationId, params.organizationId),
					eq(skillEntries.id, copy.sourceSkillId),
					sql`changes() = 1`,
				),
			),
	]);
	return removed.length === 1;
}

/** Bounded daily maintenance; protected rows never consume the page. */
export async function sweepAbandonedSkillImprovements(
	db: DbQueryClient,
	params: { now?: Date; limit?: number } = {},
): Promise<{ removedIds: string[] }> {
	const now = params.now ?? new Date();
	const entries = await db
		.select({
			id: skillEntries.id,
			organizationId: skillEntries.organizationId,
		})
		.from(skillEntries)
		.where(removableCopy(db, now, true))
		.orderBy(skillEntries.id)
		.limit(params.limit ?? 500);
	const removedIds: string[] = [];
	for (const entry of entries) {
		if (
			await removeSkillImprovementCopy(db, {
				...entry,
				now,
				abandonedOnly: true,
				reason:
					"The main skill has advanced, or this draft has had no review or changes for 7 days.",
			})
		)
			removedIds.push(entry.id);
	}
	return { removedIds };
}

/** Adoption must win or lose as a unit against rejection and the daily sweep. */
export async function adoptSkillImprovementCopy(
	db: DbClient,
	params: {
		baseline: SkillEntry;
		proposal: SkillEntry;
		baselineUpdates: Partial<NewSkillEntry>;
		proposalUpdates: Partial<NewSkillEntry>;
	},
): Promise<boolean> {
	const { baseline, proposal } = params;
	const mcpAppBindings = await resolveSkillMcpAppBindings(db, {
		organizationId: baseline.organizationId,
		content: params.baselineUpdates.content ?? baseline.content,
		existing: baseline.mcpAppBindings,
	});
	const proposalGuard = and(
		eq(skillEntries.id, proposal.id),
		eq(skillEntries.organizationId, baseline.organizationId),
		eq(skillEntries.revision, proposal.revision),
		eq(skillEntries.sourceSkillId, baseline.id),
		sql`${skillEntries.improvementAdoption} IS NULL`,
	)!;
	const schedules = coreTable(db, skillSchedules);
	const [updated] = await db.batch([
		db
			.update(skillEntries)
			.set({
				...params.baselineUpdates,
				mcpAppBindings,
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					eq(skillEntries.id, baseline.id),
					eq(skillEntries.organizationId, baseline.organizationId),
					eq(skillEntries.revision, baseline.revision),
					sql`coalesce(${skillEntries.revisionReasoning}, '') = ${baseline.revisionReasoning ?? ""}`,
					exists(
						db
							.select({ id: skillEntries.id })
							.from(skillEntries)
							.where(proposalGuard),
					),
				),
			)
			.returning({ id: skillEntries.id }),
		db
			.update(skillEntries)
			.set({
				...params.proposalUpdates,
				paceLayer: paceLayerForLifecycle("archived"),
				content: disableSkillScheduleInContent(proposal.content),
				updatedAt: new Date().toISOString(),
			})
			.where(
				and(
					proposalGuard,
					coreStore(db) === "postgres"
						? // The baseline row version was written by this transaction.
							sql`EXISTS (SELECT 1 FROM skill_entries b WHERE b.id = ${baseline.id} AND b.xmin = pg_current_xact_id()::xid)`
						: sql`changes() = 1`,
				),
			),
		db
			.update(schedules)
			.set({ enabled: false, updatedAt: new Date().toISOString() })
			.where(
				and(
					eq(schedules.skillId, proposal.id),
					eq(schedules.organizationId, baseline.organizationId),
					sql`EXISTS (SELECT 1 FROM skill_entries p WHERE p.id = ${proposal.id} AND p.improvement_adoption IS NOT NULL)`,
				),
			),
	]);
	return updated.length === 1;
}
