/**
 * `pause_skill_schedule` / `resume_skill_schedule` /
 * `update_skill_schedule`: change one skill's `capabilities.schedule`
 * policy and nothing else.
 *
 * A schedule is manifest-owned, so the only way to change it is a skill
 * revision; `improve_skills` can do that but rewrites whatever content it is
 * handed and sits behind a human card for agent callers. These verbs change
 * exactly the named keys, through the same improve path (so the D1 schedule
 * row and the manifest stay in step and the scheduler's drift check holds),
 * and their names fall under the platform's `skills_and_schedules` autonomy
 * default for the organization's own people and tedis. The schedule-owner
 * check inside improve still applies: a tedi may only change a schedule on a
 * skill it owns.
 */
import { createRouterClient } from "@orpc/server";
import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/skill-schedule";
import { getSkillEntry } from "@tedix/db/queries/cognitive/skill-crud";
import { getSkillSchedule } from "@tedix/db/queries/skill-schedules";
import {
	setFactoryScheduleCron,
	setFactoryScheduleEnabled,
} from "../../services/factory-lifecycle";
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

export const skillsUpdateSchedule = authedSkills.updateSchedule
	.use(AUTHZ.tedisWrite)
	.handler(async ({ context, input }) => {
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
		const cron = input.cron?.trim();
		if (cron !== undefined) {
			try {
				nextSkillScheduleFireAt(cron, Date.now());
			} catch (error) {
				throw createError(
					ErrorCodes.BAD_REQUEST,
					`Invalid five-field UTC cron "${cron}": ${error instanceof Error ? error.message : String(error)}`,
					{ code: "SKILL_SCHEDULE_CRON_INVALID", skillId: skill.id },
				);
			}
		}
		const result = (
			changed: boolean,
			row: { cron: string; enabled: boolean; nextFireAt: string },
		) => ({
			skillId: skill.id,
			slug: skill.slug,
			action: "updated" as const,
			changed,
			cron: row.cron,
			scheduleEnabled: row.enabled,
			nextFireAt: row.enabled ? row.nextFireAt : null,
		});
		const cronChanged = cron !== undefined && cron !== before.cron;
		const enabledChanged =
			input.enabled !== undefined && input.enabled !== before.enabled;
		if (!cronChanged && !enabledChanged) {
			return result(false, before);
		}
		let content: string;
		try {
			content = skill.content ?? "";
			if (enabledChanged) {
				content = setFactoryScheduleEnabled(content, input.enabled === true);
			}
			if (cron !== undefined && cronChanged) {
				content = setFactoryScheduleCron(content, cron);
			}
		} catch (error) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Skill manifest cannot be edited in place: ${error instanceof Error ? error.message : String(error)}`,
				{ code: "SKILL_SCHEDULE_MANIFEST_INVALID", skillId: skill.id },
			);
		}
		const changes = [
			cronChanged ? `cron ${before.cron} -> ${cron}` : null,
			enabledChanged ? (input.enabled ? "enabled" : "disabled") : null,
		].filter(Boolean);
		const client = createRouterClient({ improve: skillsImprove }, { context });
		await client.improve({
			id: skill.id,
			content,
			revisionReasoning: `Update the schedule of ${skill.slug}; only capabilities.schedule changed (${changes.join(", ")}).`,
		});
		const after = await getSkillSchedule(context.db, skill.id, orgId);
		return result(true, after ?? before);
	});
