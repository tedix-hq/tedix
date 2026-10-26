import { describe, expect, it } from "vite-plus/test";
import {
	mergeAppText,
	mergeAppFiles,
	hasAppConflictMarkers,
} from "./app-draft-merge";

describe("app three-way merge", () => {
	it.each([
		["base", "draft", "base", "draft"],
		["base", "base", "main", "main"],
		["base", "same", "same", "same"],
		[undefined, "added", undefined, "added"],
		["old", undefined, "old", undefined],
		["old", "old", undefined, undefined],
		["a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n", "A\nb\nC\n"],
		["a\nb\nc", "a\nx\nb\nc", "a\nb\nc\ny", "a\nx\nb\nc\ny"],
		["a\r\nb\r\nc", "A\r\nb\r\nc", "a\r\nb\r\nC", "A\r\nb\r\nC"],
	])("merges %j, %j and %j", (base, draft, main, expected) => {
		expect(mergeAppText(base, draft, main)).toEqual({
			text: expected,
			conflict: false,
		});
	});
	it.each([
		["base", "draft", "main"],
		[undefined, "draft addition", "main addition"],
		["base", undefined, "main edit"],
		["base", "draft edit", undefined],
		["a\nb", "x\na\nb", "y\na\nb"],
	])("preserves both sides of a conflict", (base, draft, main) => {
		const result = mergeAppText(base, draft, main);
		expect(result.conflict).toBe(true);
		expect(hasAppConflictMarkers(result.text!)).toBe(true);
		expect(result.text).toContain(draft ?? "(file deleted)");
		expect(result.text).toContain(main ?? "(file deleted)");
	});
	it("preserves additions and deletions across files", () => {
		expect(
			mergeAppFiles(
				{ a: "a", b: "b" },
				{ b: "B", c: "new" },
				{ a: "a", b: "b", d: "main" },
			),
		).toEqual({ files: { b: "B", c: "new", d: "main" }, conflicts: [] });
	});
	it("bounds a large rewrite and keeps the full contents in a conflict", () => {
		const base = "b\n".repeat(1100),
			draft = "d\n".repeat(1100),
			main = "m\n".repeat(1100);
		const result = mergeAppText(base, draft, main);
		expect(result.conflict).toBe(true);
		expect(result.text).toContain(draft);
		expect(result.text).toContain(main);
	});
});
