/**
 * Character-based token approximation.
 * Uses the chars / 4 heuristic — no external dependencies.
 */

/**
 * Approximate token count for a string using the chars/4 heuristic.
 */
export function countTokens(text: string): number {
	return Math.ceil(text.length / 4);
}
