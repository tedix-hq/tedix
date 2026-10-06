import { describe, expect, test } from "bun:test";
import { composerViewport } from "./composer-viewport";

const lines = (view: ReturnType<typeof composerViewport>) =>
	view.rows.map((row) => row.map((cell) => cell.text).join(""));

describe("composer viewport", () => {
	test("bounds long drafts while keeping the end cursor visible", () => {
		const view = composerViewport("one\ntwo\nthree\nfour\nfive", 23, 20, 2);
		expect(lines(view)).toEqual(["four", "five "]);
		expect(view.totalRows).toBe(5);
		expect(view.startRow).toBe(3);
	});
	test("scrolls back to the cursor without dropping the underlying draft", () => {
		const view = composerViewport("one\ntwo\nthree\nfour\nfive", 1, 20, 2);
		expect(lines(view)).toEqual(["one", "two"]);
		expect(view.startRow).toBe(0);
	});
	test("wraps CJK and emoji by terminal columns and keeps clusters intact", () => {
		const view = composerViewport("界👨‍👩‍👧‍👦é🇫🇮", 4, 4, 4);
		expect(lines(view)).toEqual(["界👨‍👩‍👧‍👦", "é🇫🇮 "]);
	});
	test("resizing recalculates cursor row and bounded wrapping", () => {
		expect(lines(composerViewport("abcdefgh", 8, 4, 2))).toEqual(["efgh", " "]);
		expect(lines(composerViewport("abcdefgh", 8, 8, 2))).toEqual([
			"abcdefgh",
			" ",
		]);
		expect(lines(composerViewport("abcdefgh", 0, 4, 2))).toEqual([
			"abcd",
			"efgh",
		]);
	});
	test("explicit newline after a full row does not create an extra wrapped row", () => {
		expect(lines(composerViewport("abcd\ne", 6, 4, 4))).toEqual(["abcd", "e "]);
	});
	test("a newline cursor remains visible and the row limit is at least one", () => {
		const view = composerViewport("a\nb", 1, 5, 0);
		expect(lines(view)).toEqual(["a "]);
	});
});

test("tabs expand at Ink's eight-column logical stops before wrapping", () => {
	const view = composerViewport("a\tb\n界\tc", 7, 4, 2);
	expect(lines(view)).toEqual(["    ", "c "]);
	expect(view.totalRows).toBe(6);
	expect(lines(composerViewport("a\tb", 3, 4, 1))).toEqual(["b "]);
});

test("one-column viewport keeps wide and zero-width grapheme cursors visible", () => {
	for (const cluster of ["界", "👨‍👩‍👧‍👦", "\u0301", "\u200d"]) {
		const atCluster = composerViewport(cluster, 0, 1, 1);
		expect(atCluster.rows[0]![0]!.offset).toBe(0);
		expect(Bun.stringWidth(lines(atCluster)[0]!)).toBe(1);
		const atEnd = composerViewport(cluster, 1, 1, 1);
		expect(lines(atEnd)).toEqual([" "]);
		expect(atEnd.rows[0]![0]!.offset).toBe(1);
	}
});

test("cursor boundary positions share the viewport's tab and glyph column geometry", () => {
	const view = composerViewport("界\tx\nab", 7, 20, 1);
	expect(view.positions).toEqual([
		{ offset: 0, row: 0, column: 0 },
		{ offset: 1, row: 0, column: 2 },
		{ offset: 2, row: 0, column: 8 },
		{ offset: 3, row: 0, column: 9 },
		{ offset: 4, row: 1, column: 0 },
		{ offset: 5, row: 1, column: 1 },
		{ offset: 6, row: 1, column: 2 },
	]);
	expect(view.cursorRow).toBe(1);
});
