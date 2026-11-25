import type { WorkspaceSkillRunsAt } from "../schemas/os-workspace-schedules";

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

const GREGORIAN_CALENDAR_CYCLE_DAYS = 400 * 365 + 97;
const CRON_PART_RE = /^(?:\*|\d+(?:-\d+)?)(?:\/\d+)?$/;

function parseField(
	source: string,
	minimum: number,
	maximum: number,
	dayOfWeek = false,
): CronField {
	const values = new Set<number>();
	for (const part of source.split(",")) {
		if (!CRON_PART_RE.test(part)) throw new Error(`invalid cron token ${part}`);
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
			end = stepSource === undefined ? start : maximum;
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
		dayOfMonthWildcard: fields[2]!.startsWith("*"),
		dayOfWeekWildcard: fields[4]!.startsWith("*"),
	};
}

function matchesCronDay(date: Date, parsed: ParsedCron): boolean {
	const dayOfMonthMatches = parsed.dayOfMonth.has(date.getUTCDate());
	const dayOfWeekMatches = parsed.dayOfWeek.has(date.getUTCDay());
	const dayMatches =
		parsed.dayOfMonthWildcard || parsed.dayOfWeekWildcard
			? dayOfMonthMatches && dayOfWeekMatches
			: dayOfMonthMatches || dayOfWeekMatches;
	return dayMatches && parsed.month.has(date.getUTCMonth() + 1);
}

export function skillScheduleFiresDaily(
	cron: string,
	firstDay: number = Date.UTC(2026, 0, 5),
): boolean {
	const DAY_MS = 24 * 60 * 60 * 1000;
	for (let day = 0; day < 14; day++) {
		const dayStart = firstDay + day * DAY_MS;
		const next = Date.parse(nextSkillScheduleFireAt(cron, dayStart - 1));
		if (next >= dayStart + DAY_MS) return false;
	}
	return true;
}

export function nextSkillScheduleFireAt(
	cron: string,
	after: Date | string | number,
	runsAt?: WorkspaceSkillRunsAt | null,
): string {
	if (runsAt) {
		const formatter = new Intl.DateTimeFormat("en-GB", {
			timeZone: runsAt.timeZone,
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		const start = new Date(after).getTime();
		if (!Number.isFinite(start)) throw new Error("invalid start time");
		// Daily local slots replace the UTC cron envelope, including across DST.
		for (
			let at = Math.floor(start / 60000) * 60000 + 60000;
			at <= start + 3 * 86400000;
			at += 60000
		) {
			if (runsAt.times.includes(formatter.format(new Date(at))))
				return new Date(at).toISOString();
		}
		throw new Error("local schedule has no fire within three days");
	}
	const parsed = parseCron(cron);
	const start = new Date(after);
	if (!Number.isFinite(start.getTime())) throw new Error("invalid start time");
	const hours = [...parsed.hour].sort((left, right) => left - right);
	const minutes = [...parsed.minute].sort((left, right) => left - right);
	const day = new Date(
		Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
	);
	for (let offset = 0; offset <= GREGORIAN_CALENDAR_CYCLE_DAYS; offset++) {
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
	throw new Error("cron has no fire time within the next 400 years");
}
