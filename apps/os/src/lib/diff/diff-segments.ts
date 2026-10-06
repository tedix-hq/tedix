import type { LineSlice } from "@/lib/diff/diff-model";

/** One run of a diff line, marked according to the word-aligned inline pass. */
export type DiffSegment = { text: string; changed: boolean };

/**
 * Splits a line into alternating unchanged/changed runs from its column slices.
 * Slices arrive per word-diff span, so they can overlap or be out of order;
 * they are sorted and merged first.
 */
export function lineSegments(
	text: string,
	slices: readonly LineSlice[],
): DiffSegment[] {
	if (slices.length === 0) return [{ text, changed: false }];

	const merged: LineSlice[] = [];
	for (const slice of [...slices].sort((a, b) => a.startCol - b.startCol)) {
		const last = merged.at(-1);
		if (last && slice.startCol <= last.endCol) {
			last.endCol = Math.max(last.endCol, slice.endCol);
			continue;
		}
		merged.push({ ...slice });
	}

	const segments: DiffSegment[] = [];
	let cursor = 1;
	for (const slice of merged) {
		if (slice.startCol > cursor) {
			segments.push({
				text: text.slice(cursor - 1, slice.startCol - 1),
				changed: false,
			});
		}
		const changed = text.slice(slice.startCol - 1, slice.endCol - 1);
		if (changed.length > 0) segments.push({ text: changed, changed: true });
		cursor = Math.max(cursor, slice.endCol);
	}
	if (cursor <= text.length) {
		segments.push({ text: text.slice(cursor - 1), changed: false });
	}
	return segments;
}
