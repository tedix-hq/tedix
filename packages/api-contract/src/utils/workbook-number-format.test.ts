import { describe, expect, it } from "vite-plus/test";
import {
	OsWorkbookCellFormatSchema,
	OsWorkbookSchema,
} from "../schemas/os-workspaces";
import {
	formatWorkbookNumber,
	spreadsheetDate,
	spreadsheetSerial,
	workbookCurrency,
	workbookExcelNumberFormat,
} from "./workbook-number-format";
import type { OsWorkbookCellFormat } from "../schemas/os-workspaces";

const format = (
	value: number,
	numberFormat: OsWorkbookCellFormat["numberFormat"],
	decimals?: number,
	locale = "de-DE",
	currency?: string,
) =>
	formatWorkbookNumber(
		{ input: String(value), value, format: { numberFormat, decimals } },
		{ locale, currency },
	);

describe("spreadsheet number formats", () => {
	it("uses spreadsheet serials for dates, fractional times and datetimes", () => {
		expect(format(45292, "date")).toBe("1.1.2024");
		expect(format(0.5625, "time")).toBe("13:30:00");
		expect(format(45292.5625, "datetime")).toBe("1.1.2024, 13:30:00");
		expect(format(45292, "date", undefined, "en-US")).toBe("1/1/2024");
		expect(spreadsheetDate(1).toISOString()).toBe("1900-01-01T00:00:00.000Z");
		expect(spreadsheetDate(61).toISOString()).toBe("1900-03-01T00:00:00.000Z");
		expect(spreadsheetSerial(new Date("2024-01-01T00:00:00Z"))).toBe(45292);
	});
	it("uses locale currency and honors an explicit workbook currency", () => {
		expect(workbookCurrency({ locale: "de-DE" })).toBe("EUR");
		expect(workbookCurrency({ locale: "en-GB" })).toBe("GBP");
		expect(workbookCurrency({ locale: "es-MX" })).toBe("MXN");
		expect(format(1234.5, "currency")).toBe("1.234,50 €");
		expect(format(1234.5, "currency", 3, "de-DE", "GBP")).toBe("1.234,500 £");
	});
	it("uses the runtime locale when no workbook context exists", () => {
		const locale = new Intl.NumberFormat().resolvedOptions().locale;
		expect(
			formatWorkbookNumber({
				input: "45292",
				value: 45292,
				format: { numberFormat: "date" },
			}),
		).toBe(
			new Intl.DateTimeFormat(locale, {
				year: "numeric",
				month: "numeric",
				day: "numeric",
				timeZone: "UTC",
			}).format(new Date("2024-01-01T00:00:00Z")),
		);
	});
	it("formats integer, percentage, decimals, automatic, scientific and text", () => {
		expect(format(1234.56, "integer")).toBe("1.235");
		expect(format(0.2567, "percent", 1)).toBe("25,7 %");
		expect(format(1.2, "number", 3)).toBe("1,200");
		expect(format(1.2, "automatic", 0)).toBe("1");
		expect(format(12, "scientific", 2)).toBe("1.20e+1");
		expect(
			formatWorkbookNumber({
				input: "0012",
				value: 12,
				format: { numberFormat: "text" },
			}),
		).toBe("0012");
	});
	it("writes matching Excel format codes", () => {
		expect(
			workbookExcelNumberFormat({ numberFormat: "number", decimals: 3 }),
		).toBe("#,##0.000");
		expect(
			workbookExcelNumberFormat({ numberFormat: "percent", decimals: 1 }),
		).toBe("0.0%");
		expect(workbookExcelNumberFormat({ numberFormat: "text" })).toBe("@");
		expect(workbookExcelNumberFormat({ numberFormat: "integer" })).toBe(
			"#,##0",
		);
		expect(
			workbookExcelNumberFormat(
				{ numberFormat: "currency" },
				{ locale: "en-GB" },
			),
		).toContain("£");
		expect(
			workbookExcelNumberFormat(
				{ numberFormat: "datetime" },
				{ locale: "de-DE" },
			),
		).toBe('dd"."mm"."yyyy hh:mm:ss');
	});
	it("validates decimals and locale at the contract boundary", () => {
		for (const numberFormat of [
			"integer",
			"datetime",
			"text",
			"percent",
		] as const)
			expect(
				OsWorkbookCellFormatSchema.safeParse({ numberFormat, decimals: 3 })
					.success,
			).toBe(true);
		for (const decimals of [-1, 16, 1.5])
			expect(OsWorkbookCellFormatSchema.safeParse({ decimals }).success).toBe(
				false,
			);
		expect(
			OsWorkbookSchema.safeParse({
				locale: "invalid_locale",
				activeSheetId: "s",
				sheets: [],
			}).success,
		).toBe(false);
	});
	it("keeps currency placement and minor-unit precision in Excel", () => {
		expect(
			workbookExcelNumberFormat(
				{ numberFormat: "currency" },
				{ locale: "de-DE" },
			),
		).toBe('#,##0.00" ""€"');
		expect(
			workbookExcelNumberFormat(
				{ numberFormat: "currency" },
				{ locale: "ja-JP" },
			),
		).not.toContain(".00");
		expect(
			workbookExcelNumberFormat({ numberFormat: "scientific", decimals: 0 }),
		).toBe("0E+00");
	});
});
