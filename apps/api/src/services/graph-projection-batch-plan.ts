import { coalesceGraphProjectionEvents } from "@tedix/db/queries/graph-projection";
import type { GraphProjectionOutboxEvent } from "@tedix/db/schema/graph-projection";

export type DurableGraphProjectionBatchPlan = {
	coalesced: GraphProjectionOutboxEvent[];
	eligibleCount: number;
	endSequence: number | null;
	blockedReason: string | null;
	/** First sequence read, eligible or not. `null` when the outbox is drained. */
	headSequence: number | null;
	/**
	 * Last sequence read, including a tail still waiting out its retry backoff.
	 * This is the organization's observed backlog high water for this batch; it
	 * is never a cursor candidate — only `endSequence` is.
	 */
	fetchedEndSequence: number | null;
};

export type GraphProjectionEventSelection = {
	/** Events to project. Poisoned events are excluded. */
	projectable: GraphProjectionOutboxEvent[];
	/** Furthest sequence the cursor may advance through, skipped rows included. */
	endSequence: number | null;
	/** Poisoned events acknowledged without projecting. */
	skippedPoisoned: number;
};

/**
 * The single eligibility rule for both drain paths.
 *
 * Stop at the first event still waiting out its retry backoff: it is due later
 * and becomes the next head. A poisoned event is not waiting for anything — its
 * retry budget is already spent — so skip it and keep going. Parking the cursor
 * on one exhausted event freezes the whole organization, and because the
 * retention prune only deletes rows at or below the cursor, every later row
 * becomes permanently uncollectable too. One org accrued 934,288 outbox rows
 * across 37 days behind 57 poisoned events.
 *
 * This lives in one place deliberately: the rule was duplicated in the durable
 * Workflow plan and the service drain, and the deadlock above had to be fixed
 * in both. A second copy is a second thing to forget.
 */
export function selectProjectableGraphProjectionEvents(
	fetched: GraphProjectionOutboxEvent[],
	nowMs: number,
): GraphProjectionEventSelection {
	const firstBackoffIndex = fetched.findIndex(
		(item) =>
			item.poisonedAt == null &&
			item.nextAttemptAt != null &&
			Date.parse(item.nextAttemptAt) > nowMs,
	);
	const inRange =
		firstBackoffIndex < 0 ? fetched : fetched.slice(0, firstBackoffIndex);
	const projectable = inRange.filter((item) => item.poisonedAt == null);
	return {
		projectable,
		endSequence: inRange.at(-1)?.sequence ?? null,
		skippedPoisoned: inRange.length - projectable.length,
	};
}

/**
 * Freeze the time-dependent ordered prefix and its acknowledged end sequence.
 * The Workflow persists this entire value in one step before hydration starts;
 * replay must never re-evaluate nextAttemptAt against a later wall clock while
 * reusing cached downstream steps.
 */
export function buildDurableGraphProjectionBatchPlan(
	fetched: GraphProjectionOutboxEvent[],
	nowMs: number,
): DurableGraphProjectionBatchPlan {
	const selection = selectProjectableGraphProjectionEvents(fetched, nowMs);
	return {
		coalesced: coalesceGraphProjectionEvents(selection.projectable),
		eligibleCount: selection.projectable.length,
		// `endSequence` acknowledges skipped events too, or the cursor never
		// passes them.
		endSequence: selection.endSequence,
		// Skipping is not silent: the organization reports `degraded` with the
		// count, because those entities keep a stale projection until something
		// touches them again or a repair pass rebuilds them.
		blockedReason:
			selection.skippedPoisoned > 0
				? `skipped_poison_events:${selection.skippedPoisoned}`
				: null,
		headSequence: fetched[0]?.sequence ?? null,
		fetchedEndSequence: fetched.at(-1)?.sequence ?? null,
	};
}
