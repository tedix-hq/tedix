import type { OsWorkbook } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import {
	evaluateWorkbook,
	formatWorkbookValue,
	WORKBOOK_SUPPORTED_FORMULA_COUNT,
} from "./workbook-formulas";

const workbook = (): OsWorkbook => ({
	activeSheetId: "current",
	sheets: [
		{
			id: "current",
			name: "Current",
			frozenRows: 0,
			frozenColumns: 0,
			columns: ["A", "B", "C"].map((label) => ({
				id: label,
				label,
				width: 120,
			})),
			rows: [
				[
					{ input: "2", value: null },
					{ input: "3", value: null },
					{ input: "=SUM(A1:B1)", value: null },
				],
			],
		},
		{
			id: "prior",
			name: "Prior Year",
			frozenRows: 0,
			frozenColumns: 0,
			columns: [{ id: "A", label: "A", width: 120 }],
			rows: [[{ input: "10", value: null }]],
		},
	],
});

describe("workbook formulas", () => {
	it("evaluates literals, ranges, and dependent formulas without eval", () => {
		const evaluated = evaluateWorkbook(workbook());
		expect(evaluated.sheets[0]?.rows[0]?.map((cell) => cell?.value)).toEqual([
			2, 3, 5,
		]);
	});

	it("evaluates quoted cross-sheet references", () => {
		const value = workbook();
		value.sheets[0]!.rows.push([{ input: "='Prior Year'!A1+5", value: null }]);
		const evaluated = evaluateWorkbook(value);
		expect(evaluated.sheets[0]?.rows[1]?.[0]?.value).toBe(15);
	});

	it("exposes the Excel-style inventory and deterministic formats", () => {
		expect(WORKBOOK_SUPPORTED_FORMULA_COUNT).toBeGreaterThan(100);
		expect(
			formatWorkbookValue({
				input: "0.25",
				value: 0.25,
				format: { numberFormat: "percent" },
			}),
		).toContain("25");
		expect(
			formatWorkbookValue({
				input: "12",
				value: 12,
				format: { numberFormat: "scientific" },
			}),
		).toBe("1.2000e+1");
	});
});
