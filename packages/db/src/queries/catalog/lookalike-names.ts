/**
 * A catalog name with a word that mixes Latin letters with Cyrillic or Greek
 * ones ("Mаke" with a Cyrillic "а") looks like a known vendor while being a
 * different string. Real names keep each word in one script — "Rozetka:
 * інтернет гіпермаркет" mixes scripts across words, not within one — so only a
 * mixed-script word marks a lookalike, imported hidden until reviewed.
 */
const LATIN = /\p{Script=Latin}/u;
const LOOKALIKE_SCRIPTS = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;

export function isLookalikeCatalogName(
	name: string | null | undefined,
): boolean {
	if (!name) return false;
	return name
		.split(/[^\p{L}]+/u)
		.some((word) => LATIN.test(word) && LOOKALIKE_SCRIPTS.test(word));
}
