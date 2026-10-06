/**
 * Kernel — deterministic answer delivery chunker.
 *
 * `answer_in_home` answers stream from the planner's single `streamObject`
 * pass (`route-planner.ts` → `onAnswerDelta`): those deltas ARE the answer,
 * so there is no second LLM pass over them. Every OTHER route's
 * operator-facing text is RENDERED by code (delegation acknowledgements,
 * approval cards, clarifying questions, workflow confirmations) — this module
 * splits that text into word-boundary chunks so the Tedix OS renders it
 * progressively through the same `answerDelta` channel instead of showing
 * nothing until the terminal run patch.
 *
 * Delivery only: the durable D1 run row remains the source of truth.
 */

/**
 * Split `text` into word-boundary chunks of roughly `targetChunkChars`.
 * Pure; concatenating the chunks yields the input exactly.
 */
export function chunkAnswerForDelivery(
	text: string,
	targetChunkChars = 24,
): string[] {
	if (!text) return [];
	const chunks: string[] = [];
	let current = "";
	for (const token of text.split(/(?<=\s)/)) {
		current += token;
		if (current.length >= targetChunkChars) {
			chunks.push(current);
			current = "";
		}
	}
	if (current) chunks.push(current);
	return chunks;
}
