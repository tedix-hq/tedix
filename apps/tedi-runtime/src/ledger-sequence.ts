/**
 * A monotonic cursor for runtime-ledger `sequence` values.
 *
 * Every runtime event carries a deterministic id, and
 * `insertTediRuntimeEvent` writes it with `onConflictDoNothing` on that id:
 * a re-issued id is dropped in silence. So any counter that feeds an event id
 * must never rewind — and a plain field on the Durable Object (`private n = 0`)
 * rewinds on every eviction, which a long turn survives routinely.
 *
 * If the DO restarts mid-turn, later calls re-issue indices 0..n and every
 * one is dropped on conflict, so the ledger reads as if the turn stopped
 * working while it kept going.
 *
 * The cursor is therefore anchored to the wall clock rather than to instance
 * state: a fresh instance resumes above every value the previous one issued,
 * and successive calls inside one millisecond still step forward.
 */

/** Anchor for the cursor. Any fixed past instant works; this keeps it small. */
const LEDGER_SEQUENCE_EPOCH_MS = Date.UTC(2026, 0, 1);
/**
 * Values reserved per millisecond. A turn emits several events inside one
 * millisecond, and a cursor that ran ahead of the clock to fit them would still
 * be ahead when a fresh instance re-derived its start from the clock — the
 * headroom is what keeps a restart strictly above what came before it. 2^10 per
 * millisecond keeps a decade of values inside `Number.MAX_SAFE_INTEGER`.
 */
const LEDGER_SEQUENCE_SUBTICKS = 1024;

export class LedgerSequence {
	private cursor = 0;

	/** The next value, strictly greater than every value already issued. */
	next(): number {
		const tick =
			Math.max(1, Date.now() - LEDGER_SEQUENCE_EPOCH_MS) *
			LEDGER_SEQUENCE_SUBTICKS;
		this.cursor = this.cursor < tick ? tick : this.cursor + 1;
		return this.cursor;
	}
}
