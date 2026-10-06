import { describe, expect, it } from "vite-plus/test";
import {
	diffTokens,
	diffWords,
	preservedFraction,
	tokenizeWords,
	trimmedRange,
} from "@/lib/diff/diff-core";

/** Applies an edit script to `a` and expects it to reproduce `b` exactly. */
function applyRanges(
	a: readonly string[],
	b: readonly string[],
	ranges: ReturnType<typeof diffTokens>,
): string[] {
	expect(ranges).not.toBeNull();
	const out: string[] = [];
	let cursor = 0;
	for (const range of ranges ?? []) {
		out.push(...a.slice(cursor, range.fromA));
		out.push(...b.slice(range.fromB, range.toB));
		cursor = range.toA;
	}
	out.push(...a.slice(cursor));
	return out;
}

describe("diffTokens", () => {
	it("reports no change for identical input", () => {
		expect(diffTokens(["a", "b"], ["a", "b"])).toEqual([]);
	});

	it("reports a pure insertion as an empty original range", () => {
		expect(diffTokens(["a", "c"], ["a", "b", "c"])).toEqual([
			{ fromA: 1, toA: 1, fromB: 1, toB: 2 },
		]);
	});

	it("reports a pure deletion as an empty modified range", () => {
		expect(diffTokens(["a", "b", "c"], ["a", "c"])).toEqual([
			{ fromA: 1, toA: 2, fromB: 1, toB: 1 },
		]);
	});

	it("keeps changes separated by one unchanged token apart", () => {
		const ranges = diffTokens(["a", "keep", "b"], ["x", "keep", "y"]);
		expect(ranges).toEqual([
			{ fromA: 0, toA: 1, fromB: 0, toB: 1 },
			{ fromA: 2, toA: 3, fromB: 2, toB: 3 },
		]);
	});

	it("produces an edit script that reconstructs the modified side", () => {
		const a = "the quick brown fox jumps over the lazy dog".split(" ");
		const b = "the quick red fox leaps over a lazy dog today".split(" ");
		expect(applyRanges(a, b, diffTokens(a, b))).toEqual(b);
	});

	it("reconstructs the modified side for a full rewrite", () => {
		const a = ["1", "2", "3", "4", "5"];
		const b = ["9", "8", "7"];
		expect(applyRanges(a, b, diffTokens(a, b))).toEqual(b);
	});

	it("handles an empty side", () => {
		expect(diffTokens([], ["a", "b"])).toEqual([
			{ fromA: 0, toA: 0, fromB: 0, toB: 2 },
		]);
		expect(diffTokens(["a", "b"], [])).toEqual([
			{ fromA: 0, toA: 2, fromB: 0, toB: 0 },
		]);
	});

	it("gives up past the scan limit instead of running away", () => {
		const a = Array.from({ length: 200 }, (_, i) => `a${i}`);
		const b = Array.from({ length: 200 }, (_, i) => `b${i}`);
		expect(diffTokens(a, b, 8)).toBeNull();
	});
});

describe("trimmedRange", () => {
	it("covers everything but the common prefix and suffix", () => {
		expect(trimmedRange(["a", "x", "y", "d"], ["a", "z", "d"])).toEqual({
			fromA: 1,
			toA: 3,
			fromB: 1,
			toB: 2,
		});
	});

	it("returns null when the sides are identical", () => {
		expect(trimmedRange(["a"], ["a"])).toBeNull();
	});
});

describe("tokenizeWords", () => {
	it("splits into word, whitespace, and punctuation tokens with offsets", () => {
		expect(tokenizeWords('a: "b"')).toEqual([
			{ text: "a", from: 0 },
			{ text: ":", from: 1 },
			{ text: " ", from: 2 },
			{ text: '"', from: 3 },
			{ text: "b", from: 4 },
			{ text: '"', from: 5 },
		]);
	});
});

describe("diffWords", () => {
	it("returns character spans around the changed word only", () => {
		const spans = diffWords("hello brave world", "hello brand world");
		expect(spans).not.toBeNull();
		expect(spans?.original).toEqual([{ from: 6, to: 11 }]);
		expect(spans?.modified).toEqual([{ from: 6, to: 11 }]);
	});

	it("reports an insertion as a zero-width span on the original side", () => {
		const spans = diffWords("a c", "a b c");
		expect(spans?.original).toEqual([{ from: 2, to: 2 }]);
		expect(spans?.modified).toEqual([{ from: 2, to: 4 }]);
	});
});

describe("preservedFraction", () => {
	it("ignores whitespace when measuring preservation", () => {
		expect(preservedFraction("  ab  ", [{ from: 2, to: 3 }])).toBeCloseTo(0.5);
	});

	it("treats an all-whitespace string as fully preserved", () => {
		expect(preservedFraction("   ", [{ from: 0, to: 3 }])).toBe(1);
	});
});
