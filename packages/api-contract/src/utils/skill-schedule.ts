import { parse as parseYaml } from "yaml";
import { isRecord } from "./is-record";
import { nextSkillScheduleFireAt } from "./cron-schedule";

export interface SkillSchedulePolicy {
	cron: string;
	params: Record<string, unknown>;
	enabled: boolean;
	executionKind: "deterministic" | "inference";
}

export interface SkillScheduleIssue {
	code: "SKILL_SCHEDULE_INVALID";
	message: string;
	path: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function readSkillSchedulePolicy(
	skillDoc: string,
): SkillSchedulePolicy | null {
	const frontmatter = skillDoc.match(FRONTMATTER_RE)?.[1];
	if (!frontmatter) return null;
	let parsed: unknown;
	try {
		parsed = parseYaml(frontmatter);
	} catch {
		return null;
	}
	if (!isRecord(parsed) || !isRecord(parsed.capabilities)) return null;
	const raw = parsed.capabilities.schedule;
	if (!isRecord(raw) || typeof raw.cron !== "string") return null;
	return {
		cron: raw.cron,
		params: isRecord(raw.params) ? raw.params : {},
		enabled: raw.enabled !== false,
		executionKind:
			raw.executionKind === "inference" ? "inference" : "deterministic",
	};
}

export function validateSkillSchedulePolicy(skillDoc: string): {
	schedule: SkillSchedulePolicy | null;
	issues: SkillScheduleIssue[];
} {
	const frontmatter = skillDoc.match(FRONTMATTER_RE)?.[1];
	if (!frontmatter) return { schedule: null, issues: [] };
	let parsed: unknown;
	try {
		parsed = parseYaml(frontmatter);
	} catch {
		return { schedule: null, issues: [] };
	}
	if (!isRecord(parsed) || !isRecord(parsed.capabilities)) {
		return { schedule: null, issues: [] };
	}
	const raw = parsed.capabilities.schedule;
	if (raw === undefined || raw === null) return { schedule: null, issues: [] };
	const issues: SkillScheduleIssue[] = [];
	if (!isRecord(raw)) {
		return {
			schedule: null,
			issues: [
				{
					code: "SKILL_SCHEDULE_INVALID",
					message: "capabilities.schedule must be a mapping",
					path: "capabilities.schedule",
				},
			],
		};
	}
	for (const key of Object.keys(raw)) {
		if (
			key !== "cron" &&
			key !== "params" &&
			key !== "enabled" &&
			key !== "executionKind"
		) {
			issues.push({
				code: "SKILL_SCHEDULE_INVALID",
				message: `capabilities.schedule.${key} is not supported`,
				path: `capabilities.schedule.${key}`,
			});
		}
	}
	if (typeof raw.cron !== "string" || raw.cron.trim().length === 0) {
		issues.push({
			code: "SKILL_SCHEDULE_INVALID",
			message:
				"capabilities.schedule.cron must be a five-field UTC cron string",
			path: "capabilities.schedule.cron",
		});
	} else {
		try {
			nextSkillScheduleFireAt(raw.cron, Date.now());
		} catch (error) {
			issues.push({
				code: "SKILL_SCHEDULE_INVALID",
				message: `Invalid capabilities.schedule.cron: ${error instanceof Error ? error.message : String(error)}`,
				path: "capabilities.schedule.cron",
			});
		}
	}
	if (raw.params !== undefined && !isRecord(raw.params)) {
		issues.push({
			code: "SKILL_SCHEDULE_INVALID",
			message: "capabilities.schedule.params must be an object",
			path: "capabilities.schedule.params",
		});
	}
	if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
		issues.push({
			code: "SKILL_SCHEDULE_INVALID",
			message: "capabilities.schedule.enabled must be a boolean",
			path: "capabilities.schedule.enabled",
		});
	}
	if (
		raw.executionKind !== undefined &&
		raw.executionKind !== "deterministic" &&
		raw.executionKind !== "inference"
	) {
		issues.push({
			code: "SKILL_SCHEDULE_INVALID",
			message:
				"capabilities.schedule.executionKind must be deterministic or inference",
			path: "capabilities.schedule.executionKind",
		});
	}
	return {
		schedule:
			issues.length === 0
				? {
						cron: String(raw.cron),
						params: isRecord(raw.params) ? raw.params : {},
						enabled: raw.enabled !== false,
						executionKind:
							raw.executionKind === "inference" ? "inference" : "deterministic",
					}
				: null,
		issues,
	};
}
