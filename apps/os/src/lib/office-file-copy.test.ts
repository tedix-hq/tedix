import { describe, expect, it } from "vite-plus/test";
import { OsOutputContentInputSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { readOfficeFile } from "@tedix/api-contract/utils/office-file-read";
import {
	editableCopyContent,
	editableCopyKind,
	editableCopyTitle,
} from "./office-file-copy";
import { evaluateWorkbook } from "./workbook-formulas";

describe("editableCopyContent", () => {
	it("turns a workbook into an editable sheet with every sheet, value and formula", () => {
		const content = editableCopyContent({
			kind: "sheet",
			format: "xlsx",
			truncated: false,
			sheets: [
				{
					name: "Budget",
					rows: [
						["Item", "Price", "Code"],
						["Paper", 3.5, "007"],
						["Ink", 10, "=not a formula"],
						[null, 13.5, true],
					],
					formulas: [{ row: 3, column: 1, formula: "SUM(B2:B3)" }],
				},
				{ name: "Budget", rows: [], formulas: [] },
			],
		});
		expect(OsOutputContentInputSchema.parse(content)).toBeTruthy();
		if (content.kind !== "sheet" || !content.workbook)
			throw new Error("expected a workbook");
		expect(content.columns).toEqual(["A", "B", "C"]);
		expect(content.rows[1]).toEqual(["Paper", 3.5, "007"]);
		const [budget, second] = content.workbook.sheets;
		expect(second!.name).toBe("Budget (2)");
		expect(budget!.rows[3]![1]).toEqual({ input: "=SUM(B2:B3)", value: 13.5 });
		expect(budget!.rows[3]![2]).toEqual({ input: "TRUE", value: true });
		// Text that would read as a number or a formula stays text.
		expect(budget!.rows[1]![2]).toEqual({
			input: "007",
			value: "007",
			format: { numberFormat: "text" },
		});
		expect(budget!.rows[2]![2]!.format).toEqual({ numberFormat: "text" });
		expect(budget!.rows[0]![0]).toEqual({ input: "Item", value: "Item" });
	});

	it("keeps the formulas working in the sheet editor's calculator", async () => {
		const file = await readOfficeFile(
			new TextEncoder().encode("Item,Amount\nPaper,2\nInk,5\n"),
			"csv",
		);
		const content = editableCopyContent(file);
		if (content.kind !== "sheet" || !content.workbook)
			throw new Error("expected a workbook");
		const sheet = content.workbook.sheets[0]!;
		sheet.rows.push([
			{ input: "Total", value: "Total" },
			{ input: "=SUM(B2:B3)", value: null },
		]);
		const computed = evaluateWorkbook(content.workbook);
		expect(computed.sheets[0]!.rows[3]![1]!.value).toBe(7);
	});

	it("turns a Word document into a doc the editor can open", () => {
		const content = editableCopyContent({
			kind: "document",
			format: "docx",
			truncated: false,
			blocks: [
				{ type: "heading", level: 1, text: "Plan" },
				{ type: "paragraph", text: "Hello" },
				{ type: "table", rows: [["Name", "Role"], ["Ada"]] },
			],
		});
		expect(OsOutputContentInputSchema.parse(content)).toBeTruthy();
		expect(content).toMatchObject({
			kind: "document",
			blocks: [
				{ type: "heading", level: 1, text: "Plan" },
				{ type: "paragraph", text: "Hello" },
				{ type: "table", headers: ["Name", "Role"], rows: [["Ada", ""]] },
			],
			richText: { type: "doc" },
		});
	});

	it("turns a deck into slides with titles, bullets and notes", () => {
		const file = {
			kind: "slides" as const,
			format: "pptx" as const,
			truncated: false,
			slides: [
				{ title: "Welcome", text: ["Agenda"], notes: "Say hello" },
				{ title: "", text: [] },
			],
		};
		const content = editableCopyContent(file);
		expect(OsOutputContentInputSchema.parse(content)).toBeTruthy();
		expect(editableCopyKind(file)).toBe("presentation");
		expect(content).toEqual({
			kind: "presentation",
			slides: [
				{ title: "Welcome", bullets: ["Agenda"], notes: "Say hello" },
				{ title: "Slide 2", bullets: [] },
			],
		});
	});

	it("names the copy after the file without its extension", () => {
		expect(editableCopyTitle("Q3 budget.xlsx")).toBe("Q3 budget");
		expect(editableCopyTitle(".csv")).toBe("Untitled");
	});
});
