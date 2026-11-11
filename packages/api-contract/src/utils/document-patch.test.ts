import { describe, expect, it } from "vite-plus/test";
import type { OsOutputContent, OsRichTextNode } from "../schemas/os-workspaces";
import { blocksFromRichText, richTextFromBlocks } from "./os-document";
import { applyDocumentBlockPatch } from "./document-patch";

const paragraph = (text: string): OsRichTextNode => ({
	type: "paragraph",
	content: [{ type: "text", text }],
});
const formatted: OsRichTextNode = {
	type: "paragraph",
	attrs: { textAlign: "right", indent: 2 },
	content: [
		{
			type: "text",
			text: "Keep this",
			marks: [
				{ type: "bold" },
				{ type: "textStyle", attrs: { color: "#123456", fontSize: "18pt" } },
				{ type: "link", attrs: { href: "https://example.test" } },
			],
		},
	],
};
function document(
	nodes: OsRichTextNode[],
): Extract<OsOutputContent, { kind: "document" }> {
	const richText = { type: "doc" as const, content: nodes };
	return { kind: "document", richText, blocks: blocksFromRichText(richText) };
}

describe("document block patches over rich text", () => {
	it("replaces one paragraph without stripping an untouched paragraph's marks or attributes", () => {
		const content = document([paragraph("Original"), formatted]);
		const original = structuredClone(content);
		const patched = applyDocumentBlockPatch(content, [
			{
				op: "replace",
				index: 0,
				block: { type: "paragraph", text: "Changed **first** paragraph" },
			},
		]);
		expect(patched.richText?.content[1]).toEqual(formatted);
		expect(patched.blocks[0]).toEqual({
			type: "paragraph",
			text: "Changed **first** paragraph",
		});
		expect(content).toEqual(original);
	});

	it("retains untouched tables, images, unprojected artwork and attached-file references", () => {
		const table = richTextFromBlocks([
			{
				type: "table",
				headers: ["Name"],
				rows: [["Value"]],
				widths: [240],
				align: ["right"],
			},
		]).content[0]!;
		table.attrs = { borderColor: "#abcdef" };
		const image: OsRichTextNode = {
			type: "image",
			attrs: {
				src: "data:image/png;base64,AA==",
				alt: "Artwork",
				width: 320,
				height: 200,
			},
		};
		const artwork: OsRichTextNode = {
			type: "drawing",
			attrs: { elements: [{ x: 1, y: 2 }] },
		};
		const literal = {
			...paragraph("# Keep this literal heading"),
			attrs: { textAlign: "center" },
		};
		const content = document([
			artwork,
			paragraph("Edit"),
			table,
			image,
			literal,
		]);
		content.file = {
			workspaceId: "11111111-1111-4111-8111-111111111111",
			resourceId: "22222222-2222-4222-8222-222222222222",
		};
		const patched = applyDocumentBlockPatch(content, [
			{ op: "replace", index: 0, block: { type: "paragraph", text: "Edited" } },
		]);
		expect(patched.richText?.content).toEqual([
			artwork,
			paragraph("Edited"),
			table,
			image,
			literal,
		]);
		expect(patched.file).toEqual(content.file);
		expect(patched.blocks).toEqual(blocksFromRichText(patched.richText!));
	});

	it("keeps sequential operation indices on logical blocks when inserted Markdown expands", () => {
		const content = document([paragraph("A"), paragraph("B"), formatted]);
		const patched = applyDocumentBlockPatch(content, [
			{
				op: "insert",
				index: 1,
				block: { type: "paragraph", text: "One\n\nTwo" },
			},
			{
				op: "replace",
				index: 2,
				block: { type: "paragraph", text: "Changed B" },
			},
			{ op: "delete", index: 0 },
			{ op: "insert", index: 3, block: { type: "paragraph", text: "Last" } },
		]);
		expect(patched.richText?.content).toEqual([
			paragraph("One"),
			paragraph("Two"),
			paragraph("Changed B"),
			formatted,
			paragraph("Last"),
		]);
	});

	it("handles empty inserted blocks without shifting a later target", () => {
		const content = document([paragraph("A"), formatted]);
		const patched = applyDocumentBlockPatch(content, [
			{ op: "insert", index: 0, block: { type: "paragraph", text: "" } },
			{
				op: "replace",
				index: 1,
				block: { type: "heading", level: 2, text: "Changed A" },
			},
			{ op: "delete", index: 0 },
		]);
		expect(patched.blocks[0]).toEqual({
			type: "heading",
			level: 2,
			text: "Changed A",
		});
		expect(patched.richText?.content[1]).toEqual(formatted);
	});

	it("does not rebuild a rich node for an unchanged semantic replacement", () => {
		const content = document([formatted]);
		expect(
			applyDocumentBlockPatch(content, [
				{ op: "replace", index: 0, block: content.blocks[0] },
			]),
		).toEqual(content);
	});

	it("rejects ambiguous or truncated stored projections without changing the source", () => {
		const content = document([paragraph("Actual")]);
		content.blocks = [{ type: "paragraph", text: "Stale projection" }];
		const original = structuredClone(content);
		expect(() =>
			applyDocumentBlockPatch(content, [{ op: "delete", index: 0 }]),
		).toThrow("projection does not match");
		expect(content).toEqual(original);
		const truncated = document(
			Array.from({ length: 10_001 }, (_, i) => paragraph(String(i))),
		);
		expect(() =>
			applyDocumentBlockPatch(truncated, [{ op: "delete", index: 0 }]),
		).toThrow("projection does not match");
	});

	it("rejects Markdown expansion beyond the block limit instead of truncating the new projection", () => {
		const content = document(
			Array.from({ length: 9_999 }, (_, i) => paragraph(String(i))),
		);
		expect(() =>
			applyDocumentBlockPatch(content, [
				{
					op: "insert",
					index: 9_999,
					block: { type: "paragraph", text: "One\n\nTwo" },
				},
			]),
		).toThrow("exceeds 10000");
	});

	it("keeps legacy block-only documents editable and rejects later invalid indices atomically", () => {
		const content = {
			kind: "document" as const,
			blocks: [{ type: "paragraph" as const, text: "Original" }],
		};
		const patched = applyDocumentBlockPatch(content, [
			{
				op: "insert",
				index: 1,
				block: { type: "paragraph", text: "## Heading" },
			},
		]);
		expect(patched.blocks[1]).toEqual({
			type: "heading",
			level: 2,
			text: "Heading",
		});
		expect(() =>
			applyDocumentBlockPatch(content, [
				{ op: "delete", index: 0 },
				{
					op: "replace",
					index: 0,
					block: { type: "paragraph", text: "Invalid" },
				},
			]),
		).toThrow("out of range");
		expect(content.blocks[0]?.text).toBe("Original");
	});
});
