/**
 * Facet→parent turn-stream frame contract + incremental NDJSON parser
 * used by the native runtime and plain-Bun unit tests. Imports are type-only,
 * so the parser has no runtime dependency on the facet or telemetry owner.
 */

import type { FacetBudgetStopReason } from "./conversation-facet";
import type { FacetTurnUsage } from "./step-telemetry";

/** One newline-delimited frame on the facet→parent turn stream. */
export type FacetStreamFrame =
	| { kind: "delta"; text: string }
	| {
			kind: "done";
			requestId: string | null;
			text: string;
			turnCount: number;
			turnMs: number;
			/**
			 * Aggregate model-reported token usage for the turn, summed across the
			 * facet's own provider-round receipts. Absent when no step reported usage
			 * (null-absent) so the parent's ledger mirror can fall back to its step
			 * buffer without ever fabricating a zero.
			 */
			usage?: FacetTurnUsage;
			/** Present when the mid-turn budget gate stopped the loop early —
			 * the parent logs loudly and threads it into the settled turn. */
			stopReason?: FacetBudgetStopReason;
	  }
	| { kind: "error"; message: string }
	// The raw AI SDK chunk body (a JSON string with a `type` field:
	// text-delta / tool-input-* / tool-output-* / data-* / message-metadata).
	// The parent forwards this raw body through the internal stream; the embedded
	// capability adapter delivers it as a callback for tool and data rendering.
	| { kind: "chunk"; body: string };

/**
 * Incremental NDJSON frame parser for the facet turn stream. Pure — the
 * parent feeds decoded chunks and carries `rest` between reads; unparseable
 * lines are dropped (a malformed frame degrades to the terminal frame, it
 * never wedges the pump).
 */
export function parseFacetStreamFrames(buffer: string): {
	frames: FacetStreamFrame[];
	rest: string;
} {
	const frames: FacetStreamFrame[] = [];
	const segments = buffer.split("\n");
	const rest = segments.pop() ?? "";
	for (const segment of segments) {
		const line = segment.trim();
		if (!line) continue;
		try {
			const parsed = JSON.parse(line) as FacetStreamFrame;
			if (
				parsed &&
				(parsed.kind === "delta" ||
					parsed.kind === "done" ||
					parsed.kind === "error" ||
					parsed.kind === "chunk")
			) {
				frames.push(parsed);
			}
		} catch {
			// Dropped malformed line — see docstring.
		}
	}
	return { frames, rest };
}
