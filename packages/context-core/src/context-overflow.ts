/**
 * Provider context-overflow classification.
 *
 * A proactive compaction threshold is always an ESTIMATE — Tedix budgets in
 * chars/4, prompts vary, and providers count tokens their own way — so a
 * threshold alone will occasionally be wrong and the turn dies with a provider
 * error the operator cannot act on. Every mature agent runtime pairs the
 * proactive trigger with a reactive arm that classifies the overflow, folds
 * harder, and retries once. This is the classifier for that arm.
 *
 * The classifier is runtime-neutral so Home and native Pi provider adapters
 * can classify provider errors without importing either runtime.
 */

/**
 * Context-window overflow messages across the providers Tedix actually calls
 * (Azure OpenAI and Workers AI on the Home path, plus the Anthropic/Google
 * wording the tedi path can see). Matched case-insensitively against the error
 * message, because no provider exposes a machine-readable code for this.
 */
const CONTEXT_OVERFLOW_PATTERN =
	/prompt is too long|context[_ ]length[_ ]exceeded|maximum context length|exceeds the maximum number of tokens|input token count|reduce the length of|input is too long|too many (?:input )?tokens|context window/i;

/** Whether a thrown provider error is a context-window overflow. */
export function isContextOverflowError(error: unknown): boolean {
	let text: string;
	if (error instanceof Error) text = error.message;
	else if (typeof error === "string") text = error;
	else {
		try {
			text = JSON.stringify(error);
		} catch {
			text = String(error);
		}
	}
	return CONTEXT_OVERFLOW_PATTERN.test(text);
}
