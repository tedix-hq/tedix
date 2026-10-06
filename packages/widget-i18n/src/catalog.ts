/**
 * Widget copy resolves from a catalog, never from a language branch.
 *
 * Every user-visible string used to be chosen by `english-or-spanish`, which
 * had no third slot: a German reseller got English by construction. Copy is now
 * data — English is the source catalog, other locales are siblings delivered
 * with the tenant's published configuration, and a tenant may override any key
 * from its console.
 *
 * The runtime is deliberately small: a lookup, a fallback, and `{{token}}`
 * interpolation. Everything else (filling a new locale, checking parity) is a
 * build-time concern and lives in `scripts/i18n/`.
 */

export type WidgetCatalog = Record<string, string>;

export type CatalogParams = Record<string, string | number>;

/** Replace `{{name}}` with a supplied value; an unknown token is left alone. */
export function interpolate(template: string, params: CatalogParams): string {
	return template.replace(/\{\{(\w+)\}\}/g, (token, name: string) =>
		Object.hasOwn(params, name) ? String(params[name]) : token,
	);
}

export type Translate = (key: string, params?: CatalogParams) => string;

/**
 * Build the lookup. A key missing from the visitor's locale falls back to the
 * source catalog, and a key missing from both renders as the key itself —
 * visible in a screenshot, never a blank control.
 *
 * `defaults` are tokens every string may use — the assistant's configured name
 * above all. They exist because interpolation used to depend on each call site
 * remembering to pass the name: `t("ask", { assistant })` did, and the error
 * copy did not, so a capacity failure rendered the literal text
 * "{{assistant}} no tiene capacidad disponible" to a shop owner. A default
 * cannot be forgotten. An explicit param still wins over a default.
 */
export function buildTranslate(
	primary: WidgetCatalog | null | undefined,
	fallback?: WidgetCatalog | null,
	defaults?: CatalogParams | null,
): Translate {
	const hasDefaults = Boolean(defaults && Object.keys(defaults).length > 0);
	return (key, params) => {
		const template =
			primary?.[key] !== undefined ? primary[key] : fallback?.[key];
		if (template === undefined) return key;
		if (!params && !hasDefaults) return template;
		return interpolate(template, { ...defaults, ...params });
	};
}
