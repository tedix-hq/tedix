const SCHEDULE_FIELDS = new Set([
	"due",
	"dueat",
	"duedate",
	"scheduled",
	"scheduledat",
	"scheduledfor",
	"scheduleddate",
	"remindat",
	"reminderat",
	"reminderdate",
]);

export function isCardScheduleField(name: string) {
	return SCHEDULE_FIELDS.has(name.replace(/[\s_-]/g, "").toLowerCase());
}

export function calendarDay(date: Date, timeZone?: string) {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(date);
	return ["year", "month", "day"]
		.map((type) => parts.find((p) => p.type === type)!.value)
		.join("-");
}

export function cardScheduleDates(card: object): string[] {
	const fields = (value: object) =>
		Object.entries(value)
			.filter(([key]) => isCardScheduleField(key))
			.map(([, value]) => value);
	const metadata =
		"metadata" in card && card.metadata && typeof card.metadata === "object"
			? card.metadata
			: {};
	const dates =
		"scheduleDates" in card && Array.isArray(card.scheduleDates)
			? card.scheduleDates
			: [];
	return [...fields(card), ...fields(metadata), ...dates]
		.filter(
			(value): value is string =>
				typeof value === "string" &&
				!!value.trim() &&
				Number.isFinite(Date.parse(value)),
		)
		.map((value) => value.trim());
}

/** Date-only values are local calendar dates; timestamps use the viewer's timezone. */
export function cardIsDue(card: object, now: Date, timeZone?: string): boolean {
	const today = calendarDay(now, timeZone);
	return cardScheduleDates(card).every((text) => {
		const day = /^\d{4}-\d{2}-\d{2}$/.test(text)
			? text
			: calendarDay(new Date(text), timeZone);
		return day <= today;
	});
}

/** Preserve structured deadlines, or an explicit dated "by" clause from a factory source.
 * A source with no timezone establishes a calendar date, never a guessed instant.
 */
export function factoryCardDeadline(card: {
	scheduleDates?: string[];
	action: string | null;
	why: string;
	runCreatedAt: string;
}): string | null {
	const structured = cardScheduleDates(card);
	if (structured.length) return structured.sort()[0]!;
	const sourceDate = new Date(card.runCreatedAt);
	if (!Number.isFinite(sourceDate.getTime())) return null;
	const months = Array.from({ length: 12 }, (_, month) =>
		new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" })
			.format(new Date(Date.UTC(2000, month, 1)))
			.toLowerCase(),
	);
	const pattern = new RegExp(
		`\\bby\\s+(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\\s+)?(\\d{1,2})\\s+(${months.join("|")})(?:\\s+(\\d{4}))?\\b`,
		"gi",
	);
	const dates = new Set<string>();
	for (const match of `${card.action ?? ""}\n${card.why}`.matchAll(pattern)) {
		const month = months.indexOf(match[2]!.toLowerCase());
		// Without an explicit year, only accept the source's own calendar month.
		if (!match[3] && month !== sourceDate.getUTCMonth()) continue;
		const year = Number(match[3] ?? sourceDate.getUTCFullYear());
		const date = new Date(Date.UTC(year, month, Number(match[1])));
		if (date.getUTCMonth() === month && date.getUTCFullYear() === year)
			dates.add(date.toISOString().slice(0, 10));
	}
	return dates.size === 1 ? [...dates][0]! : null;
}
