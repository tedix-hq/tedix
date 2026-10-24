import { describe, expect, it } from "vite-plus/test";
import {
	DOCUMENT_BLOCK_GROUPS,
	filterDocumentBlocks,
} from "./document-block-library";
import { activeOutlineIndex, richTextOutline } from "./document-outline";
import { shortcutKeys } from "./document-shortcuts";

describe("document block library", () => {
	it("gives every block a unique id, an icon and a one-line description", () => {
		const blocks = DOCUMENT_BLOCK_GROUPS.flatMap((group) => group.blocks);
		expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
		for (const block of blocks) {
			expect(block.icon, block.id).toBeTruthy();
			expect(block.description.length, block.id).toBeGreaterThan(0);
			expect(block.description.length, block.id).toBeLessThanOrEqual(32);
		}
	});

	it("filters by name, description and keywords, requiring every word", () => {
		expect(filterDocumentBlocks("tab").map((block) => block.id)).toEqual([
			"table",
		]);
		expect(filterDocumentBlocks("todo")[0]?.id).toBe("checklist");
		expect(filterDocumentBlocks("h2")[0]?.id).toBe("heading-2");
		expect(filterDocumentBlocks("image web").map((block) => block.id)).toEqual([
			"image-url",
		]);
		expect(filterDocumentBlocks("nothing-like-this")).toEqual([]);
		expect(filterDocumentBlocks("  ")).toHaveLength(
			DOCUMENT_BLOCK_GROUPS.flatMap((group) => group.blocks).length,
		);
	});
});

describe("document outline", () => {
	const content = [
		{
			type: "heading",
			attrs: { level: 1 },
			content: [{ type: "text", text: "Plan" }],
		},
		{ type: "paragraph", content: [{ type: "text", text: "Body" }] },
		{ type: "heading", attrs: { level: 2 }, content: [] },
		{
			type: "heading",
			attrs: { level: 2 },
			content: [
				{ type: "text", text: "Go" },
				{ type: "text", text: "als" },
			],
		},
	];

	it("lists non-empty top-level headings by block index", () => {
		expect(richTextOutline(content)).toEqual([
			{ level: 1, text: "Plan", position: 0 },
			{ level: 2, text: "Goals", position: 3 },
		]);
	});

	it("marks the last heading at or before a position", () => {
		const items = richTextOutline(content);
		expect(activeOutlineIndex(items, 0)).toBe(0);
		expect(activeOutlineIndex(items, 2)).toBe(0);
		expect(activeOutlineIndex(items, 9)).toBe(1);
		expect(activeOutlineIndex([], 9)).toBe(-1);
	});
});

describe("shortcut labels", () => {
	it("spells modifier keys for the device", () => {
		const keys = shortcutKeys("Mod+Shift+S");
		expect(keys).toHaveLength(3);
		expect(keys.at(-1)).toBe("S");
		expect(["⌘", "Ctrl"]).toContain(keys[0]);
	});
});
