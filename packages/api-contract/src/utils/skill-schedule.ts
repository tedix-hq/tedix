import { parse as parseYaml } from "yaml";
import { isRecord } from "./is-record";

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

type CronField = Set<number>;
type ParsedCron = {
	minute: CronField;
	hour: CronField;
	dayOfMonth: CronField;
	month: CronField;
	dayOfWeek: CronField;
	dayOfMonthWildcard: boolean;
	dayOfWeekWildcard: boolean;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseField(
	source: string,
	minimum: number,
	maximum: number,
	dayOfWeek = false,
): CronField {
	const values = new Set<number>();
	for (const part of source.split(",")) {
		const [rangeSource, stepSource] = part.split("/");
		const step = stepSource === undefined ? 1 : Number(stepSource);
		if (!Number.isInteger(step) || step < 1) throw new Error("invalid step");
		let start: number;
		let end: number;
		if (rangeSource === "*") {
			start = minimum;
			end = maximum;
		} else if (rangeSource?.includes("-")) {
			const [startSource, endSource] = rangeSource.split("-");
			start = Number(startSource);
			end = Number(endSource);
		} else {
			start = Number(rangeSource);
			end = start;
		}
		if (
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			start < minimum ||
			end > maximum ||
			start > end
		) {
			throw new Error("value outside allowed range");
		}
		for (let value = start; value <= end; value += step) {
			values.add(dayOfWeek && value === 7 ? 0 : value);
		}
	}
	if (values.size === 0) throw new Error("empty field");
	return values;
}

function parseCron(cron: string): ParsedCron {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error("cron must contain exactly five UTC fields");
	}
	return {
		minute: parseField(fields[0]!, 0, 59),
		hour: parseField(fields[1]!, 0, 23),
		dayOfMonth: parseField(fields[2]!, 1, 31),
		month: parseField(fields[3]!, 1, 12),
		dayOfWeek: parseField(fields[4]!, 0, 7, true),
		dayOfMonthWildcard: fields[2] === "*",
		dayOfWeekWildcard: fields[4] === "*",
	};
}

function matchesCronDay(date: Date, parsed: ParsedCron): boolean {
	const dayOfMonthMatches = parsed.dayOfMonth.has(date.getUTCDate());
	const dayOfWeekMatches = parsed.dayOfWeek.has(date.getUTCDay());
	const dayMatches = parsed.dayOfMonthWildcard
		? dayOfWeekMatches
		: parsed.dayOfWeekWildcard
			? dayOfMonthMatches
			: dayOfMonthMatches || dayOfWeekMatches;
	return dayMatches && parsed.month.has(date.getUTCMonth() + 1);
}

export function nextSkillScheduleFireAt(
	cron: string,
	after: Date | string | number,
): string {
	const parsed = parseCron(cron);
	const start = new Date(after);
	if (!Number.isFinite(start.getTime())) throw new Error("invalid start time");
	const hours = [...parsed.hour].sort((left, right) => left - right);
	const minutes = [...parsed.minute].sort((left, right) => left - right);
	const day = new Date(
		Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
	);
	for (let offset = 0; offset < 5 * 366; offset++) {
		if (matchesCronDay(day, parsed)) {
			for (const hour of hours) {
				for (const minute of minutes) {
					const candidate = new Date(
						Date.UTC(
							day.getUTCFullYear(),
							day.getUTCMonth(),
							day.getUTCDate(),
							hour,
							minute,
						),
					);
					if (candidate.getTime() > start.getTime()) {
						return candidate.toISOString();
					}
				}
			}
		}
		day.setUTCDate(day.getUTCDate() + 1);
	}
	throw new Error("cron has no fire time within the next five years");
}

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
			parseCron(raw.cron);
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
