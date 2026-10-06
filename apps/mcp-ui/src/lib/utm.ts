/**
 * Append UTM parameters to a URL.
 *
 * Reads `_utmParams` from the tool output data (injected by the MCP handler
 * from app capabilities config). Safely handles URLs that already have query
 * strings or are malformed.
 *
 * NOTE: `appendUtmParams` is not a sanitizer and never was — it parses with
 * `new URL()`, which accepts `javascript:` happily, and its `catch` returns
 * the input untouched. Anything that becomes an `href` must go through
 * {@link safeTrackedHref} (or `safeLinkHref` directly) first.
 */

import { safeLinkHref } from "@tedix/widget-ui/safe-url";

export interface UtmParams {
	source?: string;
	medium?: string;
	campaign?: string;
}

export function appendUtmParams(
	href: string,
	utmParams: UtmParams | null | undefined,
): string {
	if (!utmParams) return href;

	try {
		const url = new URL(href);
		// Only https targets carry a query string meaningfully. `mailto:` and
		// `tel:` have opaque paths, and appending `?utm_source=…` to them
		// produces a mail client's idea of a subject-less mess or an unusable
		// dial string.
		if (url.protocol !== "https:") return href;
		if (utmParams.source) url.searchParams.set("utm_source", utmParams.source);
		if (utmParams.medium) url.searchParams.set("utm_medium", utmParams.medium);
		if (utmParams.campaign)
			url.searchParams.set("utm_campaign", utmParams.campaign);
		return url.toString();
	} catch {
		// Malformed URL — return as-is
		return href;
	}
}

/**
 * The single boundary every model-derived link target in this app goes
 * through: validate the scheme, then decorate with UTM.
 *
 * Order matters. Sanitizing first means UTM decoration only ever runs on a
 * URL that already passed the allowlist, and the value that reaches the DOM is
 * derived from the parsed URL rather than from the model's raw string.
 *
 * Returns `undefined` for anything the allowlist rejects, so a call site can
 * hand it straight to `href` and get an inert element instead of a link.
 */
export function safeTrackedHref(
	raw: unknown,
	utmParams: UtmParams | null | undefined,
): string | undefined {
	const href = safeLinkHref(raw);
	if (href === undefined) return undefined;
	return appendUtmParams(href, utmParams);
}
