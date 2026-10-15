import type { OsWorkbook } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import { evaluateWorkbook } from "./workbook-formulas";

function evaluate(
	formula: string,
	data: (string | number | null)[][] = [
		[1, 10, "a"],
		[2, 20, "b"],
		[3, 30, "c"],
	],
) {
	const workbook: OsWorkbook = {
		activeSheetId: "test",
		sheets: [
			{
				id: "test",
				name: "Test",
				frozenRows: 0,
				frozenColumns: 0,
				columns: ["A", "B", "C", "D"].map((id) => ({
					id,
					label: id,
					width: 120,
				})),
				rows: [
					...data.map((row) =>
						row.map((value) => ({
							input: value === null ? "" : String(value),
							value: null,
						})),
					),
					[{ input: `=${formula}`, value: null }],
				],
			},
		],
	};
	return evaluateWorkbook(workbook).sheets[0]!.rows[data.length]![0]!.value;
}

describe("Excel-compatible sheet functions", () => {
	it.each([
		["VLOOKUP(2,A1:C3,3,FALSE)", "b"],
		["VLOOKUP(2.5,A1:C3,2)", 20],
		["HLOOKUP(20,B1:B3,3,FALSE)", "#N/A"],
		["HLOOKUP(10,A1:C3,2,FALSE)", 20],
		["INDEX(A1:C3,2,3)", "b"],
		["INDEX(A1:C1,2)", 10],
		["MATCH(2,A1:A3,0)", 2],
		["MATCH(2.5,A1:A3)", 2],
		["LOOKUP(2.5,A1:A3,B1:B3)", 20],
		['IFERROR(1/0,"fallback")', "fallback"],
		["IFERROR(5,1/0)", 5],
		["IFERROR(IFNA(NA(),7),8)+1", 8],
		['IFNA(NA(),"missing")', "missing"],
		["IFNA(1/0,7)", "#DIV/0!"],
		["IFS(FALSE,1,TRUE,2)", 2],
		["IFS(TRUE,1,1/0,2)", 1],
		["IFS(FALSE,1)", "#N/A"],
		['SWITCH(2,1,"one",2,"two","other")', "two"],
		['SWITCH(3,1,1/0,"other")', "other"],
		["IF(TRUE,5,1/0)", 5],
		['TEXT(1234.5,"#,##0.00")', "1,234.50"],
		['TEXT(0.256,"0.0%")', "25.6%"],
		['TEXT(DATE(2024,1,2),"yyyy-mm-dd")', "2024-01-02"],
		['TEXT(0.5625,"hh:mm:ss")', "13:30:00"],
		['TEXTJOIN("-",TRUE,C1:C3)', "a-b-c"],
		['CONCAT(C1:C3,"!")', "abc!"],
		['DATEDIF(DATE(2020,6,30),DATE(2024,6,29),"Y")', 3],
		['DATEDIF(DATE(2024,1,31),DATE(2024,2,29),"M")', 0],
		['DATEDIF(DATE(2024,1,1),DATE(2024,2,1),"D")', 31],
		['DATEDIF(DATE(2020,6,30),DATE(2024,6,29),"YM")', 11],
		['DATEDIF(DATE(2024,1,15),DATE(2024,3,20),"MD")', 5],
		['DATEDIF(DATE(2020,6,30),DATE(2024,7,1),"YD")', 1],
		['DATEDIF(10,1,"D")', "#NUM!"],
		["RANK(2,A1:A3)", 2],
		["RANK(1,A1:A3,1)", 1],
		["STDEV(A1:A3)", 1],
		["STDEV.S(A1:A3)", 1],
		["STDEV.P(A1:A3)", Math.sqrt(2 / 3)],
		["VAR(A1:A3)", 1],
		["VAR.S(A1:A3)", 1],
		["VAR.P(A1:A3)", 2 / 3],
		["PERCENTILE(A1:A3,0.25)", 1.5],
		["PERCENTILE(A1:A3,2)", "#NUM!"],
		["ISERROR(1/0)", true],
		["ISERROR(5)", false],
		['ISERROR("#N/A")', false],
		["ISNA(NA())", true],
		["ISNA(1/0)", false],
		["ISERR(1/0)", true],
		["ISERR(NA())", false],
		["ERRORTYPE(1/0)", 2],
		["MODE(1,2,2,3)", 2],
		["MODE(1,2,3)", "#N/A"],
		["N(TRUE)", 1],
		['N("text")', 0],
		["NA()", "#N/A"],
		['VALUE("1,234.5")', 1234.5],
		['VALUE("25%")', 0.25],
		["DATE(2024,1,1)", 45292],
		["YEAR(DATE(2024,1,1))", 2024],
		["ISNUMBER(TODAY())", true],
		["ISNUMBER(NOW())", true],
		['VLOOKUP("B",C1:C3,1,FALSE)', "b"],
		["VLOOKUP(2,A1:C3,4,FALSE)", "#REF!"],
		["IFERROR(VLOOKUP(9,A1:C3,2,FALSE),0)", 0],
		["LOOKUP(2.5,A1:B3)", 20],
		['DATEDIF("2024-01-01","2024-02-01","D")', 31],
		['TEXT(12,"0")', "12"],
		["IFERROR(SUM(A1:A3),7)", 6],
	] as const)("%s", (formula, expected) => {
		const result = evaluate(formula);
		if (typeof expected === "number") expect(result).toBeCloseTo(expected, 10);
		else expect(result).toBe(expected);
	});
	it("supports exact wildcard matching and blank text joins", () => {
		expect(
			evaluate('MATCH("a*",A1:A3,0)', [["Apple"], ["Banana"], ["Cherry"]]),
		).toBe(1);
		expect(evaluate('TEXTJOIN("-",FALSE,A1:A3)', [["a"], [null], ["c"]])).toBe(
			"a--c",
		);
	});
	it("catches errors read from dependent cells", () => {
		expect(evaluate("IFERROR(A1,7)", [["=1/0"]])).toBe(7);
		expect(evaluate("ISNA(A1)", [["#N/A"]])).toBe(false);
		expect(evaluate("IFERROR(SUM(A1:A3),7)", [["=1/0"], [2], [3]])).toBe(7);
	});
});
