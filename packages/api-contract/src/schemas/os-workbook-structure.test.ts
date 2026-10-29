import { describe, expect, it } from "vite-plus/test";
import {
	OsWorkbookSheetSchema,
	OsWorkbookCellSchema,
	OsWorkbookCellFormatSchema,
	OsSheetCellSchema,
} from "./os-workspaces";

const sheet = {
	id: "sheet",
	name: "Sheet",
	columns: [{ id: "a", label: "A" }],
	rows: [[{ input: "1" }]],
};
describe("workbook row heights", () => {
	it("keeps existing workbooks valid without row heights", () => {
		expect(OsWorkbookSheetSchema.parse(sheet).rowHeights).toBeUndefined();
	});
	it("retains explicit row heights", () => {
		expect(
			OsWorkbookSheetSchema.parse({ ...sheet, rowHeights: [20, 28, 600] })
				.rowHeights,
		).toEqual([20, 28, 600]);
	});
	it.each([[19], [601], [28.5], Array(1001).fill(28)])(
		"rejects invalid heights or excessive dimensions",
		(...rowHeights) => {
			expect(
				OsWorkbookSheetSchema.safeParse({ ...sheet, rowHeights }).success,
			).toBe(false);
		},
	);
});

describe("workbook cell formats and text", () => {
	it("keeps long text in both rich cells and their plain-value projection", () => {
		const text = "x".repeat(8192);
		expect(OsWorkbookCellSchema.parse({ input: text, value: text }).value).toBe(
			text,
		);
		expect(OsSheetCellSchema.parse(text)).toBe(text);
		expect(OsWorkbookCellSchema.safeParse({ input: `${text}x` }).success).toBe(
			false,
		);
		expect(OsSheetCellSchema.safeParse(`${text}x`).success).toBe(false);
	});
	it("retains pixel font sizes and rejects sizes outside the supported range", () => {
		for (const fontSize of [6, 17, 96])
			expect(OsWorkbookCellFormatSchema.parse({ fontSize }).fontSize).toBe(
				fontSize,
			);
		for (const fontSize of [5, 97, 12.5, "16"])
			expect(OsWorkbookCellFormatSchema.safeParse({ fontSize }).success).toBe(
				false,
			);
	});
});
