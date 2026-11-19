import { ORPCError } from "@orpc/server";

/** Half of a two-part character such as an emoji: an unpaired UTF-16 surrogate. */
const HALF_CHARACTER =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Where in `value` a string holds half of a character, or null when every
 * string is whole. Such text does not survive being saved as UTF-8: the half
 * would turn into a replacement mark without anyone asking for it.
 */
function halfCharacterPath(value: unknown, path = ""): string | null {
	if (typeof value === "string")
		return HALF_CHARACTER.test(value) ? path || "the text" : null;
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) {
			const found = halfCharacterPath(entry, `${path}[${index}]`);
			if (found) return found;
		}
		return null;
	}
	if (value === null || typeof value !== "object") return null;
	for (const [key, entry] of Object.entries(value)) {
		if (HALF_CHARACTER.test(key)) return `a field name under ${path || "it"}`;
		const found = halfCharacterPath(entry, path ? `${path}.${key}` : key);
		if (found) return found;
	}
	return null;
}

/** Refuse before normalizing or writing any part of a person's edit. */
export function requireSavableText(value: unknown): void {
	const path = halfCharacterPath(value);
	if (path)
		throw new ORPCError("BAD_REQUEST", {
			message: `Nothing was changed: ${path} holds half of a character, usually an emoji cut in two (an unpaired UTF-16 surrogate), which cannot be saved. Send whole characters and make the call again.`,
		});
}
