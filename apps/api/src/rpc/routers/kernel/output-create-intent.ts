/**
 * Recognizes a request that opens by asking for a new Tedix output
 * ("Create a 3-slide deck about X", "make a sheet of our vendors").
 *
 * Routing is the model's decision. The write planner uses this only after the
 * model chose `os.create_os_output`, to draft a document body.
 */

export type OutputCreateKind = "document" | "sheet" | "presentation";

/** An optional polite or "can you" lead-in before the verb. */
const LEAD_IN_RE =
	/^(?:(?:hey|hi|ok|okay)\b[\s,]*)?(?:please\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:want|need|would\s+like)\s+(?:you\s+)?(?:to\s+)?|let'?s\s+)?/i;
const CREATE_VERB_RE =
	/^(?:create|make|build|draft|generate|write|prepare|put\s+together|start)\b\s*/i;
/** Words that may sit between the verb and the output noun. */
// "The" is left out on purpose: "make the deck shorter" edits an existing one.
// A lone "slide" is a slide inside a deck; "slide deck" still reads as a deck.
const MODIFIER_RE =
	/^(?:me|us|a|an|new|short|quick|simple|brief|basic|blank|clean|small|slide|os|tedix|[0-9]+(?:-?(?:slides?|pages?|tabs?|columns?|rows?|sections?))?|one|two|three|four|five|six|seven|eight|nine|ten)$/i;
/** "a new sheet in the budget": a part of an existing output. */
const INSIDE_RE = /^(?:in|inside|into|within)$/i;
const KIND_WORDS: ReadonlyArray<readonly [RegExp, OutputCreateKind]> = [
	[/^(?:deck|decks|presentations?|slideshow)$/i, "presentation"],
	[/^(?:sheet|sheets|spreadsheets?)$/i, "sheet"],
	[/^(?:doc|docs|document|documents)$/i, "document"],
];
/** The operator named another provider, so the Tedix output is not meant. */
const EXTERNAL_PROVIDER_RE =
	/\b(?:google|gdrive|notion|excel|microsoft|powerpoint|keynote|office ?365|onedrive|sharepoint|airtable|dropbox|canva|figma)\b/i;
/** A question about how to create one, not a request to create it. */
const HOW_TO_RE = /^(?:how|what|why|when|where|which|who)\b/i;
const MAX_MODIFIERS = 4;

/**
 * The output kind when the request opens with a create verb whose object is a
 * named Tedix output type. Null otherwise, including for questions and for
 * requests that name an external provider.
 */
export function explicitOutputCreateKind(
	content: string,
): OutputCreateKind | null {
	const firstLine = content.trim().split("\n", 1)[0]?.trim() ?? "";
	if (!firstLine || HOW_TO_RE.test(firstLine)) return null;
	if (EXTERNAL_PROVIDER_RE.test(firstLine)) return null;
	const afterLeadIn = firstLine.replace(LEAD_IN_RE, "");
	const verb = CREATE_VERB_RE.exec(afterLeadIn);
	if (!verb) return null;
	const words = afterLeadIn
		.slice(verb[0].length)
		.split(/\s+/)
		.map((word) => word.replace(/[^\p{L}\p{N}-]+$/u, ""));
	for (const [index, word] of words.entries()) {
		if (index > MAX_MODIFIERS) return null;
		const kind = KIND_WORDS.find(([pattern]) => pattern.test(word))?.[1];
		if (kind) return INSIDE_RE.test(words[index + 1] ?? "") ? null : kind;
		if (!MODIFIER_RE.test(word)) return null;
	}
	return null;
}
