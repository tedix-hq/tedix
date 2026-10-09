/**
 * Catalog names that mix Latin letters with Cyrillic or Greek letters look
 * like a known vendor while being a different string ("Mаke" with a Cyrillic
 * "а"). Real products name themselves in one script, so a mixed-script name
 * is imported hidden from browsing until someone reviews it.
 */
const LATIN = /\p{Script=Latin}/u;
const LOOKALIKE_SCRIPTS = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;

export function isLookalikeCatalogName(
	name: string | null | undefined,
): boolean {
	if (!name) return false;
	return LATIN.test(name) && LOOKALIKE_SCRIPTS.test(name);
}
