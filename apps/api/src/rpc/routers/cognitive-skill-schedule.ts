/**
 * `pause_skill_schedule` / `resume_skill_schedule`: flip one skill's
 * `capabilities.schedule.enabled` and nothing else.
 *
 * A schedule is manifest-owned, so the only way to stop it firing is a skill
 * revision; `improve_skills` can do that but rewrites whatever content it is
 * handed and sits behind a human card for agent callers. These two verbs
 * change exactly one key, through the same improve path (so the D1 schedule
 * row and the manifest stay in step and the scheduler's drift check holds),
 * and their names fall under the platform's `skills_and_schedules` autonomy
 * default for the organization's own people and tedis. The schedule-owner
 * check inside improve still applies: a tedi may only pause a skill it owns.
 */
import { createRouterClient } from "@orpc/server";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { getSkillSchedule } from "@tedix/db/queries/skill-schedules";
import { setFactoryScheduleEnabled } from "../../services/factory-lifecycle";
import { type BaseContext, AUTHZ, createError, ErrorCodes } from "../orpc";
import { requireOrgIdOrInput } from "../org-scope";
import { authedSkills } from "./cognitive-shared";
import { skillsImprove } from "./cognitive-skill-catalog";

type ScheduleAction = "paused" | "resumed";

async function controlSkillSchedule(
	context: BaseContext,
	input: { organizationId?: string; id: string },
	action: ScheduleAction,
) {
	const enabled = action === "resumed";
	const orgId = requireOrgIdOrInput(context, input.organizationId);
	const skill = await getSkillEntry(context.db, input.id, orgId);
	if (!skill) throw createError(ErrorCodes.NOT_FOUND, "Skill not found");
	const before = await getSkillSchedule(context.db, skill.id, orgId);
	if (!before) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			"Skill has no schedule: declare capabilities.schedule in its manifest first",
			{ code: "SKILL_SCHEDULE_NOT_FOUND", skillId: skill.id },
		);
	}
	const result = (
		changed: boolean,
		scheduleEnabled: boolean,
		next: string,
	) => ({
		skillId: skill.id,
		slug: skill.slug,
		action,
		changed,
		scheduleEnabled,
		nextFireAt: scheduleEnabled ? next : null,
	});
	if (before.enabled === enabled) {
		return result(false, before.enabled, before.nextFireAt);
	}
	let content: string;
	try {
		content = setFactoryScheduleEnabled(skill.content ?? "", enabled);
	} catch (error) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			`Skill manifest cannot be edited in place: ${error instanceof Error ? error.message : String(error)}`,
			{ code: "SKILL_SCHEDULE_MANIFEST_INVALID", skillId: skill.id },
		);
	}
	const client = createRouterClient({ improve: skillsImprove }, { context });
	await client.improve({
		id: skill.id,
		content,
		revisionReasoning: `${enabled ? "Resume" : "Pause"} the schedule of ${skill.slug}; only capabilities.schedule.enabled changed.`,
	});
	const after = await getSkillSchedule(context.db, skill.id, orgId);
	return result(
		true,
		after?.enabled ?? false,
		after?.nextFireAt ?? before.nextFireAt,
	);
}

export const skillsPauseSchedule = authedSkills.pauseSchedule
	.use(AUTHZ.tedisWrite)
	.handler(({ context, input }) =>
		controlSkillSchedule(context, input, "paused"),
	);

export const skillsResumeSchedule = authedSkills.resumeSchedule
	.use(AUTHZ.tedisWrite)
	.handler(({ context, input }) =>
		controlSkillSchedule(context, input, "resumed"),
	);
