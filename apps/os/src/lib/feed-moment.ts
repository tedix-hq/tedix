import { OS_COPY } from "@/shared/os-copy";

export function feedMoment(at: string, now: Date, timeZone?: string | null) {
	const format = new Intl.DateTimeFormat("en-CA", {
		timeZone: timeZone ?? undefined,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	});
	const date = new Date(at);
	const copy = OS_COPY.feedDeckVisual;
	if (format.format(date) !== format.format(now)) return copy.earlier;
	const hour = Number(
		new Intl.DateTimeFormat("en", {
			timeZone: timeZone ?? undefined,
			hour: "numeric",
			hourCycle: "h23",
		}).format(date),
	);
	return hour < 12
		? copy.thisMorning
		: hour < 18
			? copy.thisAfternoon
			: copy.thisEvening;
}
