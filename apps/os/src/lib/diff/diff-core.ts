/**
 * The diff primitive: a greedy Myers (O(ND)) diff over token arrays, plus the
 * word tokenizer the inline pass runs on.
 *
 * This read-only review surface needs diff ranges and word tokenization without
 * the full MergeView dependency. `@codemirror/merge` provides `diff` and
 * `presentableDiff`, but is not in this workspace.
 * (`@codemirror/state` IS a dependency now — Canvas's editor is CodeMirror 6 —
 * but it does not export these; they live in `@codemirror/merge`.)
 *
 * The search is bounded by a scan limit like MergeView's own default is: past
 * it the caller gets `null` and falls back to a prefix/suffix-trimmed range,
 * which is a coarse but always-correct answer. A quadratic diff must never be
 * the thing that freezes a review surface.
 */

/** A changed span, as half-open token index ranges on each side. */
export type DiffRange = {
	/** 0-based token index into the original side; `[fromA, toA)`. */
	fromA: number;
	toA: number;
	/** 0-based token index into the modified side; `[fromB, toB)`. */
	fromB: number;
	toB: number;
};

/** A changed span, as a half-open character range within one side's string. */
export type CharSpan = { from: number; to: number };

/** Maximum edit-script length searched before giving up. Mirrors MergeView. */
export const DEFAULT_SCAN_LIMIT = 500;

/**
 * Changed token ranges between `a` and `b`, in ascending order, with at most
 * one side empty per range. Returns `null` when the edit script is longer than
 * `scanLimit` — the inputs are too dissimilar to diff cheaply.
 */
export function diffTokens(
	a: readonly string[],
	b: readonly string[],
	scanLimit: number = DEFAULT_SCAN_LIMIT,
): DiffRange[] | null {
	const maxCommon = Math.min(a.length, b.length);
	let prefix = 0;
	while (prefix < maxCommon && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < maxCommon - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix++;
	}

	const coreA = a.slice(prefix, a.length - suffix);
	const coreB = b.slice(prefix, b.length - suffix);
	if (coreA.length === 0 && coreB.length === 0) return [];
	// A one-sided core is already the answer: a pure insertion or deletion.
	if (coreA.length === 0 || coreB.length === 0) {
		return [
			{
				fromA: prefix,
				toA: prefix + coreA.length,
				fromB: prefix,
				toB: prefix + coreB.length,
			},
		];
	}

	const script = myers(coreA, coreB, scanLimit);
	if (script === null) return null;
	return script.map((range) => ({
		fromA: range.fromA + prefix,
		toA: range.toA + prefix,
		fromB: range.fromB + prefix,
		toB: range.toB + prefix,
	}));
}

/** The coarse fallback when {@link diffTokens} gives up: one trimmed range. */
export function trimmedRange(
	a: readonly string[],
	b: readonly string[],
): DiffRange | null {
	const maxCommon = Math.min(a.length, b.length);
	let prefix = 0;
	while (prefix < maxCommon && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < maxCommon - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix++;
	}
	const range = {
		fromA: prefix,
		toA: a.length - suffix,
		fromB: prefix,
		toB: b.length - suffix,
	};
	return range.toA > range.fromA || range.toB > range.fromB ? range : null;
}

/**
 * Word-granularity character spans changed between two strings.
 *
 * Word granularity is what makes the inline highlights readable and what makes
 * the replacement heuristic in `diff-model` honest: a character-minimal diff
 * highlights the individual letters two unrelated sentences happen to share,
 * and counting those letters as "preserved" pairs lines that should have
 * rendered as a plain deletion followed by a plain addition.
 */
export function diffWords(
	a: string,
	b: string,
	scanLimit: number = DEFAULT_SCAN_LIMIT,
): { original: CharSpan[]; modified: CharSpan[] } | null {
	const tokensA = tokenizeWords(a);
	const tokensB = tokenizeWords(b);
	const ranges = diffTokens(
		tokensA.map((token) => token.text),
		tokensB.map((token) => token.text),
		scanLimit,
	);
	if (ranges === null) return null;

	const original: CharSpan[] = [];
	const modified: CharSpan[] = [];
	for (const range of ranges) {
		original.push({
			from: spanStart(tokensA, range.fromA, a.length),
			to: spanStart(tokensA, range.toA, a.length),
		});
		modified.push({
			from: spanStart(tokensB, range.fromB, b.length),
			to: spanStart(tokensB, range.toB, b.length),
		});
	}
	return { original, modified };
}

type WordToken = { text: string; from: number };

/**
 * Splits into word runs, whitespace runs, and single punctuation characters.
 * Whitespace is a token rather than a separator so offsets stay exact and a
 * pure indentation change is still a real, visible change.
 */
export function tokenizeWords(text: string): WordToken[] {
	const tokens: WordToken[] = [];
	const pattern = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;
	for (const match of text.matchAll(pattern)) {
		tokens.push({ text: match[0], from: match.index });
	}
	return tokens;
}

function spanStart(
	tokens: readonly WordToken[],
	index: number,
	fallback: number,
): number {
	const token = tokens[index];
	return token === undefined ? fallback : token.from;
}

/** Fraction of `text`'s non-whitespace characters left untouched by `spans`. */
export function preservedFraction(
	text: string,
	spans: readonly CharSpan[],
): number {
	const total = countNonWhitespace(text, 0, text.length);
	if (total === 0) return 1;
	let changed = 0;
	for (const span of spans)
		changed += countNonWhitespace(text, span.from, span.to);
	return Math.max(0, total - changed) / total;
}

function countNonWhitespace(text: string, start: number, end: number): number {
	let count = 0;
	const lo = Math.max(0, start);
	const hi = Math.min(text.length, end);
	for (let i = lo; i < hi; i++) {
		const code = text.charCodeAt(i);
		// Space, tab, LF, CR, VT, FF — cheaper than a regex in the inner loop.
		if (
			code !== 32 &&
			code !== 9 &&
			code !== 10 &&
			code !== 13 &&
			code !== 11 &&
			code !== 12
		) {
			count++;
		}
	}
	return count;
}

type EditOp = "keep" | "delete" | "insert";

/**
 * Reads one furthest-reaching x from the k-band. Every in-band slot is
 * zero-initialised, so an out-of-band read is 0 — the same value the band would
 * have held — and the strict index signature stays honest.
 */
function readBand(band: Int32Array, index: number): number {
	return band[index] ?? 0;
}

/**
 * Greedy forward Myers with a stored trace, then a backtrack that reconstructs
 * the edit script. Both sides here are already prefix/suffix-trimmed, so `d`
 * is the real edit distance and the trace stays small on realistic inputs.
 */
function myers(
	a: readonly string[],
	b: readonly string[],
	scanLimit: number,
): DiffRange[] | null {
	const n = a.length;
	const m = b.length;
	const max = Math.min(n + m, Math.max(1, scanLimit));
	const offset = max;
	const v = new Int32Array(2 * max + 1);
	const trace: Int32Array[] = [];

	for (let d = 0; d <= max; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			// `k === d` always takes the else branch, so `offset + k + 1` is only
			// read for `k < d` and stays inside the array.
			const x =
				k === -d ||
				(k !== d && readBand(v, offset + k - 1) < readBand(v, offset + k + 1))
					? readBand(v, offset + k + 1)
					: readBand(v, offset + k - 1) + 1;
			let ax = x;
			let by = x - k;
			while (ax < n && by < m && a[ax] === b[by]) {
				ax++;
				by++;
			}
			v[offset + k] = ax;
			if (ax >= n && by >= m) return backtrack(trace, d, offset, n, m);
		}
	}
	return null;
}

function backtrack(
	trace: readonly Int32Array[],
	depth: number,
	offset: number,
	n: number,
	m: number,
): DiffRange[] {
	const reversed: EditOp[] = [];
	let x = n;
	let y = m;

	// `trace[d]` is the search state ENTERING round `d`, which is exactly the
	// state round `d` made its decision from — so the branch below reproduces
	// the forward pass's choice and walks one edit back per round.
	for (let d = depth; d > 0; d--) {
		const v = trace[d];
		if (v === undefined) break;
		const k = x - y;
		const previousK =
			k === -d ||
			(k !== d && readBand(v, offset + k - 1) < readBand(v, offset + k + 1))
				? k + 1
				: k - 1;
		const previousX = readBand(v, offset + previousK);
		const previousY = previousX - previousK;
		while (x > previousX && y > previousY) {
			x--;
			y--;
			reversed.push("keep");
		}
		reversed.push(x > previousX ? "delete" : "insert");
		x = previousX;
		y = previousY;
	}
	while (x > 0 && y > 0) {
		x--;
		y--;
		reversed.push("keep");
	}

	return coalesce(reversed.reverse());
}

function coalesce(ops: readonly EditOp[]): DiffRange[] {
	const ranges: DiffRange[] = [];
	let ai = 0;
	let bi = 0;
	let open: DiffRange | null = null;
	for (const op of ops) {
		if (op === "keep") {
			if (open) {
				ranges.push(open);
				open = null;
			}
			ai++;
			bi++;
			continue;
		}
		open ??= { fromA: ai, toA: ai, fromB: bi, toB: bi };
		if (op === "delete") open.toA = ++ai;
		else open.toB = ++bi;
	}
	if (open) ranges.push(open);
	return ranges;
}
