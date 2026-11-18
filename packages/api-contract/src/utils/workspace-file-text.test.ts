import { describe, expect, it } from "vite-plus/test";
import { OFFICE_EXTRACT_LIMITS } from "./office-file-blocks";
import {
	WORKSPACE_FILE_TEXT_MAX_CHARS,
	boundedFileText,
	decodeTextFile,
	isTextFile,
	isTextMimeType,
	officeFileText,
	plainFileText,
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

describe("plain text files", () => {
	it("knows a text file by its name first, then by its declared type", () => {
		for (const name of [
			"notes.txt",
			"README.md",
			"data.JSON",
			"main.ts",
			"config.yaml",
			"deploy.sh",
			"query.sql",
		])
			expect(isTextFile(name, "application/octet-stream")).toBe(true);
		// Browsers call a TypeScript file a video; the name still decides.
		expect(isTextFile("main.ts", "video/mp2t")).toBe(true);
		expect(isTextFile("notes", "text/plain")).toBe(true);
		expect(isTextFile("notes", "application/json")).toBe(true);
		expect(isTextFile("feed", "application/rss+xml")).toBe(true);
		for (const [name, mime] of [
			["photo.png", "image/png"],
			["drawing", "image/svg+xml"],
			["clip.mp4", "video/mp4"],
			["archive.zip", "application/zip"],
			["notes", "application/octet-stream"],
			["book.docx", "application/octet-stream"],
		] as const)
			expect(isTextFile(name, mime)).toBe(false);
		expect(isTextMimeType("TEXT/Markdown")).toBe(true);
		expect(
			isTextMimeType(
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			),
		).toBe(false);
	});

	it("decodes UTF-8 and refuses bytes that are not text", () => {
		const encode = (text: string) => new TextEncoder().encode(text);
		expect(decodeTextFile(encode("Grüße, 世界 👋\n"))).toBe("Grüße, 世界 👋\n");
		// A byte order mark is not part of the text.
		expect(decodeTextFile(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe(
			"hi",
		);
		// A zero byte, as in any image, video or UTF-16 file.
		expect(decodeTextFile(new Uint8Array([0x68, 0x00, 0x69]))).toBeNull();
		// Latin-1 "é" and a cut-off multi-byte character are not valid UTF-8.
		expect(decodeTextFile(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBeNull();
		expect(decodeTextFile(new Uint8Array([0x68, 0xe4, 0xb8]))).toBeNull();
	});

	it("keeps every line of a file, whatever its line endings", () => {
		expect(plainFileText("one\r\ntwo\rthree\nfour\n\n")).toBe(
			"one\ntwo\nthree\nfour",
		);
		const long = Array.from(
			{ length: 2_000 },
			(_, index) => `line ${index + 1}`,
		);
		const kept = plainFileText(`${long.join("\n")}\n`).split("\n");
		expect(kept).toHaveLength(2_000);
		expect(kept.at(-1)).toBe("line 2000");
	});
});
