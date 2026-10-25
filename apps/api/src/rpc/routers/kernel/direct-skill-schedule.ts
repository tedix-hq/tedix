/**
 * "Pause/resume the schedule of skill X", resolved without a model.
 *
 * Routed by the model, this became a delegation to the skill's tedi, which
 * has no tool that edits its own schedule policy, or an `improve_skills`
 * rewrite behind a human card. The request names one exact call,
 * `skills.pause_skill_schedule` / `skills.resume_skill_schedule`, which flips
 * `capabilities.schedule.enabled` and nothing else. The API still checks the
 * caller may edit that skill's schedule; the write then follows the normal
 * approval policy (the platform default for the organization's own people).
 */
import type { DbClient } from "@tedix/db/client";
import { findSkillsByReference } from "@tedix/db/queries/skill-ownership";
import type { KernelResult } from "./index";
import {
	PAUSE_SKILL_SCHEDULE_TOOL,
	RESUME_SKILL_SCHEDULE_TOOL,
	type SkillScheduleIntent,
	stripContextMarkers,
} from "./write-tool-intent";

const SCHEDULE_RE =
	/^(?:(?:please|can you|could you|would you)\s+)?(pause|disable|stop|resume|re-enable|enable|unpause)\s+(?:the\s+)?(?:schedules?|scheduled\s+runs?|cron|timer)\s+(?:of|for|on)\s+(?:the\s+)?(?:skill\s+)?(.+?)(?:\s+skill)?$/i;
const HELP_QUESTION_RE =
	/^(?:how|why|what|when|where|should|is|are|do|does)\b|\bhow (?:do|can|would) (?:i|we)\b/i;

export interface SkillScheduleRequest {
	action: "pause" | "resume";
	skill: string;
}

function unquote(value: string): string {
	return value
		.trim()
		.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
		.trim();
}

/** The action and skill a schedule request names, or null when it is not one. */
export function parseSkillScheduleRequest(
	content: string,
): SkillScheduleRequest | null {
	const text = stripContextMarkers(content)
		.trim()
		.replace(/[\s.!]+$/, "");
	if (!text || text.length > 300 || text.includes("\n")) return null;
	if (HELP_QUESTION_RE.test(text)) return null;
	if (/^(?:don't|do not|never)\b/i.test(text)) return null;
	const match = SCHEDULE_RE.exec(text.replace(/\?$/, ""));
	if (!match?.[1] || !match[2]) return null;
	const verb = match[1].toLowerCase();
	const action: SkillScheduleRequest["action"] =
		verb === "pause" || verb === "disable" || verb === "stop"
			? "pause"
			: "resume";
	const skill = unquote(
		match[2]
			.replace(/\s+(?:please|now|today|tonight)$/i, "")
			.replace(/^(?:the|this|my|our)\s+/i, "")
			.replace(/^skill\s+/i, ""),
	);
	// "the schedules of the reddit skills" is many skills, not one call.
	if (!skill || /\bskills\b/i.test(skill) || /\b(?:and|,)\b/.test(skill))
		return null;
	return { action, skill };
}

export interface DirectSkillSchedule {
	intent: SkillScheduleIntent;
	action: "pause" | "resume";
	skillTitle: string;
}

/**
 * Resolve the request to exactly one skill of the organization. Null when the
 * request is not a schedule change or the reference is unknown or ambiguous;
 * the tool itself refuses a skill without a schedule with the reason.
 */
export async function resolveDirectSkillSchedule(
	db: DbClient,
	input: { organizationId: string; content: string },
): Promise<DirectSkillSchedule | null> {
	const request = parseSkillScheduleRequest(input.content);
	if (!request) return null;
	const skills = await findSkillsByReference(db, {
		organizationId: input.organizationId,
		reference: request.skill,
		limit: 2,
	});
	if (skills.length !== 1) return null;
	const skill = skills[0]!;
	return {
		intent:
			request.action === "pause"
				? {
						capability: "skills.pause_schedule",
						toolName: PAUSE_SKILL_SCHEDULE_TOOL,
						args: { id: skill.id },
					}
				: {
						capability: "skills.resume_schedule",
						toolName: RESUME_SKILL_SCHEDULE_TOOL,
						args: { id: skill.id },
					},
		action: request.action,
		skillTitle: skill.title,
	};
}

/** The write route for a resolved schedule change; never a delegation. */
export function directSkillScheduleKernelResult(
	schedule: DirectSkillSchedule,
	appSlug: string,
): KernelResult {
	const answer =
		schedule.action === "pause"
			? `Pause the schedule of “${schedule.skillTitle}”; its cron, params and workflow stay as they are.`
			: `Resume the schedule of “${schedule.skillTitle}” with its existing cadence.`;
	return {
		assistantContent: answer,
		route: {
			routeKind: "propose_tool_write",
			answer,
			rationale:
				"A skill's schedule policy changes through one platform call; its tedi has no tool for it, so this is not delegated.",
			risk: "medium",
			confidence: 1,
			effortClass: "single_read",
			targetTediId: null,
			targetTediLabel: null,
			targetActivityId: null,
			plannedToolIds: [],
			toolIntent: {
				appSlug,
				capability: schedule.intent.capability,
				connectionStatus: "connected",
			},
			workflowHint: null,
			clarifyingQuestion: null,
			evidenceExpectation: null,
		},
		workWriteGateway: null,
		delegation: null,
		routeUsage: null,
		contextManifest: {
			version: 1,
			budgetTokens: 0,
			sources: [],
			historyCompaction: null,
			recall: "static",
			recallAgeMs: null,
			recallCandidates: 0,
			recallWaitedMs: 0,
		},
	};
}
