import { describe, expect, it } from "vite-plus/test";
import { lineSegments } from "@/lib/diff/diff-segments";

describe("lineSegments", () => {
	it("returns the whole line unchanged when there are no slices", () => {
		expect(lineSegments("abc", [])).toEqual([{ text: "abc", changed: false }]);
	});

	it("splits around a slice in the middle", () => {
		expect(lineSegments("abcdef", [{ startCol: 3, endCol: 5 }])).toEqual([
			{ text: "ab", changed: false },
			{ text: "cd", changed: true },
			{ text: "ef", changed: false },
		]);
	});

	it("handles a slice at each end", () => {
		expect(
			lineSegments("abcdef", [
				{ startCol: 1, endCol: 2 },
				{ startCol: 6, endCol: 7 },
			]),
		).toEqual([
			{ text: "a", changed: true },
			{ text: "bcde", changed: false },
			{ text: "f", changed: true },
		]);
	});

	it("merges overlapping and out-of-order slices", () => {
		expect(
			lineSegments("abcdef", [
				{ startCol: 4, endCol: 6 },
				{ startCol: 2, endCol: 5 },
			]),
		).toEqual([
			{ text: "a", changed: false },
			{ text: "bcde", changed: true },
			{ text: "f", changed: false },
		]);
	});

	it("drops a zero-width slice rather than emitting an empty segment", () => {
		expect(lineSegments("abc", [{ startCol: 2, endCol: 2 }])).toEqual([
			{ text: "a", changed: false },
			{ text: "bc", changed: false },
		]);
	});

	it("reassembles into the original text", () => {
		const text = '  "title": "new name",';
		const segments = lineSegments(text, [
			{ startCol: 13, endCol: 16 },
			{ startCol: 3, endCol: 8 },
		]);
		expect(segments.map((segment) => segment.text).join("")).toBe(text);
	});
});
