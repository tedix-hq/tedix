/** Shared text/number formatting for the Tedix OS surfaces. */
import { useSyncExternalStore } from "react";
import { setOsLocale } from "@/shared/os-locale";

/**
 * The operator's stored locale/timezone, or the platform fallback.
 *
 * Pure formatters read the shared snapshot; React render paths subscribe with
 * `useOsFormattingPreferences` so preferences arriving after first paint also
 * update mounted timestamps, including memoized rows.
 *
 * `locale` is `null` when unset — deliberately NOT the browser's locale by
 * default, because the OS's date dialect is month-name based on purpose (see
 * ./time) and the platform default stays `en-US` until an operator opts in.
 */
let resolvedLocale = "en-US";
let preferredLocale: string | undefined;
let resolvedTimeZone: string | undefined;
let formattingPreferences: Readonly<{
	locale: string | null;
	timezone: string | null;
}> = { locale: null, timezone: null };
const formattingListeners = new Set<() => void>();

function readFormattingPreferences() {
	return formattingPreferences;
}

function subscribeFormattingPreferences(listener: () => void) {
	formattingListeners.add(listener);
	return () => {
		formattingListeners.delete(listener);
	};
}

/** Subscribe in the component that renders a preference-dependent value. */
export function useOsFormattingPreferences() {
	return useSyncExternalStore(
		subscribeFormattingPreferences,
		readFormattingPreferences,
		readFormattingPreferences,
	);
}

export function setOsFormattingPreferences(preferences: {
	locale: string | null;
	timezone: string | null;
}): void {
	if (
		formattingPreferences.locale === preferences.locale &&
		formattingPreferences.timezone === preferences.timezone
	)
		return;
	formattingPreferences = { ...preferences };
	resolvedLocale = preferences.locale ?? "en-US";
	preferredLocale = preferences.locale ?? undefined;
	resolvedTimeZone = preferences.timezone ?? undefined;
	setOsLocale(resolvedLocale);
	formattingListeners.forEach((listener) => listener());
}

export function osSpreadsheetLocale(): string | undefined {
	return preferredLocale;
}

/** The locale every OS formatter uses. */
export function osLocale(): string {
	return resolvedLocale;
}

/** The time zone every OS instant formatter uses; undefined follows the browser. */
export function osTimeZone(): string | undefined {
	return resolvedTimeZone;
}

/** Thousands-separated count for eyebrows and totals: 13490 → "13,490". */
export function formatCount(count: number): string {
	return count.toLocaleString(resolvedLocale);
}

/**
 * Format a canonical 0..1 ratio as a percentage without exposing its storage
 * representation: 0.532258... → "53.2%".
 */
export function formatRatioPercent(ratio: number): string {
	return new Intl.NumberFormat(resolvedLocale, {
		style: "percent",
		maximumFractionDigits: 1,
	}).format(ratio);
}

/** "requires_approval" → "requires approval" (inline metadata casing). */
export function humanize(value: string): string {
	return value.replaceAll("_", " ");
}

/**
 * Sentence-case for status chips — the one chip casing across surfaces:
 * "requires_approval" → "Requires approval".
 */
export function sentenceCase(value: string): string {
	const spaced = humanize(value);
	return spaced.length === 0
		? spaced
		: spaced[0]!.toUpperCase() + spaced.slice(1);
}
