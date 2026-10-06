/**
 * Between-turn compaction boundary — the one shared implementation.
 *
 * Two surfaces fold the OLD head of a conversation into a summary and keep the
 * newest turns verbatim: the kernel's replay projection
 * (`apps/api/.../kernel/context-compaction.ts`) and the tedi session repo's
 * compaction overlay (`@tedix/tedi-session/session-repo`). Both walked back from
 * the tail accumulating weight until the retained suffix met a budget, then
 * lowered the cut onto a `user` entry so a turn is never split across the
 * summary line. That walk lived twice; it lives here now.
 *
 * What stays at the call site, deliberately:
 *   - the WEIGHT UNIT (the kernel accounts in chars, the repo in estimated
 *     tokens) — each caller maps its own rows into {@link WeightedTurn},
 *   - the IDENTITY of the cut (an array index for the kernel, an entry id for
 *     the repo) — the index returned here is into the array that was passed in,
 *   - budget ratios, checkpoint rendering, marker rows, and any caller-specific
 *     fallback policy for the degenerate cases.
 *
 * This leaf is runtime-neutral and dependency-free on purpose.
 *
 */

/** One conversation entry reduced to what boundary selection needs. */
export interface WeightedTurn {
	/** Entry role. Only `"user"` is load-bearing: it marks a turn start. */
	role: string;
	/** Cost of this entry in the caller's own unit (chars, tokens, …). */
	weight: number;
}

/** Where the retained suffix begins. */
export interface RetainSelection {
	/** Index into the array passed in of the FIRST entry to retain. Always > 0. */
	retainFrom: number;
	/**
	 * Whether the budget walk landed on a non-user entry and had to be lowered
	 * onto the user entry that opened its turn.
	 */
	snapped: boolean;
}

/**
 * Index of the first entry to RETAIN, or `undefined` when nothing is worth
 * folding.
 *
 * Walks backward from the tail accumulating `weight` until the retained suffix
 * reaches `keepWeight`, then lowers the cut to the nearest turn start (a `user`
 * entry). Cutting only on a turn start is what keeps the boundary from orphaning
 * an assistant reply from the request it answers.
 *
 * GUARANTEE: a returned `retainFrom` ALWAYS names a `user` entry. The snap loop
 * either reaches one or falls to index 0, and index 0 reports "cannot advance".
 * That is also what makes it impossible to split a tool call from its result
 * without this function knowing anything about tool roles: a tool call and its
 * result live inside the turn opened by the preceding `user` entry, so a cut on
 * a turn start can never fall between them. Neither caller passes `tool` entries
 * today; the property is pinned by tests so it survives the one that will.
 *
 * Returns `undefined` in the three degenerate cases:
 *   - there are no turns at all,
 *   - the whole history fits under `keepWeight` (the walk runs off the front —
 *     nothing to fold),
 *   - the only available turn start is index 0, which would fold nothing.
 *
 * A caller that would rather fold SOMETHING than fold nothing applies its own
 * fallback on `undefined`; that is policy, not this algorithm.
 */
export function selectRetainIndex(
	turns: readonly WeightedTurn[],
	keepWeight: number,
): RetainSelection | undefined {
	if (turns.length === 0) return undefined;

	// Accumulate from the tail until the retained suffix meets the budget.
	let accumulated = 0;
	let cutIndex = -1;
	for (let i = turns.length - 1; i >= 0; i -= 1) {
		accumulated += turns[i]?.weight ?? 0;
		if (accumulated >= keepWeight) {
			cutIndex = i;
			break;
		}
	}
	// Ran off the front: the whole history fits under the budget.
	if (cutIndex < 0) return undefined;

	// Lower the cut onto the user entry that opened the turn.
	let retainFrom = cutIndex;
	let snapped = false;
	if (turns[retainFrom]?.role !== "user") {
		snapped = true;
		while (retainFrom > 0 && turns[retainFrom]?.role !== "user")
			retainFrom -= 1;
	}

	// Snapping reached the head (or there is no user turn at all): folding the
	// empty prefix is a no-op, so report that the boundary cannot advance.
	if (retainFrom <= 0) return undefined;

	return { retainFrom, snapped };
}
