/**
 * Measures assembled system-prompt segments and their share of the context
 * window. The target is diagnostic: this module never truncates prompts or
 * enforces a token limit.
 */

import { countTokens } from "./tokens.js";

/** One labeled contributor to the assembled system prompt. */
export interface PromptSegment {
	name: string;
	text: string;
}

export interface PromptSegmentMeasurement {
	name: string;
	tokens: number;
	/** Share of the measured prompt total, 0..1. */
	shareOfPrompt: number;
	/** Share of the model's context window, 0..1. Null when the window is unknown. */
	shareOfWindow: number | null;
}

export interface PromptCompositionReport {
	totalTokens: number;
	contextWindowTokens: number | null;
	/** Assembled prompt as a fraction of the window, 0..1. Null when unknown. */
	shareOfWindow: number | null;
	/** Segments, largest first. */
	segments: PromptSegmentMeasurement[];
	/** Largest single contributor, or null when nothing was measured. */
	dominant: PromptSegmentMeasurement | null;
	/**
	 * True when the prompt exceeds {@link PROMPT_WINDOW_TARGET_SHARE} of the
	 * window. Diagnostic only; it does not trigger truncation.
	 */
	overTarget: boolean;
}

/**
 * Diagnostic target: assembled system prompt ≈10% of the context window.
 * This is not a cap.
 */
export const PROMPT_WINDOW_TARGET_SHARE = 0.1;

function ratio(part: number, whole: number | null): number | null {
	if (whole === null || whole <= 0) return null;
	return part / whole;
}

/**
 * Measure the composition of an assembled system prompt.
 *
 * Keep empty segments with `tokens: 0` to distinguish an empty contribution
 * from an omitted producer.
 */
export function measurePromptComposition(
	segments: readonly PromptSegment[],
	options?: { contextWindowTokens?: number | null },
): PromptCompositionReport {
	const contextWindowTokens = options?.contextWindowTokens ?? null;
	const measured = segments.map((segment) => ({
		name: segment.name,
		tokens: countTokens(segment.text),
	}));
	const totalTokens = measured.reduce((sum, item) => sum + item.tokens, 0);

	const withShares: PromptSegmentMeasurement[] = measured
		.map((item) => ({
			name: item.name,
			tokens: item.tokens,
			shareOfPrompt: totalTokens > 0 ? item.tokens / totalTokens : 0,
			shareOfWindow: ratio(item.tokens, contextWindowTokens),
		}))
		.sort((a, b) => b.tokens - a.tokens);

	const shareOfWindow = ratio(totalTokens, contextWindowTokens);
	return {
		totalTokens,
		contextWindowTokens,
		shareOfWindow,
		segments: withShares,
		dominant: withShares[0] ?? null,
		overTarget:
			shareOfWindow !== null && shareOfWindow > PROMPT_WINDOW_TARGET_SHARE,
	};
}
