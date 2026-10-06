/**
 * The message of a thrown value: `error.message` for an `Error`, `String(value)`
 * for anything else. Variants that walk `cause`, strip prefixes, or substitute
 * fallback text stay with their callers.
 */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
