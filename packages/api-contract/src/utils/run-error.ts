const MAX_RUN_ERROR = 300;

/**
 * One readable line from a stored run error. A failed tool call is stored as
 * a Code Mode JSON envelope whose first 300 characters are all preamble; name
 * the failed tool and its own error instead.
 */
export function summarizeRunError(error: string | null): string | null {
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
	return text.length > MAX_RUN_ERROR
		? `${text.slice(0, MAX_RUN_ERROR - 1)}…`
		: text;
}
