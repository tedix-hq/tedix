/*
 * A skill's schedule is stored as a five-field expression in UTC. People read
 * and set it in their own time zone, so this module turns the stored
 * expression into a sentence in local time and a local time back into the
 * stored expression. Shapes it does not fully understand are never
 * paraphrased: the caller shows the next run instead.
 */

const DAY_MINUTES = 1440;

const DAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

const DAY_ALIASES: Record<string, number> = {
	sun: 0,
	mon: 1,
	tue: 2,
	wed: 3,
	thu: 4,
	fri: 5,
	sat: 6,
};

/** Minutes a time zone is ahead of UTC at one instant. */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
		}).formatToParts(instant);
		const part = (type: string) =>
			Number(parts.find((item) => item.type === type)?.value ?? Number.NaN);
		const local = Date.UTC(
			part("year"),
			part("month") - 1,
			part("day"),
			part("hour"),
			part("minute"),
		);
		const offset = Math.round(
			(local - Math.floor(instant.getTime() / 60_000) * 60_000) / 60_000,
		);
		return Number.isFinite(offset) ? offset : 0;
	} catch {
		return 0;
	}
}

function parseDay(token: string): number | null {
	if (/^\d+$/.test(token)) {
		const value = Number(token);
		// Both 0 and 7 mean Sunday.
		return value <= 7 ? value % 7 : null;
	}
	return DAY_ALIASES[token.slice(0, 3).toLowerCase()] ?? null;
}

/** The weekdays a day-of-week field names; null for shapes not understood. */
function parseDays(field: string): number[] | null {
	const days = new Set<number>();
	for (const token of field.split(",")) {
		const range = /^([^-]+)-([^-]+)$/.exec(token);
		if (range) {
			const from = parseDay(range[1]!);
			const to = parseDay(range[2]!);
			if (from === null || to === null || from > to) return null;
			for (let day = from; day <= to; day += 1) days.add(day);
			continue;
		}
		const day = parseDay(token);
		if (day === null) return null;
		days.add(day);
	}
	return days.size > 0 ? [...days].sort((a, b) => a - b) : null;
}

const shiftDays = (days: readonly number[], by: number) =>
	days.map((day) => (((day + by) % 7) + 7) % 7).sort((a, b) => a - b);

type TimedCron = {
	minute: number;
	hour: number;
	dayOfMonth: string;
	dayOfWeek: string;
};

/** A schedule pinned to one time of day, every month. */
function timedCron(cron: string): TimedCron | null {
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5) return null;
	const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
		string,
		string,
		string,
		string,
		string,
	];
	if (month !== "*" || !/^\d+$/.test(minute) || !/^\d+$/.test(hour))
		return null;
	const m = Number(minute);
	const h = Number(hour);
	return m <= 59 && h <= 23
		? { minute: m, hour: h, dayOfMonth, dayOfWeek }
		: null;
}

/** A UTC time of day moved into a zone: the local minutes and the day moved. */
function toLocal(utcMinutes: number, offset: number) {
	const total = utcMinutes + offset;
	const dayShift = Math.floor(total / DAY_MINUTES);
	return { minutes: total - dayShift * DAY_MINUTES, dayShift };
}

function clockLabel(minutes: number, locale: string): string {
	return new Intl.DateTimeFormat(locale, {
		hour: "numeric",
		minute: "2-digit",
		timeZone: "UTC",
	}).format(new Date(Date.UTC(2000, 0, 1, 0, minutes)));
}

function ordinal(day: number): string {
	const tail = day % 100;
	if (tail >= 11 && tail <= 13) return `${day}th`;
	return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

function daysPhrase(days: readonly number[]): string {
	if (days.length === 7) return "Every day";
	if (days.join() === "1,2,3,4,5") return "Every weekday";
	if (days.join() === "0,6") return "Every Saturday and Sunday";
	// Read Monday first; Sunday closes the week.
	const names = [...days]
		.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
		.map((day) => DAY_NAMES[day]!);
	if (names.length === 1) return `Every ${names[0]}`;
	return `Every ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export type ScheduleWords = {
	/** "Every day at 10:00 AM"; null when the shape is not understood. */
	text: string | null;
	/**
	 * "local": the time is in the given zone. "utc": the sentence names UTC
	 * itself. "none": the cadence has no time of day to place.
	 */
	zone: "local" | "utc" | "none";
};

/** The stored schedule as a sentence, with its time in the given zone. */
export function scheduleInWords(
	cron: string,
	timeZone: string,
	options: { reference?: Date; locale?: string } = {},
): ScheduleWords {
	const locale = options.locale ?? "en-US";
	const offset = zoneOffsetMinutes(options.reference ?? new Date(), timeZone);
	const fields = cron.trim().split(/\s+/);
	if (fields.length !== 5 || fields[3] !== "*")
		return { text: null, zone: "none" };
	const [minute, hour, dayOfMonth, , dayOfWeek] = fields as [
		string,
		string,
		string,
		string,
		string,
	];
	const everyDay = dayOfMonth === "*" && dayOfWeek === "*";
	if (everyDay && hour === "*") {
		if (minute === "*") return { text: "Every minute", zone: "none" };
		const step = /^\*\/(\d+)$/.exec(minute)?.[1];
		if (step) return { text: `Every ${Number(step)} minutes`, zone: "none" };
		if (/^\d+$/.test(minute) && Number(minute) <= 59) {
			const past = (((Number(minute) + offset) % 60) + 60) % 60;
			return {
				text:
					past === 0
						? "Every hour, on the hour"
						: `Every hour, ${past} ${past === 1 ? "minute" : "minutes"} past the hour`,
				zone: "none",
			};
		}
		return { text: null, zone: "none" };
	}
	const hourStep = /^\*\/(\d+)$/.exec(hour)?.[1];
	if (everyDay && minute === "0" && hourStep)
		return { text: `Every ${Number(hourStep)} hours`, zone: "none" };

	const timed = timedCron(cron);
	if (!timed) return { text: null, zone: "none" };
	const local = toLocal(timed.hour * 60 + timed.minute, offset);
	const at = clockLabel(local.minutes, locale);
	if (everyDay) return { text: `Every day at ${at}`, zone: "local" };
	if (dayOfMonth === "*") {
		const days = parseDays(dayOfWeek);
		if (!days) return { text: null, zone: "none" };
		return {
			text: `${daysPhrase(shiftDays(days, local.dayShift))} at ${at}`,
			zone: "local",
		};
	}
	if (dayOfWeek === "*" && /^\d+$/.test(dayOfMonth)) {
		const day = Number(dayOfMonth);
		if (day < 1 || day > 31) return { text: null, zone: "none" };
		// A day of the month cannot be moved across midnight without changing
		// which day it is at the month's ends, so it stays in UTC.
		return local.dayShift === 0
			? { text: `Every month on the ${ordinal(day)} at ${at}`, zone: "local" }
			: {
					text: `Every month on the ${ordinal(day)} at ${clockLabel(
						timed.hour * 60 + timed.minute,
						locale,
					)} UTC`,
					zone: "utc",
				};
	}
	return { text: null, zone: "none" };
}

const pad = (value: number) => String(value).padStart(2, "0");

/**
 * The local "HH:MM" a schedule runs at, when its time can be changed as a
 * local time: one time of day, on every day or on named weekdays.
 */
export function scheduleLocalTime(
	cron: string,
	timeZone: string,
	reference: Date = new Date(),
): string | null {
	const timed = timedCron(cron);
	if (!timed || timed.dayOfMonth !== "*") return null;
	if (timed.dayOfWeek !== "*" && !parseDays(timed.dayOfWeek)) return null;
	const local = toLocal(
		timed.hour * 60 + timed.minute,
		zoneOffsetMinutes(reference, timeZone),
	);
	return `${pad(Math.floor(local.minutes / 60))}:${pad(local.minutes % 60)}`;
}

/**
 * The stored expression for the same days at a new local time. Weekdays keep
 * meaning the local weekdays: a local time that falls on the neighbouring UTC
 * day moves the stored days with it.
 */
export function cronAtLocalTime(
	cron: string,
	localTime: string,
	timeZone: string,
	reference: Date = new Date(),
): string | null {
	const timed = timedCron(cron);
	const match = /^(\d{1,2}):(\d{2})$/.exec(localTime.trim());
	if (!timed || !match || scheduleLocalTime(cron, timeZone, reference) === null)
		return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 23 || minute > 59) return null;
	const offset = zoneOffsetMinutes(reference, timeZone);
	const total = hour * 60 + minute - offset;
	const utcShift = Math.floor(total / DAY_MINUTES);
	const utcMinutes = total - utcShift * DAY_MINUTES;
	let dayOfWeek = timed.dayOfWeek;
	if (dayOfWeek !== "*") {
		const stored = parseDays(dayOfWeek)!;
		const localDays = shiftDays(
			stored,
			toLocal(timed.hour * 60 + timed.minute, offset).dayShift,
		);
		const next = shiftDays(localDays, utcShift);
		// An unchanged set keeps the way it was written, such as "1-5".
		if (next.join() !== stored.join()) dayOfWeek = next.join(",");
	}
	return `${utcMinutes % 60} ${Math.floor(utcMinutes / 60)} * * ${dayOfWeek}`;
}
