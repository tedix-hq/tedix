import type { OsWorkbookSheet } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import {
	boundsToTsv,
	functionGroups,
	jumpToDataEdge,
	moveWithinSelection,
	parseClipboardTable,
	parseRangeLabel,
	presenceToSheetSelection,
	rangeLabel,
	sheetSelectionToPresence,
} from "./sheet-grid";

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
