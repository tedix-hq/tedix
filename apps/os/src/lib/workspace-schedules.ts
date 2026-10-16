import type { OsWorkspaceSchedule } from "@tedix/api-contract/schemas/os-workspace-schedules";
import { osLocale, osTimeZone } from "@/lib/format";
import { normalizeD1Timestamp } from "@/lib/time";

/**
 * Plain-language lines for a scheduled skill in a workspace's Resources:
 * when it runs, how its last run went and when it runs next, all in the
 * viewer's own clock.
 */

const DAY_MS = 86_400_000;

type ClockOptions = { locale?: string; timeZone?: string };

function clockParts(options: ClockOptions) {
	const timeZone = options.timeZone ?? osTimeZone();
	return {
		locale: options.locale ?? osLocale(),
		zone: timeZone ? { timeZone } : {},
	};
}

/** "8:17" or "8:17 AM", following the viewer's locale and time zone. */
export function clockTime(iso: string, options: ClockOptions = {}): string {
	const { locale, zone } = clockParts(options);
	return new Date(normalizeD1Timestamp(iso)).toLocaleTimeString(locale, {
		hour: "numeric",
		minute: "2-digit",
		...zone,
	});
}

/** Minutes past local midnight, to order daily times by the viewer's clock. */
function minuteOfDay(iso: string, options: ClockOptions): number {
	const { locale, zone } = clockParts(options);
	const parts = new Intl.DateTimeFormat(locale, {
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		...zone,
	}).formatToParts(new Date(iso));
	const value = (type: string) =>
		Number(parts.find((part) => part.type === type)?.value ?? 0);
	return value("hour") * 60 + value("minute");
}

function joinWithAnd(items: readonly string[]): string {
	if (items.length <= 1) return items[0] ?? "";
	return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "Every day at 8:17, 13:17 and 18:17", "Paused" or "On a custom schedule". */
export function scheduleWhen(
	schedule: Pick<OsWorkspaceSchedule, "enabled" | "dailyTimes" | "nextRunAt">,
	options: ClockOptions = {},
): string {
	if (!schedule.enabled) return "Paused";
	if (schedule.dailyTimes.length > 0) {
		const times = [...schedule.dailyTimes]
			.sort((a, b) => minuteOfDay(a, options) - minuteOfDay(b, options))
			.map((iso) => clockTime(iso, options));
		return `Every day at ${joinWithAnd([...new Set(times)])}`;
	}
	if (schedule.nextRunAt) return "On a custom schedule";
	return "No run time is coming up";
}

/** "13:17" today, "Yesterday 18:17", or "Oct 14, 18:17" for older runs. */
export function dayAndTime(
	iso: string,
	now: Date = new Date(),
	options: ClockOptions = {},
): string {
	const { locale, zone } = clockParts(options);
	const at = new Date(normalizeD1Timestamp(iso));
	const day = (date: Date) =>
		date.toLocaleDateString("en-CA", { ...zone, dateStyle: "short" });
	const time = clockTime(at.toISOString(), options);
	if (day(at) === day(now)) return time;
	const tomorrow = new Date(now.getTime() + DAY_MS);
	if (day(at) === day(tomorrow)) return `tomorrow ${time}`;
	const yesterday = new Date(now.getTime() - DAY_MS);
	if (day(at) === day(yesterday)) return `yesterday ${time}`;
	const date = at.toLocaleDateString(locale, {
		month: "short",
		day: "numeric",
		...zone,
	});
	return `${date}, ${time}`;
}

/** What the last run did, in a few words. */
function lastRunResult(
	run: NonNullable<OsWorkspaceSchedule["lastRun"]>,
): string {
	if (run.cards !== null) {
		if (run.cards === 0) return "no new cards";
		return run.cards === 1 ? "made 1 card" : `made ${run.cards} cards`;
	}
	return run.summary ?? "finished";
}

/** "Last run 13:17: made 4 cards" or "Last run failed: Gmail search failed". */
export function lastRunLine(
	lastRun: OsWorkspaceSchedule["lastRun"],
	now: Date = new Date(),
	options: ClockOptions = {},
): string {
	if (!lastRun) return "Has not run yet";
	if (lastRun.status === "failed")
		return `Last run failed: ${lastRun.error ?? "no reason was recorded"}`;
	const at = lastRun.startedAt ?? lastRun.completedAt;
	const when = at ? ` ${dayAndTime(at, now, options)}` : "";
	return `Last run${when}: ${lastRunResult(lastRun)}`;
}

/** "Next run 18:17" or "Next run tomorrow 8:17"; null when none is coming up. */
export function nextRunLine(
	nextRunAt: string | null,
	now: Date = new Date(),
	options: ClockOptions = {},
): string | null {
	if (!nextRunAt) return null;
	return `Next run ${dayAndTime(nextRunAt, now, options)}`;
}
