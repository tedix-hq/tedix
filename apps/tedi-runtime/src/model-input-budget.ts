/**
 * Per-model INPUT BUDGET resolution for mid-turn compaction.
 *
 * Providers do not price input at one flat rate across a model's whole context
 * window: past a threshold the remainder of the turn bills at the higher
 * long-context rate. That threshold is NOT the window, so a policy that
 * compacts at a share of the window sails over the cliff on any large-window
 * model and pays the premium for the rest of the turn.
 *
 * This module owns the one cliff table and nothing else. It deliberately holds
 * no runtime harness dependency, so the policy is directly unit-testable under
 * `bun run`, unlike `context-overflow.ts` which consumes it.
 */

/**
 * Context window the runtime budgets against when it knows nothing else. The
 * cognition model catalog (`@tedix/api-contract/schemas/model-catalog`) does
 * not model context windows, so an unlisted model resolves here.
 */
export const TEDI_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * A provider PRICE CLIFF: the input-token count at or above which a call is
 * billed at the higher long-context rate.
 */
export interface ModelInputBudgetCliff {
	/**
	 * Case-insensitive prefix of a canonical `provider/model-id` ref
	 * (`@tedix/api-contract/schemas/model-catalog`). First match wins, so keep
	 * this list most-specific first.
	 */
	refPrefix: string;
	/** Input tokens to budget against instead of the context window. */
	inputBudgetTokens: number;
	/** Where the number comes from. No entry here is an estimate. */
	because: string;
}

/**
 * The whole cliff table. Deliberately tiny and data-shaped: an entry earns its
 * place only when its number has a named source. A model that is not listed
 * falls back to the context window (see {@link resolveModelInputBudgetTokens})
 * — for an unknown model that fallback IS the answer, not a gap to fill with a
 * plausible-looking guess.
 */
export const MODEL_INPUT_BUDGET_CLIFFS: readonly ModelInputBudgetCliff[] = [
	...(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] as const).map(
		(model) => ({
			refPrefix: `azure-openai/${model}`,
			inputBudgetTokens: 272_000,
			because:
				"Microsoft's OpenAI provider documents whole-request long-context pricing above 272,000 input tokens: https://github.com/microsoft/amplifier-module-provider-openai#long-context",
		}),
	),
	{
		refPrefix: "azure-openai/gpt-5.6",
		inputBudgetTokens: 272_000,
		because:
			"GPT-5.6 has a separate compaction input budget of 272K that is smaller than its context window. This is that budget, not a window.",
	},
	{
		refPrefix: "anthropic/",
		inputBudgetTokens: 200_000,
		because:
			"Anthropic bills input above 200K tokens at its long-context rate on the 1M-context models, so the cliff stays at 200K however large the window is. Not reachable on the certified runtime today (`AGENT_RUNTIME_AVAILABLE_PROVIDERS` is azure-openai only); it is here so wiring the provider cannot silently start paying the premium rate.",
	},
];

/**
 * Input budget to compact against for one turn.
 *
 * - A ref matching a {@link MODEL_INPUT_BUDGET_CLIFFS} entry uses that cliff,
 *   capped by an EXPLICIT window when the caller supplied one — never budget
 *   above a window we were actually told about.
 * - Everything else — no ref, an unknown ref, a malformed ref — falls back to
 *   the window: the caller's explicit one, else
 *   {@link TEDI_CONTEXT_WINDOW_TOKENS}. An unlisted model is the expected case,
 *   not an exceptional one.
 */
export function resolveModelInputBudgetTokens(
	modelRef?: string | null,
	windowTokens?: number,
): number {
	const fallbackWindow = windowTokens ?? TEDI_CONTEXT_WINDOW_TOKENS;
	if (!modelRef) return fallbackWindow;
	const ref = modelRef.toLowerCase();
	const cliff = MODEL_INPUT_BUDGET_CLIFFS.find((entry) =>
		ref.startsWith(entry.refPrefix.toLowerCase()),
	);
	if (!cliff) return fallbackWindow;
	return windowTokens === undefined
		? cliff.inputBudgetTokens
		: Math.min(cliff.inputBudgetTokens, windowTokens);
}
