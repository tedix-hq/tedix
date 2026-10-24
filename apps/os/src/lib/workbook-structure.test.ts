import { describe, expect, it } from "vite-plus/test";
import {
	OsWorkbookSheetSchema,
	type OsWorkbook,
	type OsWorkbookSheet,
} from "@tedix/api-contract/schemas/os-workspaces";
import {
	autoSum,
	deleteColumns,
	deleteRows,
	deleteSheet,
	duplicateSheet,
	fillRange,
	freezePanes,
	frozenCellStyle,
	HEADER_HEIGHT,
	insertColumns,
	insertRows,
	offsetFormula,
	renameSheet,
	resizeColumn,
	resizeRow,
	sortRange,
} from "./workbook-structure";
import { evaluateWorkbook } from "./workbook-formulas";

function book(
	inputs = [
		["Label", "Value", "Other"],
		["b", "2", "20"],
		["a", "1", "10"],
		["", "", ""],
		["c", "3", "30"],
	],
): OsWorkbook {
	const sheet: OsWorkbookSheet = {
		id: "data",
		name: "Data",
		columns: ["A", "B", "C"].map((label) => ({ id: label, label, width: 120 })),
		rows: inputs.map((row) => row.map((input) => ({ input, value: null }))),
		frozenRows: 0,
		frozenColumns: 0,
	};
	return evaluateWorkbook({
		activeSheetId: sheet.id,
		sheets: [
			sheet,
			{ ...structuredClone(sheet), id: "other", name: "Other Sheet" },
		],
	});
}
const input = (value: OsWorkbook, row: number, col = 0, sheet = 0) =>
	value.sheets[sheet]?.rows[row]?.[col]?.input;
const range = { rowStart: 0, rowEnd: 4, columnStart: 0, columnEnd: 1 };

describe("workbook structure", () => {
	it("inserts rows and columns without mutating the source", () => {
		const value = book();
		const snapshot = structuredClone(value);
		const rows = insertRows(value, "data", 1, 2);
		expect(rows.sheets[0]!.rows).toHaveLength(7);
		expect(input(rows, 3)).toBe("b");
		const cols = insertColumns(value, "data", 1, 2);
		expect(cols.sheets[0]!.columns).toHaveLength(5);
		expect(input(cols, 1, 3)).toBe("2");
		expect(new Set(cols.sheets[0]!.columns.map((col) => col.id)).size).toBe(5);
		expect(value).toEqual(snapshot);
	});
	it("shifts absolute and relative refs and grows ranges while preserving strings and functions", () => {
		const value = book([
			[`=SUM($A$1:A4)+A2+LOG10(100)+IF(A1="A2",1,0)`, "", ""],
		]);
		const next = insertRows(value, "data", 0);
		expect(input(next, 1)).toBe(`=SUM($A$2:A5)+A3+LOG10(100)+IF(A2="A2",1,0)`);
		expect(input(insertColumns(value, "data", 0), 0, 1)).toContain("$B$1:B4");
	});
	it("rewrites explicit references in other sheets, leaving their local references alone", () => {
		const value = book();
		value.sheets[1]!.rows[0]![0] = {
			input: "=Data!A2+SUM(Data!$B$1:B4)+A2",
			value: null,
		};
		expect(input(insertRows(value, "data", 1), 0, 0, 1)).toBe(
			"=Data!A3+SUM(Data!$B$1:B5)+A2",
		);
	});
	it("invalidates deleted cells and fully deleted ranges, shrinking partial overlaps", () => {
		const value = book();
		value.sheets[1]!.rows[0]![0] = {
			input: "=Data!A2+SUM(Data!A1:A5)+SUM(Data!A2:A3)+SUM(Data!A3:A5)",
			value: null,
		};
		expect(input(deleteRows(value, "data", 1, 2), 0, 0, 1)).toBe(
			"=#REF!+SUM(Data!A1:A3)+SUM(#REF!)+SUM(Data!A2:A3)",
		);
		value.sheets[1]!.rows[0]![0]!.input = "=Data!B2+SUM(Data!A1:C5)";
		expect(input(deleteColumns(value, "data", 1), 0, 0, 1)).toBe(
			"=#REF!+SUM(Data!A1:B5)",
		);
	});
	it("handles range boundary deletions and reversed ranges", () => {
		const value = book();
		value.sheets[1]!.rows[0]![0]!.input = "=SUM(Data!A2:A4)+SUM(Data!A4:A2)";
		expect(input(deleteRows(value, "data", 1), 0, 0, 1)).toBe(
			"=SUM(Data!A2:A3)+SUM(Data!A3:A2)",
		);
		expect(input(deleteRows(value, "data", 3), 0, 0, 1)).toBe(
			"=SUM(Data!A2:A3)+SUM(Data!A3:A2)",
		);
	});
	it("enforces schema capacities and preserves at least one row and column", () => {
		const value = book();
		expect(deleteRows(value, "data", 0, 5)).toBe(value);
		expect(deleteColumns(value, "data", 0, 3)).toBe(value);
		expect(insertRows(value, "data", 0, 1000)).toBe(value);
		expect(insertColumns(value, "data", 0, 64)).toBe(value);
		expect(deleteRows(value, "data", 1, 2).sheets[0]!.rows).toHaveLength(3);
	});
	it("moves row heights and frozen boundaries with structural changes", () => {
		const value = freezePanes(resizeRow(book(), "data", 1, 60), "data", 3, 2);
		const next = insertRows(value, "data", 1);
		expect(next.sheets[0]!.rowHeights).toEqual([28, 28, 60, 28, 28, 28]);
		expect(next.sheets[0]!.frozenRows).toBe(4);
		const removed = deleteRows(next, "data", 1, 2);
		expect(removed.sheets[0]!.rowHeights).toEqual([28, 28, 28, 28]);
		expect(removed.sheets[0]!.frozenRows).toBe(2);
		expect(deleteColumns(value, "data", 0).sheets[0]!.frozenColumns).toBe(1);
	});
	it("validates optional row heights and clamps resize dimensions", () => {
		expect(
			OsWorkbookSheetSchema.parse(book().sheets[0]).rowHeights,
		).toBeUndefined();
		expect(
			OsWorkbookSheetSchema.safeParse({ ...book().sheets[0], rowHeights: [19] })
				.success,
		).toBe(false);
		expect(resizeRow(book(), "data", 0, 900).sheets[0]!.rowHeights?.[0]).toBe(
			600,
		);
		expect(
			resizeColumn(book(), "data", 0, 1).sheets[0]!.columns[0]!.width,
		).toBe(48);
	});
	it.each(["ascending", "descending"] as const)(
		"sorts just the selection %s, preserving header and keeping empty rows last",
		(direction) => {
			const value = book();
			const next = sortRange(value, "data", range, 1, direction, true);
			expect(input(next, 0)).toBe("Label");
			expect(next.sheets[0]!.rows.slice(1).map((row) => row[0]?.input)).toEqual(
				direction === "ascending" ? ["a", "b", "c", ""] : ["c", "b", "a", ""],
			);
			expect(next.sheets[0]!.rows.map((row) => row[2])).toEqual(
				value.sheets[0]!.rows.map((row) => row[2]),
			);
		},
	);
	it("can sort data from the first row when labels are column metadata", () => {
		expect(
			input(
				sortRange(
					book(),
					"data",
					{ ...range, rowStart: 1, rowEnd: 2 },
					1,
					"ascending",
				),
				1,
			),
		).toBe("a");
	});
	it("AutoSum scans only contiguous numbers above or left, skipping headers", () => {
		const value = book([
			["Header", "", ""],
			["2", "", ""],
			["3", "", ""],
			["", "", ""],
		]);
		expect(
			input(
				autoSum(value, "data", {
					rowStart: 3,
					rowEnd: 3,
					columnStart: 0,
					columnEnd: 0,
				}),
				3,
			),
		).toBe("=SUM(A2:A3)");
		const horizontal = book([
			["Header", "2", "3"],
			["", "", ""],
		]);
		expect(
			input(
				autoSum(horizontal, "data", {
					rowStart: 0,
					rowEnd: 0,
					columnStart: 2,
					columnEnd: 2,
				}),
				0,
				2,
			),
		).toBe("=SUM(B1:B1)");
		expect(
			input(
				autoSum(value, "data", {
					rowStart: 0,
					rowEnd: 0,
					columnStart: 0,
					columnEnd: 0,
				}),
				0,
			),
		).toBe("Header");
	});
	it("AutoSum totals every selected column below the range and extends the grid", () => {
		const next = evaluateWorkbook(
			autoSum(book(), "data", { ...range, columnStart: 1, columnEnd: 2 }),
		);
		expect(input(next, 5, 1)).toBe("=SUM(B2:B5)");
		expect(input(next, 5, 2)).toBe("=SUM(C2:C5)");
		expect(next.sheets[0]!.rows[5]![1]!.value).toBe(6);
	});
	it("duplicates an inactive tab deeply, with unique names, and renames any tab and formula links", () => {
		const value = book();
		const next = duplicateSheet(value, "other", "copy");
		expect(next.activeSheetId).toBe("copy");
		expect(next.sheets[2]!.name).toBe("Other Sheet copy");
		expect(next.sheets[2]!.rows).not.toBe(value.sheets[1]!.rows);
		next.sheets[0]!.rows[0]![0]!.input = `='Other Sheet'!A1+"Other Sheet!A1"`;
		expect(input(renameSheet(next, "other", "Prior's"), 0)).toBe(
			`='Prior''s'!A1+"Other Sheet!A1"`,
		);
		expect(duplicateSheet(next, "other", "copy2").sheets[2]!.name).toBe(
			"Other Sheet copy 2",
		);
	});
	it("deletes any tab and invalidates its explicit links, preserving the active tab", () => {
		const value = book();
		value.sheets[0]!.rows[0]![0]!.input = "='Other Sheet'!A1";
		const next = deleteSheet(value, "other");
		expect(next.activeSheetId).toBe("data");
		expect(input(next, 0)).toBe("=#REF!");
		expect(deleteSheet(next, "data")).toBe(next);
		expect(deleteSheet(value, "data").activeSheetId).toBe("other");
	});
	it("computes frozen offsets using row heights and column widths, and unfreezes", () => {
		const next = freezePanes(
			resizeRow(resizeColumn(book(), "data", 0, 80), "data", 0, 40),
			"data",
			2,
			2,
		);
		expect(frozenCellStyle(next.sheets[0]!, 1, 1)).toEqual({
			position: "sticky",
			top: HEADER_HEIGHT + 40,
			left: 124,
			zIndex: 4,
		});
		expect(frozenCellStyle(next.sheets[0]!, 4, 2)).toEqual({});
		expect(
			frozenCellStyle(freezePanes(next, "data", 0, 0).sheets[0]!, 0, 0),
		).toEqual({});
	});
});

describe("table sort expansion", () => {
	it.each([false, true])(
		"expands a single column or cell, preserving the header: %s",
		(hasHeader) => {
			const value = book([
				...(hasHeader ? [["Label", "Value", "Other"]] : []),
				["b", "2", "20"],
				["a", "1", "10"],
				["", "", ""],
				["separate", "9", "90"],
			]);
			const next = sortRange(
				value,
				"data",
				{
					rowStart: 0,
					rowEnd: hasHeader ? 2 : 0,
					columnStart: 1,
					columnEnd: 1,
				},
				1,
				"ascending",
				hasHeader,
			);
			expect(
				next.sheets[0]!.rows.slice(hasHeader ? 1 : 0, hasHeader ? 3 : 2).map(
					(row) => row.map((cell) => cell?.input),
				),
			).toEqual([
				["a", "1", "10"],
				["b", "2", "20"],
			]);
			expect(next.sheets[0]!.rows.at(-1)).toEqual(value.sheets[0]!.rows.at(-1));
		},
	);

	it("stops expansion at an empty column and leaves an empty cell alone", () => {
		const value = book([
			["b", "", "10"],
			["a", "", "20"],
		]);
		const next = sortRange(
			value,
			"data",
			{ rowStart: 0, rowEnd: 0, columnStart: 0, columnEnd: 0 },
			0,
			"ascending",
		);
		expect(next.sheets[0]!.rows.map((row) => row[0]?.input)).toEqual([
			"a",
			"b",
		]);
		expect(next.sheets[0]!.rows.map((row) => row[2]?.input)).toEqual([
			"10",
			"20",
		]);
		expect(
			sortRange(
				value,
				"data",
				{ rowStart: 0, rowEnd: 0, columnStart: 1, columnEnd: 1 },
				1,
				"ascending",
			),
		).toEqual(value);
	});
});

describe("fill", () => {
	it("offsets relative references, keeps absolute ones and literals", () => {
		expect(offsetFormula("=B2*2+$C$1", 1, 0)).toBe("=B3*2+$C$1");
		expect(offsetFormula("=SUM(A1:B2)", 0, 2)).toBe("=SUM(C1:D2)");
		expect(offsetFormula("=$A1+A$1", 2, 1)).toBe("=$A3+B$1");
		expect(offsetFormula('="A1"&A1', 1, 0)).toBe('="A1"&A2');
		expect(offsetFormula("=A1", -1, 0)).toBe("=#REF!");
		expect(offsetFormula("plain A1", 3, 3)).toBe("plain A1");
	});

	it("fills down and right from the first row or column with formats", () => {
		const value = book([
			["1", "=A1*2"],
			["2", ""],
			["3", ""],
		]);
		const bold = {
			...value,
			sheets: value.sheets.map((sheet) => ({
				...sheet,
				rows: sheet.rows.map((row, r) =>
					row.map((cell, c) =>
						r === 0 && c === 1 && cell
							? { ...cell, format: { bold: true } }
							: cell,
					),
				),
			})),
		};
		const down = fillRange(
			bold,
			"data",
			{ rowStart: 0, rowEnd: 2, columnStart: 1, columnEnd: 1 },
			"down",
		);
		expect(down.sheets[0]!.rows.map((row) => row[1]?.input)).toEqual([
			"=A1*2",
			"=A2*2",
			"=A3*2",
		]);
		expect(down.sheets[0]!.rows[2]![1]?.format?.bold).toBe(true);
		const right = fillRange(
			value,
			"data",
			{ rowStart: 1, rowEnd: 1, columnStart: 0, columnEnd: 1 },
			"right",
		);
		expect(right.sheets[0]!.rows[1]![1]?.input).toBe("2");
	});
});
