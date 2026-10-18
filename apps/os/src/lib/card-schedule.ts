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

function calendarDay(date: Date, timeZone?: string) {
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
