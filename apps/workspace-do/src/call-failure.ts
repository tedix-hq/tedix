/**
 * What the model reads when one of its calls fails. A call that throws, is
 * refused or carries text that cannot be saved ends that call only: the
 * reason goes back as the call's result, the model corrects it, and the turn
 * goes on.
 */

/** Half of a two-part character such as an emoji: an unpaired UTF-16 surrogate. */
const HALF_CHARACTER =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Where in `value` a string holds half of a character, or null when every
 * string is whole. Such text does not survive being saved as UTF-8: the half
 * would turn into a replacement mark without anyone asking for it.
 */
export function halfCharacterPath(value: unknown, path = ""): string | null {
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

/** Why a call's arguments cannot be saved, or null when their text is whole. */
export function unsavableTextError(args: unknown[]): string | null {
	for (const [index, arg] of args.entries()) {
		const path = halfCharacterPath(arg, args.length > 1 ? `[${index}]` : "");
		if (path)
			return `Nothing was changed: ${path} holds half of a character, usually an emoji cut in two (an unpaired UTF-16 surrogate), which cannot be saved. Send whole characters and make the call again.`;
	}
	return null;
}

interface InputIssue {
	path: PropertyKey[];
	message: string;
}

function inputIssues(error: unknown): InputIssue[] | null {
	if (!(error instanceof Error) || error.name !== "ZodError") return null;
	const issues = (error as { issues?: unknown }).issues;
	if (!Array.isArray(issues) || issues.length === 0) return null;
	return issues.every(
		(issue): issue is InputIssue =>
			typeof issue === "object" &&
			issue !== null &&
			Array.isArray((issue as InputIssue).path) &&
			typeof (issue as InputIssue).message === "string",
	)
		? issues
		: null;
}

/**
 * A thrown value as one readable line. Arguments a schema refuses name the
 * field and what it expected; a value that is not an Error is shown as it is
 * instead of as "[object Object]".
 */
export function callFailureText(error: unknown): string {
	const issues = inputIssues(error);
	if (issues)
		return `Invalid arguments: ${issues
			.map((issue) =>
				issue.path.length
					? `${issue.path.map(String).join(".")}: ${issue.message}`
					: issue.message,
			)
			.join("; ")}`.slice(0, 2_000);
	if (error instanceof Error) return error.message || error.name;
	if (typeof error === "string" && error) return error;
	let shown: string | undefined;
	try {
		shown = JSON.stringify(error);
	} catch {
		// Shown by String below.
	}
	return `The call threw ${(shown ?? String(error)).slice(0, 2_000)} instead of an Error`;
}
