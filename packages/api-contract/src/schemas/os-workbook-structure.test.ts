import { describe, expect, it } from "vite-plus/test";
import { OsWorkbookSheetSchema } from "./os-workspaces";

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
