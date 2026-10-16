/**
 * Reflector — pure result-shape + token-budget helpers. The actual LLM call
 * lives in the runtime or brain-bridge. These helpers handle
 * the before/after token accounting and the "reflection expanded → keep
 * original" safety check.
 */

import { parseObserverResult } from "./observer";
import { countTokens } from "./tokens.js";
import type { Observation, ReflectionResult } from "./types.js";

/** Build the unchanged ReflectionResult returned when no merge happened. */
export function noopReflection(
	observations: Observation[],
	tokensBefore: number,
): ReflectionResult {
	return {
		observations,
		mergedCount: 0,
		keptCount: observations.length,
		tokensBefore,
		tokensAfter: tokensBefore,
	};
}

/**
 * Token count for a serialized observation log. Callers pass the
 * serialized string (serialization lives in the runtime/store layer) —
 * this is just a thin wrapper to keep the heuristic consistent.
 */
export function tokensForSerialized(serialized: string): number {
	return countTokens(serialized);
}

/**
 * Apply the safety check: if the condensed observation set serializes to
 * MORE tokens than the original, keep the original. Returns the chosen
 * `ReflectionResult`. Callers supply the serialized forms (both before
 * and after) so this stays runtime-neutral.
 */
export function finalizeReflection(args: {
	original: Observation[];
	condensed: Observation[];
	tokensBefore: number;
	tokensAfter: number;
}): ReflectionResult {
	const { original, condensed, tokensBefore, tokensAfter } = args;

	if (tokensAfter >= tokensBefore) {
		return noopReflection(original, tokensBefore);
	}

	return {
		observations: condensed,
		mergedCount: original.length - condensed.length,
		keptCount: condensed.length,
		tokensBefore,
		tokensAfter,
	};
}

/**
 * Parse the raw JSON content from a Reflector LLM call into an Observation
 * array. Returns `[]` on parse failure. Filters to entries with valid
 * `content`, `priority`, and `type` strings.
 */
export function parseReflectorObservations(content: string): Observation[] {
	return parseObserverResult(content).observations;
}
