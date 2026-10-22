import assert from "node:assert/strict";
import {
	OsOutputContentSchema,
	type OsOutputContent,
	type OsSheetCell,
} from "@tedix/api-contract/schemas/os-workspaces";
import { unzipSync } from "fflate";
import { describe, it } from "vite-plus/test";
import { buildOsSheetCsv } from "./os-output-csv";

type Sheet = Extract<OsOutputContent, { kind: "sheet" }>;
type WorkbookSheet = NonNullable<Sheet["workbook"]>["sheets"][number];

// Only separators outside quoted fields are records; require CRLF there.
function decodeCsv(bytes: Uint8Array): string[][] {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const records: string[][] = [];
	let row: string[] = [];
	let field = "";
	let state: "start" | "plain" | "quoted" | "closed" = "start";
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index]!;
		if (state === "quoted") {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index += 1;
				} else state = "closed";
			} else field += char;
			continue;
		}
		if (char === "," || char === "\r") {
			row.push(field);
			field = "";
			state = "start";
			if (char === "\r") {
				assert.equal(text[++index], "\n", "records must end with CRLF");
				records.push(row);
				row = [];
			}
		} else if (char === '"') {
			assert.equal(state, "start", "quote inside an unquoted field");
			state = "quoted";
		} else {
			assert.notEqual(char, "\n", "bare LF outside a quoted field");
			assert.notEqual(state, "closed", "text after a closing quote");
			field += char;
			state = "plain";
		}
	}
	assert.equal(state, "start", "unterminated field or missing final CRLF");
	assert.deepEqual(row, [], "unterminated record");
	return records;
}

async function exportSheet(content: Sheet) {
	OsOutputContentSchema.parse(content);
	return buildOsSheetCsv(content);
}

function workbookSheet(
	id: string,
	name: string,
	labels: string[],
	rows: OsSheetCell[][],
): WorkbookSheet {
	return {
		id,
		name,
		columns: labels.map((label, index) => ({
			id: `column-${index}`,
			label,
			width: 120,
		})),
		rows: rows.map((row) =>
			row.map((value) => ({
				input: value === null ? "" : String(value),
				value,
			})),
		),
		frozenRows: 0,
		frozenColumns: 0,
	};
}

describe("CSV round trips", () => {
	const labels = [
		"Zero",
		"False",
		"Null",
		"Empty",
		"Comma, label",
		'Quote "label"',
		"CR\rlabel",
		"LF\nlabel",
		"CRLF\r\nlabel",
		"文字",
		"Supplementary 𠮷",
		"Trailing",
	];
	const rows: OsSheetCell[][] = [
		[
			0,
			false,
			null,
			"",
			"left,right",
			'"quoted", "again"',
			"before\rafter",
			"before\nafter",
			"before\r\nafter",
			"Café e\u0301 日本語 العربية",
			"🧪 𠮷 𝄞",
			"",
		],
		["", true, 0, false, ",", '"', "\r", "\n", "\r\n", "ß", "🚀", null],
	];
	const expected = [
		labels,
		[
			"0",
			"false",
			"",
			"",
			"left,right",
			'"quoted", "again"',
			"before\rafter",
			"before\nafter",
			"before\r\nafter",
			"Café e\u0301 日本語 العربية",
			"🧪 𠮷 𝄞",
			"",
		],
		["", "true", "0", "false", ",", '"', "\r", "\n", "\r\n", "ß", "🚀", ""],
	];

	it.each(["flat", "rich"] as const)(
		"preserves cell positions, escapes and Unicode in %s sheets",
		async (kind) => {
			const content: Sheet = { kind: "sheet", columns: labels, rows };
			if (kind === "rich") {
				content.workbook = {
					activeSheetId: "matrix",
					sheets: [workbookSheet("matrix", "Matrix", labels, rows)],
				};
			}
			const result = await exportSheet(content);
			assert.equal(result.extension, "csv");
			assert.equal(result.contentType, "text/csv; charset=utf-8");
			assert.deepEqual(decodeCsv(result.bytes), expected);
		},
	);

	it("pads absent rich cells without dropping zero, false or trailing empties", async () => {
		const sheet = workbookSheet(
			"sparse",
			"Sparse",
			["A", "B", "C", "D", "E", "F"],
			[],
		);
		sheet.rows = [
			[
				{ input: "0", value: 0 },
				null,
				{ input: "false", value: false },
				{ input: "", value: "" },
				{ input: "", value: null },
			],
			[],
			[{ input: "tail", value: "tail" }],
		];
		const result = await exportSheet({
			kind: "sheet",
			columns: ["stale projection"],
			rows: [["must not appear"]],
			workbook: { activeSheetId: sheet.id, sheets: [sheet] },
		});
		assert.deepEqual(decodeCsv(result.bytes), [
			["A", "B", "C", "D", "E", "F"],
			["0", "", "false", "", "", ""],
			["", "", "", "", "", ""],
			["tail", "", "", "", "", ""],
		]);
	});

	it("returns CSV metadata for empty flat content and header-only single sheets", async () => {
		const headerOnly = workbookSheet("empty", "Empty", ["Name", "Value"], []);
		const fixtures: Sheet[] = [
			{ kind: "sheet", columns: [], rows: [] },
			{ kind: "sheet", columns: ["Name", "Value"], rows: [] },
			{
				kind: "sheet",
				columns: [],
				rows: [],
				workbook: { activeSheetId: "empty", sheets: [headerOnly] },
			},
		];
		for (const [index, fixture] of fixtures.entries()) {
			const result = await exportSheet(fixture);
			assert.equal(result.extension, "csv");
			assert.equal(result.contentType, "text/csv; charset=utf-8");
			if (index > 0)
				assert.deepEqual(decodeCsv(result.bytes), [["Name", "Value"]]);
		}
	});

	it("keeps colliding sheet names unique and maps archive order to sheet data", async () => {
		const longPrefix = "L".repeat(100);
		const names = [
			"Duplicate",
			"Duplicate",
			"Sales/Q1",
			"Sales?Q1",
			`${longPrefix}A`,
			`${longPrefix}B`,
			"Café_日本",
			"東京_𠮷",
		];
		const sheets = names.map((name, index) =>
			workbookSheet(
				`sheet-${index}`,
				name,
				["Sheet", "Ordinal", "Empty"],
				[[`Sheet ${index}: ${name}\r\n🧪`, index, null]],
			),
		);
		const result = await exportSheet({
			kind: "sheet",
			columns: ["stale projection"],
			rows: [["must not appear"]],
			workbook: { activeSheetId: sheets[5]!.id, sheets },
		});
		assert.equal(result.extension, "zip");
		assert.equal(result.contentType, "application/zip");
		const files = unzipSync(result.bytes);
		const filenames = Object.keys(files);
		assert.equal(new Set(filenames).size, sheets.length);
		for (const [index, filename] of filenames.entries()) {
			assert.deepEqual(decodeCsv(files[filename]!), [
				["Sheet", "Ordinal", "Empty"],
				[`Sheet ${index}: ${names[index]}\r\n🧪`, String(index), ""],
			]);
		}
		assert.deepEqual(filenames, [
			"1-Duplicate.csv",
			"2-Duplicate.csv",
			"3-Sales_Q1.csv",
			"4-Sales_Q1.csv",
			`5-${longPrefix}.csv`,
			`6-${longPrefix}.csv`,
			"7-Café_日本.csv",
			"8-東京_𠮷.csv",
		]);
	});
});
