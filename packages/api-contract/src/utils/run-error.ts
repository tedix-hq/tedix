const MAX_RUN_ERROR = 300;

/** A summary shown on one line of a run page, with the full text in Details. */
export const RUN_ERROR_HEADLINE_LENGTH = 120;

/**
 * One readable line from a stored run error. A failed tool call is stored as
 * a Code Mode JSON envelope whose first 300 characters are all preamble; name
 * the failed tool and its own error instead. `maxLength` bounds the result,
 * ellipsis included.
 */
export function summarizeRunError(
	error: string | null,
	maxLength = MAX_RUN_ERROR,
): string | null {
	if (!error) return null;
	const failure =
		/"failures"\s*:\s*\[\s*\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"error"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(
			error,
		);
	let text = error;
	if (failure) {
		let detail = failure[2] ?? "";
		try {
			detail = JSON.parse(`"${detail}"`) as string;
		} catch {
			// Keep the escaped text.
		}
		text = `${failure[1]} failed: ${detail}`;
	}
	text = text.replace(/\s+/g, " ").trim();
	return text.length > maxLength
		? `${text.slice(0, maxLength - 1).trimEnd()}…`
		: text;
}
