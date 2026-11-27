/**
 * Tell the owner when a scheduled skill stops by itself.
 *
 * Repeated failures need the owner's attention without turning the skill off.
 * The scheduler also pauses a schedule whose skill is not turned on. Each puts
 * one item in the owner's inbox so Activity and Decisions explain what happened.
 *
 * The item goes to the person who owns the skill's tedi, or to the
 * organization owner for a shared tedi. An inbox item needs Work context: the
 * Work Item of the failing run, else a project led by the skill's tedi, else
 * the organization's oldest active project.
 */

import { and, asc, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { coreTable } from "../core-store/client";
import { jsonRead } from "../core-store/dialect";
import type { DbQueryClient } from "../query-client";
import {
	skillEntries as d1SkillEntries,
	skillRuns as d1SkillRuns,
	skillSchedules as d1SkillSchedules,
} from "../schema/cognitive";
import { organizationMembers as d1OrganizationMembers } from "../schema/organization-members";
import { projects as d1Projects } from "../schema/projects";
import { tedis as d1Tedis } from "../schema/tedis";
import { workInteractions as d1WorkInteractions } from "../schema/work-factory";
import { workItems as d1WorkItems } from "../schema/work-items";
import { createWorkInteraction } from "./work-items/interactions";

/** `metadata.schema` of the "skill stopped" inbox item. */
export const SKILL_STOPPED_SCHEMA = "tedix.skill-stopped.v1";

export type SkillStopCause =
	/** Runs failed in a row; the skill remains on and needs review. */
	| { kind: "failed_runs"; failedRuns: number; lastError: string | null }
	/** The scheduler found the skill not turned on and paused its schedule. */
	| { kind: "inactive" };

export interface RaiseSkillStoppedNoticeInput {
	organizationId: string;
	skillId: string;
	cause: SkillStopCause;
	/** The run whose failure stopped the skill, when there is one. */
	runId?: string | null;
	now: string;
}

export type SkillStoppedNoticeResult =
	| { raised: true; interactionId: string; recipientUserId: string }
	| {
			raised: false;
			reason:
				| "not_scheduled"
				| "schedule_already_off"
				| "already_told"
				| "no_owner"
				| "no_work_context";
	  };

/** One readable line from a run error: no stack, no line breaks. */
export function plainSkillStopReason(error: string | null | undefined): string {
	const line = (error ?? "")
		.split("\n")
		.map((part) => part.trim())
		.find((part) => part.length > 0);
	const plain = (line ?? "")
		.replace(/^(?:Uncaught\s+)?(?:[A-Za-z]*Error):\s*/, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!plain) return "The run did not say why it failed.";
	return plain.length > 300 ? `${plain.slice(0, 299)}…` : plain;
}

export function skillStoppedNoticeText(input: {
	skillId: string;
	title: string;
	cause: SkillStopCause;
}): { subject: string; prompt: string } {
	const name = `“${input.title.trim().slice(0, 120)}”`;
	// A Markdown link survives the card's text cleaning; a bare id would not.
	const next = `What to do next: [open the skill](/skills/${input.skillId}), fix what stopped it, and run it once to test. After a successful run, open its Schedule page and turn the schedule back on if it is still off.`;
	if (input.cause.kind === "failed_runs") {
		const runs = `${input.cause.failedRuns} failed run${input.cause.failedRuns === 1 ? "" : "s"} in a row`;
		return {
			subject: `${name} needs review after ${runs}`,
			// The error is a list item so the card shows it whole.
			prompt: `${name} remains on after ${runs}.\n\n- Last error: ${plainSkillStopReason(input.cause.lastError)}\n\nWhat to do next: [open the skill](/skills/${input.skillId}), investigate the failures, and test the fix.`,
		};
	}
	return {
		subject: `The schedule of ${name} was paused because the skill is not turned on`,
		prompt: `Tedix paused the schedule of ${name} because the skill is a draft or was switched off. Its scheduled runs have stopped.\n\n${next}`,
	};
}

async function resolveRecipient(
	db: DbQueryClient,
	organizationId: string,
	tediOwnerSubject: string | null,
): Promise<string | null> {
	const organizationMembers = coreTable(db, d1OrganizationMembers);
	const activeHuman = and(
		eq(organizationMembers.organizationId, organizationId),
		eq(organizationMembers.status, "active"),
		eq(organizationMembers.kind, "human"),
		isNotNull(organizationMembers.userId),
	);
	if (tediOwnerSubject) {
		const [owner] = await db
			.select({ userId: organizationMembers.userId })
			.from(organizationMembers)
			.where(
				and(
					activeHuman,
					or(
						eq(organizationMembers.descopeUserId, tediOwnerSubject),
						eq(organizationMembers.userId, tediOwnerSubject),
					),
				),
			)
			.limit(1);
		if (owner?.userId) return owner.userId;
	}
	const [orgOwner] = await db
		.select({ userId: organizationMembers.userId })
		.from(organizationMembers)
		.where(and(activeHuman, eq(organizationMembers.role, "owner")))
		.orderBy(asc(organizationMembers.id))
		.limit(1);
	return orgOwner?.userId ?? null;
}

async function resolveWorkContext(
	db: DbQueryClient,
	input: { organizationId: string; tediId: string; runId?: string | null },
): Promise<{ workItemId: string } | { projectId: string } | null> {
	const workItems = coreTable(db, d1WorkItems);
	const skillRuns = coreTable(db, d1SkillRuns);
	const projects = coreTable(db, d1Projects);
	if (input.runId) {
		const [run] = await db
			.select({ workItemId: workItems.id })
			.from(skillRuns)
			.innerJoin(
				workItems,
				and(
					eq(workItems.orgId, input.organizationId),
					eq(workItems.id, skillRuns.workItemId),
				),
			)
			.where(
				and(
					eq(skillRuns.id, input.runId),
					eq(skillRuns.organizationId, input.organizationId),
				),
			)
			.limit(1);
		if (run) return { workItemId: run.workItemId };
	}
	const [project] = await db
		.select({ id: projects.id })
		.from(projects)
		.where(
			and(
				eq(projects.orgId, input.organizationId),
				eq(projects.status, "active"),
				// The private agent-review project is not a place for owner notices.
				sql`${jsonRead(db, projects.metadata, ["agentReviewTriage"], "json")} IS NULL`,
			),
		)
		.orderBy(
			sql`CASE WHEN ${projects.leadTediId} = ${input.tediId} THEN 0 ELSE 1 END`,
			asc(projects.createdAt),
			asc(projects.id),
		)
		.limit(1);
	return project ? { projectId: project.id } : null;
}

/**
 * Put one "skill stopped" item in the owner's inbox. Safe to call again for
 * the same stop: an open item for the skill, or one raised since the
 * schedule last fired, is not repeated.
 */
export async function raiseSkillStoppedNotice(
	db: DbQueryClient,
	input: RaiseSkillStoppedNoticeInput,
): Promise<SkillStoppedNoticeResult> {
	const skillSchedules = coreTable(db, d1SkillSchedules);
	const skillEntries = coreTable(db, d1SkillEntries);
	const tedis = coreTable(db, d1Tedis);
	const workInteractions = coreTable(db, d1WorkInteractions);
	const [row] = await db
		.select({
			scheduleEnabled: skillSchedules.enabled,
			scheduleLastFireAt: skillSchedules.lastFireAt,
			skillTitle: skillEntries.title,
			skillSlug: skillEntries.slug,
			tediId: skillSchedules.tediId,
			tediOwnerSubject: tedis.ownerUserId,
		})
		.from(skillSchedules)
		.innerJoin(
			skillEntries,
			and(
				eq(skillEntries.id, skillSchedules.skillId),
				eq(skillEntries.organizationId, skillSchedules.organizationId),
			),
		)
		.leftJoin(
			tedis,
			and(
				eq(tedis.id, skillSchedules.tediId),
				eq(tedis.organizationId, skillSchedules.organizationId),
			),
		)
		.where(
			and(
				eq(skillSchedules.skillId, input.skillId),
				eq(skillSchedules.organizationId, input.organizationId),
			),
		)
		.limit(1);
	if (!row) return { raised: false, reason: "not_scheduled" };
	// A schedule someone already turned off did not stop by itself.
	if (input.cause.kind === "failed_runs" && !row.scheduleEnabled)
		return { raised: false, reason: "schedule_already_off" };

	const [previous] = await db
		.select({
			status: workInteractions.status,
			createdAt: workInteractions.createdAt,
		})
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.orgId, input.organizationId),
				// target_type keeps this on idx_work_interactions_target_status.
				eq(workInteractions.targetType, "user"),
				sql`${jsonRead(db, workInteractions.metadata, ["schema"])} = ${SKILL_STOPPED_SCHEMA}`,
				sql`${jsonRead(db, workInteractions.metadata, ["skillId"])} = ${input.skillId}`,
			),
		)
		.orderBy(desc(workInteractions.createdAt))
		.limit(1);
	if (
		previous &&
		(previous.status === "open" ||
			// The scheduler pauses at the next fire after the failures that
			// already told the owner; that is the same stop, not a new one.
			(input.cause.kind === "inactive" &&
				previous.createdAt >= (row.scheduleLastFireAt ?? "")))
	)
		return { raised: false, reason: "already_told" };

	const recipientUserId = await resolveRecipient(
		db,
		input.organizationId,
		row.tediOwnerSubject,
	);
	if (!recipientUserId) return { raised: false, reason: "no_owner" };
	const context = await resolveWorkContext(db, {
		organizationId: input.organizationId,
		tediId: row.tediId,
		runId: input.runId,
	});
	if (!context) return { raised: false, reason: "no_work_context" };

	const text = skillStoppedNoticeText({
		skillId: input.skillId,
		title: row.skillTitle,
		cause: input.cause,
	});
	const created = await createWorkInteraction(db, {
		id: crypto.randomUUID(),
		orgId: input.organizationId,
		...context,
		kind: "coordination",
		subject: text.subject,
		prompt: text.prompt,
		creator: { type: "system", id: "tedix" },
		targetType: "user",
		targetId: recipientUserId,
		metadata: {
			schema: SKILL_STOPPED_SCHEMA,
			skillId: input.skillId,
			skillSlug: row.skillSlug,
			tediId: row.tediId,
			stopCause: input.cause.kind,
			...(input.cause.kind === "failed_runs"
				? { failedRuns: input.cause.failedRuns }
				: {}),
			...(input.runId ? { runId: input.runId } : {}),
			triage: { status: "ok", urgency: "now" },
		},
		now: input.now,
	});
	return { raised: true, interactionId: created.id, recipientUserId };
}
