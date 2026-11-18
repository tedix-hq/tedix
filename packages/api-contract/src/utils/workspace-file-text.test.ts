import { describe, expect, it } from "vite-plus/test";
import { OFFICE_EXTRACT_LIMITS } from "./office-file-blocks";
import {
	WORKSPACE_FILE_TEXT_MAX_CHARS,
	boundedFileText,
	officeFileText,
	workspaceFileTextKey,
} from "./workspace-file-text";

describe("officeFileText", () => {
	it("keeps every sheet row as one line with its row number, past the preview's limit", () => {
		const rows = Array.from({ length: 1_000 }, (_, index) => [
			`item ${index + 1}`,
			index,
			index % 2 === 0,
			null,
		]);
		const text = officeFileText({
			kind: "sheet",
			format: "xlsx",
			truncated: false,
			sheets: [
				{ name: "Stock", rows, formulas: [] },
				{ name: "Empty", rows: [], formulas: [] },
			],
		});
		const lines = text.split("\n");
		expect(lines.slice(0, 4)).toEqual([
			"## Stock",
			"",
			"| Row | A | B | C | D |",
			"| 1 | item 1 | 0 | TRUE |  |",
		]);
		expect(rows.length).toBeGreaterThan(OFFICE_EXTRACT_LIMITS.rowsPerSheet);
		expect(lines).toContain("| 1000 | item 1000 | 999 | FALSE |  |");
		expect(lines.slice(-3)).toEqual(["## Empty", "", "This sheet is empty."]);
	});

	it("writes a document and a deck as lines, and keeps a table cell on one line", () => {
		expect(
			officeFileText({
				kind: "document",
				format: "docx",
				truncated: true,
				blocks: [
					{ type: "heading", level: 2, text: "Terms" },
					{ type: "paragraph", text: "First line\nsecond line" },
					{ type: "table", rows: [["a|b", "two\nlines"]] },
				],
			}),
		).toBe(
			"## Terms\n\nFirst line\nsecond line\n\n| a\\|b | two lines |\n\n[The file is larger than what can be read. The text stops here.]",
		);
		expect(
			officeFileText({
				kind: "slides",
				format: "pptx",
				truncated: false,
				slides: [
					{ title: "Plan", text: ["One", "Two"], notes: "Say hello" },
					{ title: "", text: [] },
				],
			}),
		).toBe(
			"## Slide 1: Plan\n- One\n- Two\nSpeaker notes: Say hello\n\n## Slide 2",
		);
	});
});

describe("boundedFileText", () => {
	it("stops at a whole line under the kept length and says the rest is missing", () => {
		const line = "x".repeat(999);
		const text = boundedFileText(Array.from({ length: 5_000 }, () => line));
		expect(text.length).toBeLessThan(WORKSPACE_FILE_TEXT_MAX_CHARS + 200);
		const lines = text.split("\n");
		expect(lines).toHaveLength(4_002);
		expect(lines.at(-1)).toBe(
			"[The text of this file is longer than what is kept here. The rest is not available.]",
		);
		expect(lines.at(-3)).toBe(line);
	});
});

describe("workspaceFileTextKey", () => {
	it("keeps each workspace's file texts under its own organization and workspace", () => {
		expect(workspaceFileTextKey("org/a", "w1", "r1")).toBe(
			"workspace-file-text/v1/org%2Fa/w1/r1.json",
		);
	});
});
