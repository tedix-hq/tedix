import type {
	OsOutputContent,
	OsWorkbookCellFormat,
} from "@tedix/api-contract/schemas/os-workspaces";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vite-plus/test";
import { renderOsOutputHtml } from "./os-output-html";
import { buildOsOutputOfficeExport } from "./os-output-office";

function content(
	numberFormat: OsWorkbookCellFormat["numberFormat"],
	value: number,
	decimals?: number,
): OsOutputContent {
	return {
		kind: "sheet",
		columns: ["Value"],
		rows: [[value]],
		workbook: {
			locale: "de-DE",
			currency: "EUR",
			activeSheetId: "s",
			sheets: [
				{
					id: "s",
					name: "Formats",
					columns: [{ id: "v", label: "Value", width: 120 }],
					rows: [
						[
							{
								input: String(value),
								value,
								format: { numberFormat, decimals },
							},
						],
					],
					frozenRows: 0,
					frozenColumns: 0,
				},
			],
		},
	};
}

describe("number formats in rendered and Office exports", () => {
	it.each([
		[
			"date",
			45292,
			undefined,
			"1.1.2024",
			"dd&quot;.&quot;mm&quot;.&quot;yyyy",
		],
		["time", 0.5625, undefined, "13:30:00", "hh:mm:ss"],
		["datetime", 45292.5625, undefined, "1.1.2024, 13:30:00", "hh:mm:ss"],
		["integer", 1234.56, undefined, "1.235", "#,##0"],
		["number", 1234.5, 3, "1.234,500", "#,##0.000"],
		["currency", 1234.5, 3, "1.234,500 €", "€"],
		["percent", 0.256, 1, "25,6 %", "0.0&quot; &quot;%"],
		["text", 45292, undefined, "45292", "@"],
	] as const)(
		"preserves %s for PDF/PNG and XLSX",
		async (numberFormat, value, decimals, expected, code) => {
			const body = content(numberFormat, value, decimals);
			const html = renderOsOutputHtml(
				{ kind: "sheet", title: "C1" },
				{ revision: 1, createdAt: "2026-01-01T00:00:00Z", content: body },
			);
			expect(html).toContain(expected);
			expect(html).not.toContain("1970");
			const zip = unzipSync(
				await buildOsOutputOfficeExport("xlsx", body, "C1"),
			);
			const styles = new TextDecoder().decode(zip["xl/styles.xml"]);
			const cells = new TextDecoder().decode(zip["xl/worksheets/sheet1.xml"]);
			expect(styles).toContain(code);
			if (numberFormat !== "text") expect(cells).toContain(`<v>${value}</v>`);
		},
	);
	it("keeps leading zeros and formula-like plain text literal in XLSX", async () => {
		const body = content("text", 12);
		if (body.kind !== "sheet") throw new Error("expected sheet");
		body.workbook!.sheets[0]!.rows = [
			[{ input: "0012", value: "0012", format: { numberFormat: "text" } }],
			[{ input: "=1+2", value: "=1+2", format: { numberFormat: "text" } }],
		];
		const zip = unzipSync(await buildOsOutputOfficeExport("xlsx", body, "C1"));
		const cells = new TextDecoder().decode(zip["xl/worksheets/sheet1.xml"]);
		expect(cells).toContain("0012");
		expect(cells).toContain("=1+2");
		expect(cells).not.toContain("<f>");
	});
});
