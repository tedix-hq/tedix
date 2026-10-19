/** Persona is a fallback only; file headings are never a useful roster role. */
export function tediDescription(personality: string | null): string | null {
	const line = personality
		?.split("\n")
		.map((value) => value.trim())
		.find(
			(value) =>
				value &&
				!/^#|^```/.test(value) &&
				!/\b[\w.-]+\.(?:md|txt|json|ya?ml)\b/i.test(value),
		);
	if (!line) return null;
	const text = line
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/[*_`]/g, "")
		.replace(/^[-•>]\s*/, "")
		.replace(/^you are\s+[^,.]+,\s*(?:an?\s+)?/i, "")
		.replace(/^you are\s+(?:an?\s+)?/i, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!text) return null;
	const sentence = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
	const clean = sentence[0]!.toLocaleUpperCase() + sentence.slice(1);
	return clean.length > 80 ? `${clean.slice(0, 79).trimEnd()}…` : clean;
}
