/**
 * Additive answer-delta channel for one Home run's durable event tail.
 *
 * The kernel persists batched `message.delta` rows (~1s per flush, see
 * `apps/api/src/kernel/answer-delta-batcher.ts`) into the same
 * `kernel_runtime_events` stream the CLI already tails via
 * `read_home_run_events`. This module projects those rows into an
 * answer-so-far string.
 *
 * Invariants:
 *   - Deltas are NEVER the source of truth. The canonical terminal
 *     `message.completed` (rendered by `printSummary`) wins: once it lands the
 *     stream settles and every later delta is ignored.
 *   - Ordering is by the row's own `sequence`, not arrival order — a delta that
 *     arrives late (split page, re-read from an earlier offset) is reconciled
 *     into its slot instead of appended at the tail.
 *   - A durable re-drive namespaces its rows under a higher `streamAttempt`
 *     (see `recordHomeAnswerDelta`). A higher attempt REPLACES the accumulated
 *     text, because the replayed answer is a different generation, not a
 *     continuation of the pre-crash partial.
 */

import type { HomeRunEvent } from "./home-client";
import { stringValue } from "./home-client";
import { isRecord } from "@tedix/api-contract/utils/is-record";

export interface AnswerStreamSnapshot {
	/** Answer text accumulated from deltas so far. */
	text: string;
	/** True once the canonical terminal message for this run has landed. */
	settled: boolean;
}

export interface AnswerStream {
	/**
	 * Ingest one tailed event. Returns the new snapshot when this event changed
	 * the stream (a delta applied, or the run settled), `null` otherwise — so a
	 * caller can render only on change.
	 */
	ingest(event: HomeRunEvent): AnswerStreamSnapshot | null;
	snapshot(): AnswerStreamSnapshot;
}

/** Event kinds that make the canonical projection authoritative for this run. */
const SETTLING_KINDS = new Set([
	"message.completed",
	"run.completed",
	"run.failed",
	"run.canceled",
	"run.cancelled",
]);

/** Pull the delta text out of a `message.delta` row's payload. */
function deltaText(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (!isRecord(payload)) return "";
	return (
		stringValue(payload.content) ??
		stringValue(payload.delta) ??
		stringValue(payload.text) ??
		""
	);
}

/** `payload.metadata.streamAttempt` — 0 for the original stream. */
function streamAttempt(payload: unknown): number {
	if (!isRecord(payload)) return 0;
	const metadata = isRecord(payload.metadata) ? payload.metadata : {};
	const raw = metadata.streamAttempt;
	return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

export interface AnswerStreamOptions {
	/**
	 * Event kind projected into the text. Default `message.delta` (the answer).
	 * `message.reasoning` carries the planner's PROVISIONAL rationale in the
	 * same sequence-keyed shape (`recordHomeRationaleDelta`), and settles on the
	 * same terminal kinds.
	 */
	kind?: string;
}

export function createAnswerStream(
	options: AnswerStreamOptions = {},
): AnswerStream {
	const streamKind = options.kind ?? "message.delta";
	// sequence → chunk. A Map keyed by the row's own sequence makes a repeated
	// or out-of-order page idempotent; the text is the sorted concatenation.
	let chunks = new Map<number, string>();
	let attempt = 0;
	let settled = false;
	let text = "";

	/** Ordering slot for a row the reader delivered without a sequence. */
	const nextFallbackSequence = (): number =>
		chunks.size === 0 ? 1 : Math.max(...chunks.keys()) + 1;

	const rebuild = (): string =>
		[...chunks.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, chunk]) => chunk)
			.join("");

	const snapshot = (): AnswerStreamSnapshot => ({ text, settled });

	return {
		snapshot,
		ingest(event: HomeRunEvent): AnswerStreamSnapshot | null {
			const kind = event.kind ?? "";
			if (SETTLING_KINDS.has(kind)) {
				if (settled) return null;
				settled = true;
				return snapshot();
			}
			if (kind !== streamKind) return null;
			// The canonical answer already landed: a straggling delta row must not
			// resurrect a partial answer behind it.
			if (settled) return null;
			const chunk = deltaText(event.payload);
			if (!chunk) return null;
			const rowAttempt = streamAttempt(event.payload);
			if (rowAttempt < attempt) return null;
			if (rowAttempt > attempt) {
				attempt = rowAttempt;
				chunks = new Map();
			}
			const sequence =
				typeof event.sequence === "number" && Number.isFinite(event.sequence)
					? event.sequence
					: nextFallbackSequence();
			if (chunks.get(sequence) === chunk) return null;
			chunks.set(sequence, chunk);
			text = rebuild();
			return snapshot();
		},
	};
}
