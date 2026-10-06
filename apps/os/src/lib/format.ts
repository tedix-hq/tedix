/** Shared text/number formatting for the Tedix OS surfaces. */

/**
 * The operator's stored locale/timezone, or the platform fallback.
 *
 * Held module-level rather than threaded through every call site: these
 * helpers are called from ~40 render paths, and a preference that only some of
 * them honored would be worse than none. `applyOsPreferences` sets this once
 * when the durable preferences load; until then, and whenever the operator has
 * stored nothing, the values below are the fallback.
 *
 * `locale` is `null` when unset — deliberately NOT the browser's locale by
 * default, because the OS's date dialect is month-name based on purpose (see
 * ./time) and the platform default stays `en-US` until an operator opts in.
 */
let resolvedLocale = "en-US";
let resolvedTimeZone: string | undefined;

export function setOsFormattingPreferences(preferences: {
	locale: string | null;
	timezone: string | null;
}): void {
	resolvedLocale = preferences.locale ?? "en-US";
	resolvedTimeZone = preferences.timezone ?? undefined;
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
