/**
 * Published branding, applied without host code.
 *
 * A provider configures the assistant's name, wording, colors and artwork in
 * its console. That configuration has to reach the browser before a signed
 * session exists, because the launcher is painted before anyone clicks it — so
 * the runtime reads it from a public, revalidated endpoint keyed by the tenant
 * slug the host already put in its script tag.
 *
 * Precedence never surprises a host: an explicit boot option or `data-tedix-*`
 * attribute always wins over published branding, which wins over the runtime's
 * own defaults.
 */

export interface WidgetBranding {
	[key: string]: unknown;
}

/** Console key → boot-option name, where the two names differ. */
const OPTION_NAME: Record<string, string> = {
	accentColor: "accent",
	accentColorDark: "accentDark",
};

/** Boot option → the `data-tedix-*` attribute a host would use instead. */
const DATASET_NAME: Record<string, string> = {
	accent: "tedixAccent",
	accentDark: "tedixAccentDark",
	title: "tedixTitle",
	product: "tedixProduct",
	subtitle: "tedixSubtitle",
	locale: "tedixLocale",
	assistantLogoUrl: "tedixAssistantLogoUrl",
	assistantLogoUrlDark: "tedixAssistantLogoUrlDark",
	launcherIconUrl: "tedixLauncherIconUrl",
	launcherIconUrlDark: "tedixLauncherIconUrlDark",
	launcherPosition: "tedixLauncherPosition",
	launcherMode: "tedixLauncherMode",
	startMode: "tedixStartMode",
	themeMode: "tedixThemeMode",
};

export function mergeWidgetBranding(
	options: Record<string, unknown>,
	dataset: Record<string, string | undefined>,
	branding: WidgetBranding | null | undefined,
): Record<string, unknown> {
	if (!branding || typeof branding !== "object") return options;
	const merged: Record<string, unknown> = { ...options };
	for (const [key, value] of Object.entries(branding)) {
		if (value === undefined || value === null) continue;
		const option = OPTION_NAME[key] ?? key;
		if (merged[option] !== undefined) continue;
		const attribute = DATASET_NAME[option];
		if (attribute && dataset[attribute]) continue;
		merged[option] = value;
	}
	return merged;
}

/**
 * Fetch published branding. Every failure resolves to `null`: an assistant that
 * renders in default colors is a cosmetic problem, an assistant that does not
 * render because a branding request timed out is an outage.
 */
export async function fetchWidgetBranding(options: {
	tenant: string;
	origin: string;
	fetch: typeof fetch;
	/** The visitor's language, so the reply carries the right copy. */
	locale?: string | undefined;
	timeoutMs?: number;
}): Promise<WidgetBranding | null> {
	if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(options.tenant || "")))
		return null;
	try {
		const url = new URL(`/widget/branding/${options.tenant}`, options.origin);
		if (options.locale) url.searchParams.set("locale", options.locale);
		// Branding is public: the request carries no host cookies, and the
		// Workers type for RequestInit omits the browser-only credentials field.
		//
		// It is also read on the critical path of the first paint, so it sets no
		// `cache` mode at all and lets the browser's default HTTP caching apply:
		// the previous `no-cache` forced a revalidation round trip before every
		// page could paint a launcher. The endpoint decides the freshness
		// window; a console change is a branding change, not an authorization
		// change.
		const request: RequestInit & { credentials: "omit" } = {
			method: "GET",
			credentials: "omit",
			redirect: "error",
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(options.timeoutMs ?? 2000),
		};
		const response = await options.fetch(url.href, request);
		if (!response.ok) return null;
		const payload = (await response.json()) as {
			branding?: WidgetBranding;
			catalog?: Record<string, string>;
			locale?: string;
			toolLabels?: Record<string, unknown>;
		} | null;
		const branding = payload?.branding;
		if (!branding || typeof branding !== "object" || Array.isArray(branding))
			return null;
		// Copy travels with configuration: the catalog is branding for words, and
		// the tool labels are branding for what the assistant says it did.
		return {
			...branding,
			...(typeof payload.locale === "string" ? { locale: payload.locale } : {}),
			...(payload.catalog && typeof payload.catalog === "object"
				? { catalog: payload.catalog }
				: {}),
			...(payload.toolLabels &&
			typeof payload.toolLabels === "object" &&
			!Array.isArray(payload.toolLabels)
				? { toolLabels: payload.toolLabels }
				: {}),
		};
	} catch {
		return null;
	}
}
