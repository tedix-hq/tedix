/**
 * Kernel — Home delegation NARRATION classification.
 *
 * One delegation must read as ONE row in the Home transcript. The kernel
 * emits an assistant `message.completed` at every lifecycle transition of a
 * delegation (pre-dispatch ack, in-flight ack, operator cancel, terminal
 * disposition). Each of those turns restates — in prose — exactly the state
 * the adjacent delegation RECEIPT row already renders (target label, humanized
 * status, clamped result preview, Open / Stop actions), so the prose carries no
 * information the receipt does not.
 *
 * The rows are LEDGER rows in an append-only store, so they are never deleted
 * and never rewritten: the writer stamps a structural class on
 * `payload.metadata.homeNarration`, and the READ path
 * (`readMessages` → {@link collapseHomeDelegationNarration}) decides what
 * renders. Classification is by EMISSION SITE and run structure only — never
 * by matching message text. Four of five turns that "looked like" machine
 * narration in the live thread were the operator's own words, and the prose
 * templates are model-adjacent enough that any regex over them is a
 * data-loss bug waiting to happen.
 *
 * Precedent: `isHomeMessageEvent` (kernel-runtime/run-reads-streams.ts)
 * already hides two classes of kernel machinery from the rendered transcript
 * with metadata predicates (`dispatchMode === "kernel-inbox-wake"`,
 * `source === "kernelRuntime.planAssignmentCompletion"`). This module is the
 * same idea at delegation grain, with one addition it needs and that one did
 * not: a narration row may be the ONLY row carrying a given child run's
 * delegation metadata, and Tedix OS builds the receipt FROM that metadata. Dropping
 * such a row would delete the delegation from the transcript entirely, so the
 * collapse blanks the prose and keeps the row instead. See
 * {@link collapseHomeDelegationNarration}.
 */

import { nonNullRecord, stringFromPayload } from "./runtime-shared";

/**
 * Why a Home assistant turn's prose is redundant with its delegation receipt.
 *
 * - `delegation_ack` — the dispatch acknowledgement emitted by the turn that
 *   auto-dispatched a delegation ("On it — delegating to {tedi} now…"). Only
 *   stamped when the dispatch SUCCEEDED, because that is exactly the condition
 *   under which the turn carries `delegatedTediId` + `childRunId` and therefore
 *   renders a receipt. A `needs_approval` delegation is deliberately NOT
 *   stamped: it dispatches nothing, carries no child run, renders no receipt,
 *   and its prose is the only surface asking the operator to approve.
 * - `turn_canceled_delegated` — the operator-cancel marker written by the
 *   pre-materialize cancel gate for a turn whose dispatch had already landed.
 *   The receipt on the same turn resolves to "Canceled".
 * - `delegation_status_only` — a terminal delegation message whose body is a
 *   TEMPLATE over `(childRunStatus, childRunPreview)` because the child
 *   returned neither a final assistant message nor a synthesized result. Both
 *   template inputs are rendered by the receipt (status label + preview), so
 *   the turn is a pure restatement. A completion that relays a real child
 *   answer is never stamped — that answer is the delegation's return value.
 */
export type HomeNarrationClass =
	| "delegation_ack"
	| "delegation_status_only"
	| "turn_canceled_delegated";

const HOME_NARRATION_CLASSES: readonly HomeNarrationClass[] = [
	"delegation_ack",
	"delegation_status_only",
	"turn_canceled_delegated",
];

/**
 * Metadata fragment to spread into an emitted `message.completed`
 * `payload.metadata`. Keeping the key in one place stops the writers and the
 * read-path predicate from drifting apart.
 */
export function homeNarrationMetadata(narrationClass: HomeNarrationClass): {
	homeNarration: HomeNarrationClass;
} {
	return { homeNarration: narrationClass };
}

/** Read the stamped narration class off an event payload, or null. */
export function readHomeNarrationClass(
	payload: unknown,
): HomeNarrationClass | null {
	const metadata = nonNullRecord(nonNullRecord(payload)?.metadata);
	const value = stringFromPayload(metadata?.homeNarration);
	return HOME_NARRATION_CLASSES.includes(value as HomeNarrationClass)
		? (value as HomeNarrationClass)
		: null;
}

/**
 * The child run a message row's delegation receipt would be keyed to, or null
 * when the row carries no delegation linkage at all. Mirrors Tedix OS's
 * `buildHomeDelegationReceipt` / `dedupeHomeDelegationReceipts` pair: the
 * receipt is built from the row's delegation metadata, and only the FIRST row
 * per child run keeps it.
 */
function narrationChildRunKey(row: {
	childRunId: string | null;
	payload: unknown;
}): string | null {
	if (row.childRunId) return row.childRunId;
	const metadata = nonNullRecord(nonNullRecord(row.payload)?.metadata);
	return stringFromPayload(metadata?.childRunId) ?? null;
}

/** What the read path should do with one message row. */
export type HomeNarrationDisposition = "render" | "blank" | "drop";

/**
 * Decide, for a chronologically ORDERED (oldest first) page of Home message
 * rows, which narration rows may be dropped outright and which must survive
 * with their prose blanked.
 *
 * Each child run has exactly one CARRIER row — the row whose delegation
 * metadata the rendered receipt is built from. A row that renders anyway (no
 * narration class) is always preferred as the carrier; otherwise the oldest
 * narration row for that child run takes the job. Narration rows that are not
 * the carrier are DROPPED; the carrier is kept with `content: ""` so Tedix OS
 * renders the receipt alone (an empty assistant turn that carries a
 * `delegationReceipt` paints no bubble and no "No reply returned" degrade row —
 * see `message-views/message-text.ts`).
 *
 * Fail-safe direction: when the carrier cannot be identified (no child run
 * linkage, or the carrier fell off an older page), the row is BLANKED, never
 * dropped. Losing prose is recoverable from the ledger; losing the only
 * delegation row on screen is not.
 */
export function collapseHomeDelegationNarration<
	T extends { id: string; childRunId: string | null; payload: unknown },
>(rowsOldestFirst: readonly T[]): Map<string, HomeNarrationDisposition> {
	// An UNSTAMPED row always renders, so it is the carrier whenever one exists
	// for the child run — regardless of where it falls in the page. Resolving
	// the carrier by rank instead would make the outcome depend on how equal
	// `createdAt` timestamps happen to tie-break, which the event store does not
	// promise; a narration row could then be blanked in one read and dropped in
	// the next.
	const carrierRowIdByChildRun = new Map<string, string>();
	for (const row of rowsOldestFirst) {
		const key = narrationChildRunKey(row);
		if (!key || readHomeNarrationClass(row.payload)) continue;
		if (carrierRowIdByChildRun.has(key)) continue;
		carrierRowIdByChildRun.set(key, row.id);
	}
	for (const row of rowsOldestFirst) {
		const key = narrationChildRunKey(row);
		if (!key || carrierRowIdByChildRun.has(key)) continue;
		carrierRowIdByChildRun.set(key, row.id);
	}
	const dispositions = new Map<string, HomeNarrationDisposition>();
	for (const row of rowsOldestFirst) {
		if (!readHomeNarrationClass(row.payload)) continue;
		const key = narrationChildRunKey(row);
		const carrierRowId = key ? carrierRowIdByChildRun.get(key) : undefined;
		dispositions.set(
			row.id,
			carrierRowId && carrierRowId !== row.id ? "drop" : "blank",
		);
	}
	return dispositions;
}
