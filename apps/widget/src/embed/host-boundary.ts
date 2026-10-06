const BLOCKED_HOST_PATH =
	/^\/(?:api|auth|cli|mcp|widgets|sandbox_proxy)(?:\/|$)/;

export interface EmbeddedPageContext {
	pathname: string;
	routeKey?: string;
	params?: Record<string, boolean | number | string>;
	revision?: string;
	title?: string;
	description?: string;
	sections?: string[];
	entity?: { type: string; id: string; label?: string };
	event?: {
		name: string;
		metadata?: Record<string, boolean | number | string>;
	};
}

/** Escape host- or model-authored text before it enters Shadow DOM markup. */
export function escapeEmbeddedHtml(value: unknown): string {
	return String(value).replace(
		/[&<>"]/g,
		(character) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!,
	);
}

/** Branding accents stay CSS colors, never arbitrary CSS input. */
export function safeEmbeddedAccent(value: unknown): string {
	return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(String(value))
		? String(value)
		: "#2557d6";
}

/** Brand images must resolve to an absolute HTTPS URL. */
export function safeEmbeddedImageUrl(
	value: unknown,
	origin: string,
): string | null {
	if (!value) return null;
	try {
		const url = new URL(String(value), origin);
		return url.protocol === "https:" && url.origin !== "null" ? url.href : null;
	} catch {
		return null;
	}
}

export function isSafeEmbeddedHostPath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.startsWith("/") &&
		!value.startsWith("//") &&
		!BLOCKED_HOST_PATH.test(value)
	);
}

/**
 * Bound untrusted host context before it crosses the signed embedded-session
 * seam. This data helps the model answer; it never grants tenant authority.
 */
export function normalizeEmbeddedPageContext(
	value: Record<string, unknown> = {},
	fallbackPathname = "/",
): EmbeddedPageContext {
	const pathname = isSafeEmbeddedHostPath(value.pathname)
		? value.pathname.slice(0, 500)
		: isSafeEmbeddedHostPath(fallbackPathname)
			? fallbackPathname.slice(0, 500)
			: "/";
	const result: EmbeddedPageContext = { pathname };
	for (const [key, limit] of [
		["title", 200],
		["description", 500],
	] as const) {
		const raw = value[key];
		if (typeof raw === "string" && raw.trim())
			result[key] = raw.trim().slice(0, limit);
	}
	if (/^[A-Za-z0-9_.:-]{1,120}$/.test(String(value.routeKey || "")))
		result.routeKey = String(value.routeKey);
	if (typeof value.revision === "string" && value.revision.trim())
		result.revision = value.revision.trim().slice(0, 160);
	if (
		value.params &&
		typeof value.params === "object" &&
		!Array.isArray(value.params)
	) {
		const params: Record<string, boolean | number | string> = {};
		for (const [key, raw] of Object.entries(value.params).slice(0, 24)) {
			if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) continue;
			if (typeof raw === "boolean" || typeof raw === "number")
				params[key] = raw;
			else if (typeof raw === "string") params[key] = raw.slice(0, 200);
		}
		if (Object.keys(params).length) result.params = params;
	}
	if (Array.isArray(value.sections)) {
		result.sections = value.sections
			.filter(
				(item): item is string => typeof item === "string" && !!item.trim(),
			)
			.slice(0, 12)
			.map((item) => item.trim().slice(0, 160));
	}
	const entity = value.entity;
	if (
		entity &&
		typeof entity === "object" &&
		!Array.isArray(entity) &&
		typeof (entity as Record<string, unknown>).type === "string" &&
		typeof (entity as Record<string, unknown>).id === "string" &&
		/^[A-Za-z0-9_.:-]+$/.test((entity as { type: string }).type) &&
		/^[A-Za-z0-9_.:-]+$/.test((entity as { id: string }).id)
	) {
		const record = entity as { type: string; id: string; label?: unknown };
		result.entity = {
			type: record.type.slice(0, 64),
			id: record.id.slice(0, 128),
			...(typeof record.label === "string"
				? { label: record.label.slice(0, 160) }
				: {}),
		};
	}
	const event = value.event;
	if (event && typeof event === "object" && !Array.isArray(event)) {
		const record = event as { name?: unknown; metadata?: unknown };
		if (/^[A-Za-z0-9_.:-]{1,80}$/.test(String(record.name || ""))) {
			const metadata: Record<string, boolean | number | string> = {};
			if (
				record.metadata &&
				typeof record.metadata === "object" &&
				!Array.isArray(record.metadata)
			) {
				for (const [key, raw] of Object.entries(record.metadata).slice(0, 12)) {
					if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) continue;
					if (typeof raw === "boolean" || typeof raw === "number")
						metadata[key] = raw;
					else if (typeof raw === "string") metadata[key] = raw.slice(0, 160);
				}
			}
			result.event = {
				name: String(record.name),
				...(Object.keys(metadata).length ? { metadata } : {}),
			};
		}
	}
	return result;
}

export function safeEmbeddedHostRoute(
	value: unknown,
	origin: string,
): string | null {
	if (typeof value !== "string") return null;
	const candidate = value.trim();
	if (!candidate.startsWith("/") || candidate.startsWith("//")) return null;
	try {
		const url = new URL(candidate, origin);
		if (url.origin !== origin || !isSafeEmbeddedHostPath(url.pathname))
			return null;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return null;
	}
}

/** Fallback when the host supplies no usable locale. */
export const DEFAULT_EMBEDDED_LOCALE = "en-US";

/**
 * Bound a host-supplied locale before it reaches `Intl` or string methods.
 *
 * `options.locale` comes from the embedding customer's config, and the mount
 * path's `locale || dataset || lang || navigator.language || "en-US"` chain
 * only rejects FALSY input. Two truthy shapes still reach `Intl` and throw:
 *
 * - a non-string (`locale: 123`) throws `TypeError` at `.toLowerCase()`, which
 *   is on the mount path — the whole widget fails to render;
 * - a structurally invalid tag throws `RangeError` inside `Intl.DateTimeFormat`.
 *   `en_US` with an underscore is the common one, and `""`/`"x"` behave the
 *   same way.
 *
 * `Intl.getCanonicalLocales` rejects exactly the tags `Intl.DateTimeFormat`
 * rejects, so it is the honest validator here. The accepted tag is returned as
 * written rather than canonicalized, so nothing the host chose is silently
 * restyled.
 */
export function normalizeEmbeddedLocale(
	value: unknown,
	fallback: string = DEFAULT_EMBEDDED_LOCALE,
): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	if (!trimmed) return fallback;
	try {
		Intl.getCanonicalLocales(trimmed);
	} catch {
		return fallback;
	}
	return trimmed;
}

/**
 * Pick a host-supplied translation bundle for a locale: exact tag first, then
 * the base language, then nothing.
 *
 * The bundle is host data, so a non-object entry yields `{}` rather than being
 * handed back for property access.
 */
export function resolveEmbeddedTranslation(
	translations: unknown,
	locale: string,
): Record<string, unknown> {
	if (!translations || typeof translations !== "object") return {};
	const target = normalizeEmbeddedLocale(locale).toLowerCase();
	const base = target.split("-")[0];
	const entries = Object.entries(translations as Record<string, unknown>);
	const match =
		entries.find(([key]) => key.toLowerCase() === target) ??
		entries.find(([key]) => key.toLowerCase().split("-")[0] === base);
	const value = match?.[1];
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}
