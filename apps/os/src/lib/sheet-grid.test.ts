import type { OsWorkbookSheet } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import {
	boundsToTsv,
	functionGroups,
	hasUncomputedCells,
	isErrorValue,
	jumpToDataEdge,
	moveWithinSelection,
	parseClipboardTable,
	parseRangeLabel,
	presenceToSheetSelection,
	rangeLabel,
	selectionStats,
	sheetSelectionToPresence,
	viewRowOrder,
} from "./sheet-grid";

function valuesSheet(
	values: (string | number | null)[][],
	frozenRows = 0,
): OsWorkbookSheet {
	return {
		id: "v",
		name: "Values",
		columns: values[0]!.map((_, index) => ({
			id: `v${index}`,
			label: String(index),
			width: 100,
		})),
		rows: values.map((row) =>
			row.map((value) => ({
				input: value === null ? "" : String(value),
				value,
			})),
		),
		frozenRows,
		frozenColumns: 0,
	};
}

describe("sheet read helpers", () => {
	it("recognises computed errors and nothing else", () => {
		for (const error of ["#DIV/0!", "#REF!", "#CYCLE!", "#NAME?", "#N/A!"])
			expect(isErrorValue(error), error).toBe(true);
		for (const plain of ["#1 seller", "#", "Total", 3, null])
			expect(isErrorValue(plain), String(plain)).toBe(false);
	});

	it("counts non-empty cells and does maths over numbers only", () => {
		const sheet = valuesSheet([
			["Week", "Revenue"],
			["W1", 10],
			["W2", 30],
			["W3", null],
		]);
		expect(
			selectionStats(sheet, {
				rowStart: 0,
				rowEnd: 3,
				columnStart: 0,
				columnEnd: 1,
			}),
		).toEqual({ count: 7, numbers: 2, sum: 40, average: 20, min: 10, max: 30 });
		expect(
			selectionStats(sheet, {
				rowStart: 3,
				rowEnd: 3,
				columnStart: 1,
				columnEnd: 1,
			}).average,
		).toBeNull();
	});

	it("finds inputs whose value was never computed", () => {
		expect(hasUncomputedCells([valuesSheet([["a", 1]])])).toBe(false);
		expect(
			hasUncomputedCells([
				{ rows: [[{ input: "=SUM(1,2)", value: null }, null]] },
			]),
		).toBe(true);
		expect(hasUncomputedCells([{ rows: [[{ input: "", value: null }]] }])).toBe(
			false,
		);
	});

	it("sorts and filters a view, keeping frozen rows on top and blanks last", () => {
		const sheet = valuesSheet(
			[
				["Name", "Score"],
				["Bea", 7],
				["Al", null],
				["Cy", 12],
				["Di", 2],
			],
			1,
		);
		const display = (row: number, column: number) =>
			String(sheet.rows[row]?.[column]?.value ?? "");
		expect(
			viewRowOrder(sheet, {
				sort: { column: 1, direction: "ascending" },
				display,
			}),
		).toEqual([0, 4, 1, 3, 2]);
		expect(
			viewRowOrder(sheet, {
				sort: { column: 1, direction: "descending" },
				display,
			}),
		).toEqual([0, 3, 1, 4, 2]);
		expect(viewRowOrder(sheet, { query: "  b ", display })).toEqual([0, 1]);
		expect(viewRowOrder(sheet, { display })).toEqual([0, 1, 2, 3, 4]);
	});
});

function sheetOf(inputs: string[][]): OsWorkbookSheet {
	return {
		id: "s1",
		name: "Sheet1",
		columns: inputs[0]!.map((_, index) => ({
			id: `c${index}`,
			label: String(index),
			width: 100,
		})),
		rows: inputs.map((row) =>
			row.map((input) => ({
				input,
				value: input.startsWith("=") ? 42 : input === "" ? null : input,
			})),
		),
		frozenRows: 0,
		frozenColumns: 0,
	};
}

describe("sheet grid", () => {
	it("parses and labels A1 references and ranges", () => {
		expect(parseRangeLabel("b2", 10, 10)).toEqual({
			anchor: { row: 1, column: 1 },
			focus: { row: 1, column: 1 },
		});
		expect(parseRangeLabel("A1:C5", 10, 10)?.focus).toEqual({
			row: 4,
			column: 2,
		});
		expect(parseRangeLabel("Z99", 10, 10)).toBeNull();
		expect(parseRangeLabel("A1:B2:C3", 10, 10)).toBeNull();
		expect(parseRangeLabel("nonsense", 10, 10)).toBeNull();
		expect(
			rangeLabel({
				anchor: { row: 4, column: 2 },
				focus: { row: 0, column: 0 },
			}),
		).toBe("A1:C5");
		expect(
			rangeLabel({
				anchor: { row: 0, column: 27 },
				focus: { row: 0, column: 27 },
			}),
		).toBe("AB1");
	});

	it("jumps to the edge of a data run or the next filled cell", () => {
		const sheet = sheetOf([["a"], ["b"], ["c"], [""], [""], ["d"], [""]]);
		const down = { row: 1, column: 0 };
		expect(jumpToDataEdge(sheet, { row: 0, column: 0 }, down).row).toBe(2);
		expect(jumpToDataEdge(sheet, { row: 2, column: 0 }, down).row).toBe(5);
		expect(jumpToDataEdge(sheet, { row: 5, column: 0 }, down).row).toBe(6);
		expect(jumpToDataEdge(sheet, { row: 6, column: 0 }, down).row).toBe(6);
	});

	it("walks inside a multi-cell selection and wraps", () => {
		const selection = {
			anchor: { row: 0, column: 0 },
			focus: { row: 0, column: 1 },
		};
		const wrapped = moveWithinSelection(
			{ ...selection, focus: { row: 0, column: 1 } },
			1,
			"column",
		);
		expect(wrapped.focus).toEqual({ row: 0, column: 0 });
		expect(wrapped.anchor).toEqual(selection.anchor);
	});

	it("copies computed values as TSV with quoted multi-line fields", () => {
		const sheet = sheetOf([
			["a", "=1+1"],
			["two\nlines", ""],
		]);
		expect(
			boundsToTsv(sheet, {
				rowStart: 0,
				rowEnd: 1,
				columnStart: 0,
				columnEnd: 1,
			}),
		).toBe('a\t42\n"two\nlines"\t');
	});

	it("reads Excel/Sheets TSV, consistent CSV, and leaves prose in one cell", () => {
		expect(parseClipboardTable("a\tb\r\nc\td\r\n")).toEqual([
			["a", "b"],
			["c", "d"],
		]);
		expect(parseClipboardTable('"x\ny"\tz')).toEqual([["x\ny", "z"]]);
		expect(parseClipboardTable('a,"b,c"\nd,e')).toEqual([
			["a", "b,c"],
			["d", "e"],
		]);
		expect(parseClipboardTable("Hello, world")).toEqual([["Hello, world"]]);
		expect(parseClipboardTable("one\ntwo")).toEqual([["one"], ["two"]]);
	});

	it("round-trips a cell range through a collab selection", () => {
		const selection = {
			anchor: { row: 999, column: 63 },
			focus: { row: 2, column: 0 },
		};
		const encoded = sheetSelectionToPresence("s1", selection);
		expect(encoded.path).toBe("sheet:s1");
		expect(presenceToSheetSelection(encoded, "s1")).toEqual(selection);
		expect(presenceToSheetSelection(encoded, "s2")).toBeNull();
		expect(
			presenceToSheetSelection({ path: "doc.json", anchor: 1, head: 1 }, "s1"),
		).toBeNull();
	});

	it("offers only functions the engine evaluates", () => {
		const groups = functionGroups(["SUM", "IF", "VLOOKUP"]);
		expect(groups.map((group) => group.name)).toEqual([
			"Math",
			"Logical",
			"Lookup",
		]);
		expect(groups[0]?.functions).toEqual(["SUM"]);
	});
});
