import { describe, expect, it } from "vite-plus/test";
import { addedWordRanges } from "./word-diff";

const added = (before: string, after: string) =>
	addedWordRanges(before, after).map(([start, end]) => after.slice(start, end));

describe("added words", () => {
	it("finds words added in the middle and at the end, merging neighbours", () => {
		expect(added("Plan the launch", "Plan the big product launch now")).toEqual(
			["big product", "now"],
		);
	});
	it("ignores whitespace and removed words", () => {
		expect(added("one two  three", "one   three")).toEqual([]);
	});
	it("treats replaced words as added", () => {
		expect(added("Revenue grew", "Revenue fell")).toEqual(["fell"]);
	});
	it("lights all new text when there was none", () => {
		expect(added("", "Fresh text")).toEqual(["Fresh text"]);
	});
});
