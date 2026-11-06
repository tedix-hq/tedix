import { describe, expect, it } from "vite-plus/test";
import {
	OsOutputContentInputSchema,
	OsOutputContentSchema,
} from "../schemas/os-workspaces";
import {
	blocksFromRichText,
	markdownDocument,
	normalizeOsOutputInput,
	richTextFromBlocks,
	withDerivedDocumentBlocks,
} from "./os-document";

const markdown =
	"## Plan\n\n| Name | Goal |\n| :--- | ---: |\n| **Factory** | [Ship](https://example.test) |\n\n- [ ] Review\n- [x] Verified\n\n- Parent\n  - Child\n\n```md\n## literal\n| a | b |\n```";
describe("structured document ingestion", () => {
	it("parses GFM tables, headings, tasks, nested lists and literal code", () => {
		const content = normalizeOsOutputInput(markdown);
		expect(OsOutputContentSchema.safeParse(content).success).toBe(true);
		if (content.kind !== "document") throw new Error("document expected");
		expect(content.blocks.map((block) => block.type)).toEqual([
			"heading",
			"table",
			"checklist",
			"list",
			"code",
		]);
		expect(content.blocks[1]).toMatchObject({
			headers: ["Name", "Goal"],
			rows: [["**Factory**", "[Ship](https://example.test)"]],
			align: ["left", "right"],
		});
		expect(content.richText?.content[3]?.content?.[0]?.content?.[1]?.type).toBe(
			"bulletList",
		);
		expect(content.blocks.at(-1)).toMatchObject({
			text: "## literal\n| a | b |",
		});
	});
	it("upgrades markdown paragraphs with and without rich text without touching formatted text", () => {
		for (const richText of [
			undefined,
			{
				type: "doc" as const,
				content: [
					{ type: "paragraph", content: [{ type: "text", text: markdown }] },
				],
			},
		]) {
			const content = normalizeOsOutputInput({
				kind: "document",
				blocks: [{ type: "paragraph", text: markdown }],
				richText,
			});
			expect(
				content.kind === "document" &&
					content.blocks.some((block) => block.type === "table"),
			).toBe(true);
		}
		const richText = markdownDocument("**Keep**");
		expect(
			normalizeOsOutputInput({ kind: "document", blocks: [], richText }),
		).toMatchObject({ richText });
	});
	it("round-trips semantic tables, widths, alignment, callouts, toggles and checklists", () => {
		const blocks = OsOutputContentSchema.parse({
			kind: "document",
			blocks: [
				{
					type: "table",
					headers: ["Name"],
					rows: [["**One**"]],
					widths: [180],
					align: ["center"],
				},
				{ type: "callout", text: "Note" },
				{ type: "toggle", summary: "More", text: "Details" },
				{ type: "checklist", items: [{ text: "Done", checked: true }] },
			],
		});
		if (blocks.kind !== "document") throw new Error("document expected");
		expect(blocksFromRichText(richTextFromBlocks(blocks.blocks))).toEqual(
			blocks.blocks,
		);
	});
});

describe("documents never lose content silently", () => {
	const codeDoc = {
		type: "doc" as const,
		content: [
			{
				type: "codeBlock",
				attrs: { language: "json" },
				content: [{ type: "text", text: '{"posts":[1]}' }],
			},
		],
	};

	it("rebuilds blocks from rich text even when empty blocks were sent", () => {
		const content = normalizeOsOutputInput({
			kind: "document",
			blocks: [],
			richText: codeDoc,
		});
		expect(content.kind === "document" && content.blocks).toEqual([
			{ type: "code", language: "json", text: '{"posts":[1]}' },
		]);
	});

	it("derives blocks on read for stored rich text with empty blocks", () => {
		const content = withDerivedDocumentBlocks({
			kind: "document",
			blocks: [],
			richText: codeDoc,
		});
		expect(content.kind === "document" && content.blocks).toHaveLength(1);
	});

	it("leaves an empty document empty", () => {
		const empty = {
			kind: "document" as const,
			blocks: [],
			richText: { type: "doc" as const, content: [] },
		};
		expect(withDerivedDocumentBlocks(empty)).toBe(empty);
	});

	it("refuses document fields that would otherwise be stripped", () => {
		expect(
			OsOutputContentInputSchema.safeParse({
				kind: "document",
				blocks: [],
				markdown: "# Hi",
			}).success,
		).toBe(false);
		expect(
			OsOutputContentInputSchema.safeParse({
				kind: "document",
				blocks: [],
				richText: { type: "doc", children: [] },
			}).success,
		).toBe(false);
	});

	it("accepts complete document bodies and other kinds", () => {
		expect(
			OsOutputContentInputSchema.safeParse({
				kind: "document",
				blocks: [],
				richText: codeDoc,
			}).success,
		).toBe(true);
		expect(
			OsOutputContentInputSchema.safeParse({
				kind: "sheet",
				columns: [],
				rows: [],
			}).success,
		).toBe(true);
	});
});
