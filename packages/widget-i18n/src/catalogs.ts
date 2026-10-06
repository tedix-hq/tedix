import de from "./de.json";
import en from "./en.json";
import es from "./es.json";
import type { WidgetCatalog } from "./catalog";

/**
 * Every language the widget ships, by subtag. English is the source; adding a
 * file here ships that language to every host without a widget deploy, because
 * catalogs travel with the tenant's published configuration.
 */
export const WIDGET_CATALOGS: Record<string, WidgetCatalog> = { de, en, es };

export const WIDGET_SOURCE_LOCALE = "en";

/** Resolve a requested locale to a shipped catalog, falling back to the source. */
export function resolveWidgetCatalog(locale: string | undefined): {
	locale: string;
	catalog: WidgetCatalog;
} {
	const language = String(locale || "")
		.trim()
		.toLowerCase()
		.split(/[-_]/, 1)[0];
	return language && WIDGET_CATALOGS[language]
		? { locale: language, catalog: WIDGET_CATALOGS[language] }
		: { locale: WIDGET_SOURCE_LOCALE, catalog: en };
}
