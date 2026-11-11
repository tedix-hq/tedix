import { describe, expect, it } from "vite-plus/test";
import { activeOutlineIndex, richTextOutline } from "./document-outline";

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
