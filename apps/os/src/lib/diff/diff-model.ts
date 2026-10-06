import {
	type CharSpan,
	type DiffRange,
	diffTokens,
	diffWords,
	preservedFraction,
	trimmedRange,
} from "@/lib/diff/diff-core";

/**
 * A unified diff model, built in two passes over the primitive in `diff-core`.
 *
 * 1. A LINE-level pass gives exact line alignment: unchanged lines are never
 *    swallowed into a neighbouring change, and a change separated from the next
 *    by a single unchanged line stays two changes.
 * 2. A WORD-aligned pass over each changed region gives the inline highlights,
 *    plus a replacement-vs-unrelated heuristic. Word granularity matters for
 *    both: a character-minimal diff highlights the letters two unrelated
 *    sentences happen to share, and counting those as "preserved" would pair
 *    lines that should read as a plain deletion followed by a plain addition.
 *
 * The output is deliberately UNIFIED rather than split: a proposal review card
 * is narrow and the reviewer's question is "what changed", not "how do the two
 * documents align side by side". Removed lines therefore render directly above
 * the added lines that replaced them.
 *
 * Both sides split on "\n" only, so every line number in the model indexes the
 * source strings exactly.
 */

export type DiffStatus = "added" | "deleted" | "modified" | "unchanged";

/** A single-line column range. 1-based; `startCol` inclusive, `endCol` exclusive. */
export type LineSlice = { startCol: number; endCol: number };

export type DiffLineKind = "context" | "added" | "removed";

export type DiffLine = {
	kind: DiffLineKind;
	/** 1-based line in the original document; null on an added line. */
	originalLine: number | null;
	/** 1-based line in the modified document; null on a removed line. */
	modifiedLine: number | null;
	text: string;
	/** Word-aligned changed spans. Empty unless this line is part of a replacement. */
	slices: LineSlice[];
};

export type DiffHunk = {
	/** Stable across rebuilds of the same pair of documents. */
	key: string;
	originalStart: number;
	modifiedStart: number;
	lines: DiffLine[];
};

export type DiffModel = {
	status: DiffStatus;
	additions: number;
	deletions: number;
	hunks: DiffHunk[];
	/**
	 * True when the line pass exceeded its scan limit and the model fell back to
	 * one coarse prefix/suffix-trimmed change. The view says so rather than
	 * presenting a guess as a precise diff.
	 */
	approximate: boolean;
};

/** Unchanged lines kept on each side of a change. */
export const DEFAULT_CONTEXT_LINES = 3;

/** Lines longer than this are not inline-highlighted; the word diff is not worth it. */
export const MAX_INLINE_LINE_LENGTH = 1024;

/** Minimum non-whitespace preservation on BOTH sides to count as a real replacement. */
const MIN_REPLACEMENT_PRESERVATION = 0.3;

export type BuildDiffOptions = {
	contextLines?: number;
};

export function buildUnifiedDiff(
	original: string,
	modified: string,
	options: BuildDiffOptions = {},
): DiffModel {
	const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
	const originalLines = original.split("\n");
	const modifiedLines = modified.split("\n");

	let approximate = false;
	let ranges = diffTokens(originalLines, modifiedLines);
	if (ranges === null) {
		approximate = true;
		const fallback = trimmedRange(originalLines, modifiedLines);
		ranges = fallback === null ? [] : [fallback];
	}

	const lines: DiffLine[] = [];
	let additions = 0;
	let deletions = 0;
	let cursorOriginal = 0;
	let cursorModified = 0;

	for (const range of ranges) {
		// The gap before a change is unchanged on both sides, so the two cursors
		// advance together by the same count.
		const unchanged = range.fromA - cursorOriginal;
		for (let i = 0; i < unchanged; i++) {
			lines.push(
				contextLine(
					originalLines[cursorOriginal + i] ?? "",
					cursorOriginal + i + 1,
					cursorModified + i + 1,
				),
			);
		}
		cursorOriginal += unchanged;
		cursorModified += unchanged;

		additions += range.toB - range.fromB;
		deletions += range.toA - range.fromA;
		for (const line of changeLines(range, originalLines, modifiedLines)) {
			lines.push(line);
		}

		cursorOriginal = range.toA;
		cursorModified = range.toB;
	}
	const trailing = originalLines.length - cursorOriginal;
	for (let i = 0; i < trailing; i++) {
		lines.push(
			contextLine(
				originalLines[cursorOriginal + i] ?? "",
				cursorOriginal + i + 1,
				cursorModified + i + 1,
			),
		);
	}

	return {
		status: diffStatus(original, modified, additions, deletions),
		additions,
		deletions,
		hunks: groupHunks(lines, contextLines),
		approximate,
	};
}

function diffStatus(
	original: string,
	modified: string,
	additions: number,
	deletions: number,
): DiffStatus {
	if (additions === 0 && deletions === 0) return "unchanged";
	if (original.length === 0) return "added";
	if (modified.length === 0) return "deleted";
	return "modified";
}

function contextLine(
	text: string,
	originalLine: number,
	modifiedLine: number,
): DiffLine {
	return { kind: "context", originalLine, modifiedLine, text, slices: [] };
}

/**
 * The word-aligned second pass for one changed line range. A one-sided range is
 * a plain add or delete; a two-sided range is inline-highlighted only when both
 * sides preserve enough non-whitespace to be a genuine replacement rather than
 * an unrelated deletion that happens to sit next to an unrelated addition.
 */
function changeLines(
	range: DiffRange,
	originalLines: readonly string[],
	modifiedLines: readonly string[],
): DiffLine[] {
	const removed = originalLines.slice(range.fromA, range.toA);
	const added = modifiedLines.slice(range.fromB, range.toB);

	let originalSlices: Map<number, LineSlice[]> = new Map();
	let modifiedSlices: Map<number, LineSlice[]> = new Map();

	const inlineEligible =
		removed.length > 0 &&
		added.length > 0 &&
		removed.every((line) => line.length <= MAX_INLINE_LINE_LENGTH) &&
		added.every((line) => line.length <= MAX_INLINE_LINE_LENGTH);

	if (inlineEligible) {
		const removedRegion = removed.join("\n");
		const addedRegion = added.join("\n");
		const spans = diffWords(removedRegion, addedRegion);
		const isReplacement =
			spans !== null &&
			preservedFraction(removedRegion, spans.original) >=
				MIN_REPLACEMENT_PRESERVATION &&
			preservedFraction(addedRegion, spans.modified) >=
				MIN_REPLACEMENT_PRESERVATION;
		if (isReplacement) {
			originalSlices = sliceByLine(removed, spans.original);
			modifiedSlices = sliceByLine(added, spans.modified);
		}
	}

	const lines: DiffLine[] = [];
	removed.forEach((text, index) => {
		lines.push({
			kind: "removed",
			originalLine: range.fromA + index + 1,
			modifiedLine: null,
			text,
			slices: originalSlices.get(index) ?? [],
		});
	});
	added.forEach((text, index) => {
		lines.push({
			kind: "added",
			originalLine: null,
			modifiedLine: range.fromB + index + 1,
			text,
			slices: modifiedSlices.get(index) ?? [],
		});
	});
	return lines;
}

/**
 * Projects region-relative character spans onto per-line column slices, keyed
 * by 0-based line index within the region.
 *
 * A slice covering a whole line is dropped: that line is already rendered as a
 * whole added or removed line, and highlighting it again only adds noise.
 */
function sliceByLine(
	regionLines: readonly string[],
	spans: readonly CharSpan[],
): Map<number, LineSlice[]> {
	const starts: number[] = [];
	let offset = 0;
	for (const line of regionLines) {
		starts.push(offset);
		offset += line.length + 1;
	}

	const byLine = new Map<number, LineSlice[]>();
	for (const span of spans) {
		for (let index = 0; index < regionLines.length; index++) {
			const line = regionLines[index] ?? "";
			const lineFrom = starts[index] ?? 0;
			const lineTo = lineFrom + line.length;
			const from = Math.max(span.from, lineFrom);
			const to = Math.min(span.to, lineTo);
			if (to <= from) continue;
			const slice = {
				startCol: from - lineFrom + 1,
				endCol: to - lineFrom + 1,
			};
			if (slice.startCol === 1 && slice.endCol === line.length + 1) continue;
			const existing = byLine.get(index);
			if (existing) existing.push(slice);
			else byLine.set(index, [slice]);
		}
	}
	return byLine;
}

/**
 * Collapses runs of unchanged lines longer than `2 * contextLines` into hunk
 * boundaries. Two changes closer than that stay in one hunk so the reviewer
 * never has to stitch adjacent edits together.
 */
function groupHunks(
	lines: readonly DiffLine[],
	contextLines: number,
): DiffHunk[] {
	const changedIndexes = lines
		.map((line, index) => (line.kind === "context" ? -1 : index))
		.filter((index) => index >= 0);
	if (changedIndexes.length === 0) return [];

	const hunks: DiffHunk[] = [];
	let from = Math.max(0, (changedIndexes[0] ?? 0) - contextLines);
	let to = Math.min(lines.length, (changedIndexes[0] ?? 0) + contextLines + 1);

	for (const index of changedIndexes.slice(1)) {
		if (index - contextLines <= to) {
			to = Math.min(lines.length, index + contextLines + 1);
			continue;
		}
		hunks.push(toHunk(lines.slice(from, to)));
		from = Math.max(0, index - contextLines);
		to = Math.min(lines.length, index + contextLines + 1);
	}
	hunks.push(toHunk(lines.slice(from, to)));
	return hunks;
}

function toHunk(lines: DiffLine[]): DiffHunk {
	const first = lines[0];
	const originalStart = first?.originalLine ?? 0;
	const modifiedStart = first?.modifiedLine ?? 0;
	return {
		key: `${originalStart}-${modifiedStart}-${lines.length}`,
		originalStart,
		modifiedStart,
		lines,
	};
}

export type CollapsedDiff = {
	hunks: DiffHunk[];
	/** Lines withheld by the collapse; 0 when everything is shown. */
	hiddenLines: number;
};

/**
 * Caps how much of a diff renders before the reviewer asks for the rest. A
 * whole-file rewrite is a legitimate proposal and must not paint thousands of
 * rows into a review card by default.
 */
export function collapseDiff(
	model: DiffModel,
	maxLines: number,
): CollapsedDiff {
	const total = model.hunks.reduce((sum, hunk) => sum + hunk.lines.length, 0);
	if (total <= maxLines) return { hunks: model.hunks, hiddenLines: 0 };

	const hunks: DiffHunk[] = [];
	let budget = maxLines;
	for (const hunk of model.hunks) {
		if (budget <= 0) break;
		if (hunk.lines.length <= budget) {
			hunks.push(hunk);
			budget -= hunk.lines.length;
			continue;
		}
		hunks.push({ ...hunk, lines: hunk.lines.slice(0, budget) });
		budget = 0;
	}
	return { hunks, hiddenLines: total - maxLines };
}
