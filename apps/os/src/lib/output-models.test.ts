import { validateCodeChangeSchema } from "@/collab/ot/code-change";
import { MAX_MESSAGE_BYTES } from "@/collab/protocol";
import { canonicalJsonText } from "@/lib/diff/canonical-json";
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import {
	blocksFromRichText,
	normalizeOutputContent,
	presentationCanvasLength,
	projectDeck,
	projectWorkbook,
	richTextFromBlocks,
	workbookFromProjection,
} from "./output-models";

describe("output authoring models", () => {
	it("projects presentation pixels onto the current canvas width", () => {
		expect(presentationCanvasLength(48)).toBe("calc(48 * 100cqw / 1200)");
	});

	it("round-trips the block projection through Tiptap JSON", () => {
		const blocks = [
			{ type: "heading" as const, level: 2, text: "Plan" },
			{ type: "list" as const, ordered: false, items: ["One", "Two"] },
		];
		expect(blocksFromRichText(richTextFromBlocks(blocks))).toEqual(blocks);
	});

	it("keeps image media in rich text while producing a valid bounded semantic projection", () => {
		const src = "data:image/png;base64," + "A".repeat(256 * 1024 - 30);
		const richText = {
			type: "doc" as const,
			content: [
				{
					type: "image",
					attrs: { src, alt: "Bank receipt", width: 800, height: 400 },
				},
			],
		};
		const blocks = blocksFromRichText(richText);
		const content = { kind: "document", richText, blocks };
		expect(blocks).toEqual([
			{ type: "paragraph", text: "[Image: Bank receipt]" },
		]);
		expect(OsOutputContentSchema.safeParse(content).success).toBe(true);
		expect(content.richText.content[0]?.attrs.src).toBe(src);
		const text = canonicalJsonText(content);
		expect(() =>
			validateCodeChangeSchema([["content.json", { set: text }]]),
		).not.toThrow();
		expect(
			new TextEncoder().encode(
				JSON.stringify({ change: [["content.json", { set: text }]] }),
			).length,
		).toBeLessThan(MAX_MESSAGE_BYTES);
	});
	it("retains ordinary image URLs but never embeds oversized or data URLs in headless text", () => {
		const richText = {
			type: "doc" as const,
			content: [
				{
					type: "image",
					attrs: { src: "https://example.com/receipt.png", alt: "Receipt" },
				},
				{
					type: "image",
					attrs: { src: "data:image/png;base64,AAA", alt: "A".repeat(30_000) },
				},
			],
		};
		const blocks = blocksFromRichText(richText);
		expect(blocks[0]).toEqual({
			type: "paragraph",
			text: "![Receipt](https://example.com/receipt.png)",
		});
		expect(
			OsOutputContentSchema.safeParse({ kind: "document", richText, blocks })
				.success,
		).toBe(true);
	});

	it("creates a workbook from the sheet projection while preserving it", () => {
		const projection = {
			kind: "sheet" as const,
			columns: ["A", "B"],
			rows: [[1, "two"]],
		};
		const workbook = workbookFromProjection(projection);
		expect(projectWorkbook(workbook)).toMatchObject(projection);
		expect(
			OsOutputContentSchema.safeParse(projectWorkbook(workbook)).success,
		).toBe(true);
	});

	it("projects visual slides into the stable headless outline", () => {
		const content = projectDeck({
			width: 1200,
			height: 675,
			activeSlideId: "slide-1",
			slides: [
				{
					id: "slide-1",
					name: "Fallback",
					layout: "blank",
					background: "#ffffff",
					notes: "Pause",
					elements: [
						{
							id: "body",
							type: "bullet",
							x: 40,
							y: 160,
							width: 500,
							height: 300,
							text: "One\nTwo",
							style: {},
						},
						{
							id: "title",
							type: "title",
							x: 40,
							y: 40,
							width: 500,
							height: 80,
							text: "Roadmap",
							style: {},
						},
					],
				},
			],
		});
		expect(content.slides).toEqual([
			{ title: "Roadmap", bullets: ["One", "Two"], notes: "Pause" },
		]);
		expect(OsOutputContentSchema.safeParse(content).success).toBe(true);
	});

	it("normalizes all three output projections without changing their kind", () => {
		const outputs = [
			{
				kind: "document" as const,
				blocks: [{ type: "paragraph" as const, text: "Doc" }],
			},
			{ kind: "sheet" as const, columns: ["A"], rows: [[1]] },
			{
				kind: "presentation" as const,
				slides: [{ title: "Slide", bullets: [] }],
			},
		];
		for (const output of outputs) {
			const normalized = normalizeOutputContent(output);
			expect(normalized.kind).toBe(output.kind);
			expect(OsOutputContentSchema.safeParse(normalized).success).toBe(true);
		}
	});
});
