/**
 * The one timestamp/duration dialect for every Tedix OS surface. Rows and
 * chips use `relativeTime`; detail headers use `absoluteTime`; durations use
 * `formatDurationMs`/`formatDurationBetween`. Never fall back to raw
 * `toLocaleString()`/`toLocaleDateString()` — numeric locale dates ("8/6/2026")
 * are banned from the UI.
 *
 * The operator's stored locale and time zone (`osLocale`/`osTimeZone`) select
 * the month NAMES and the wall clock; they do not select the format. Every
 * option bag below still pins `month: "short"`, so a stored locale translates
 * "Aug" and never degrades a date to digits — the ban above is on numeric
 * dates, not on localization.
 */

import { osLocale, osTimeZone } from "@/lib/format";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** D1 CURRENT_TIMESTAMP has no Z suffix; without it Date.parse reads local time. */
export function normalizeD1Timestamp(iso: string): string {
	return iso.endsWith("Z") || iso.includes("+") ? iso : `${iso}Z`;
}

/**
 * Compact relative timestamp with sensible cutoffs:
 * "just now" → "5m ago" → "3h ago" → "3d ago", then "Aug 6" (same year) and
 * "Aug 6, 2025" (cross-year). Empty string for unparseable input.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
	const then = Date.parse(iso);
	if (Number.isNaN(then)) return "";
	const delta = now.getTime() - then;
	if (delta < 45_000) return "just now";
	if (delta < HOUR_MS) {
		return `${Math.max(1, Math.round(delta / MINUTE_MS))}m ago`;
	}
	if (delta < DAY_MS) return `${Math.round(delta / HOUR_MS)}h ago`;
	if (delta < WEEK_MS) return `${Math.round(delta / DAY_MS)}d ago`;
	const date = new Date(then);
	const options: Intl.DateTimeFormatOptions = {
		month: "short",
		day: "numeric",
	};
	if (date.getFullYear() !== now.getFullYear()) options.year = "numeric";
	const timeZone = osTimeZone();
	if (timeZone) options.timeZone = timeZone;
	return date.toLocaleDateString(osLocale(), options);
}

/** Full instant for detail rows and `title` attributes: "Aug 2, 2026, 10:47 PM". */
export function absoluteTime(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const timeZone = osTimeZone();
	return date.toLocaleString(osLocale(), {
		month: "short",
		day: "numeric",
		year: "numeric",
		hour: "numeric",
		minute: "2-digit",
		...(timeZone ? { timeZone } : {}),
	});
}

/**
 * Calendar day for date-only values: "Aug 10, 2026".
 *
 * Formatted in UTC deliberately. A bare `YYYY-MM-DD` parses as UTC midnight,
 * so rendering it in a negative-offset local zone shows the PREVIOUS day — a
 * snapshot dated Aug 10 would read as Aug 9. A date-only value has no instant
 * to localize; it is the label the producer wrote.
 */
export function absoluteDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	// Stays UTC and locale-following for month names only: a date-only value has
	// no instant, so the operator's ZONE must not shift it a day either way.
	return date.toLocaleDateString(osLocale(), {
		month: "short",
		day: "numeric",
		year: "numeric",
		timeZone: "UTC",
	});
}

/**
 * One duration dialect: "420ms" → "3.2s" → "1m 04s" (exact minutes drop the
 * seconds: "2m") → "1h 3m". Null for absent/NaN input so callers can skip the
 * row entirely.
 */
export function formatDurationMs(ms: number | null | undefined): string | null {
	if (ms == null || Number.isNaN(ms)) return null;
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const tenths = Math.round(ms / 100) / 10;
	if (tenths < 60) return `${tenths}s`;
	let minutes = Math.floor(ms / MINUTE_MS);
	if (minutes < 60) {
		let rest = Math.round((ms % MINUTE_MS) / 1000);
		if (rest === 60) {
			minutes += 1;
			rest = 0;
		}
		return rest === 0
			? `${minutes}m`
			: `${minutes}m ${String(rest).padStart(2, "0")}s`;
	}
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
}

/** Duration between two instants; null unless both parse and the range is sane. */
export function formatDurationBetween(
	startedAt?: string | null,
	completedAt?: string | null,
): string | null {
	if (!startedAt || !completedAt) return null;
	const start = Date.parse(startedAt);
	const end = Date.parse(completedAt);
	if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
	return formatDurationMs(end - start);
}
