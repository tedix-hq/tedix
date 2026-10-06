import { fromMarkdown } from "mdast-util-from-markdown";
import { OsOutputContentSchema } from "@tedix/api-contract/schemas/os-workspaces";
import type {
	OsDocumentBlock,
	OsOutputContent,
	OsRichTextNode,
} from "@tedix/api-contract/schemas/os-workspaces";

type Node = {
	type: string;
	value?: string;
	depth?: number;
	ordered?: boolean | null;
	url?: string;
	lang?: string | null;
	children?: Node[];
	position?: { start: { offset?: number }; end: { offset?: number } };
};

/** Never replace an existing import (including user edits) by title alone. */
export async function refreshSupplierImport(
	current: { content: OsOutputContent; revision: number },
	content: Extract<OsOutputContent, { kind: "document" }>,
	refresh: boolean,
	revise: (update: {
		content: OsOutputContent;
		expectedRevision: number;
	}) => Promise<unknown>,
): Promise<void> {
	if (
		JSON.stringify(OsOutputContentSchema.parse(current.content)) ===
		JSON.stringify(OsOutputContentSchema.parse(content))
	)
		return;
	if (!refresh)
		throw new Error(
			"The saved supplier folder differs from these files. Your saved document was not changed. To replace it with the current fixture files, close its editor and rerun with --refresh-import. This replaces saved edits; otherwise use a different workspace and folder title.",
		);
	await revise({ content, expectedRevision: current.revision });
}

/** Convert the example's Markdown to the native editor format, without HTML. */
export function supplierDocument(
	markdown: string,
): Extract<OsOutputContent, { kind: "document" }> {
	const original = (node: Node) =>
		markdown.slice(node.position?.start.offset, node.position?.end.offset);
	function inline(node: Node): OsRichTextNode[] {
		if (node.type === "text" || node.type === "html")
			return [{ type: "text", text: node.value ?? "" }];
		if (node.type === "break") return [{ type: "hardBreak" }];
		if (node.type === "inlineCode")
			return [
				{ type: "text", text: node.value ?? "", marks: [{ type: "code" }] },
			];
		const children = (node.children ?? []).flatMap(inline);
		const mark =
			node.type === "strong"
				? "bold"
				: node.type === "emphasis"
					? "italic"
					: null;
		if (mark)
			return children.map((child) =>
				child.type === "text"
					? { ...child, marks: [...(child.marks ?? []), { type: mark }] }
					: child,
			);
		if (node.type === "link" && /^https?:\/\//i.test(node.url ?? ""))
			return children.map((child) =>
				child.type === "text"
					? {
							...child,
							marks: [
								...(child.marks ?? []),
								{ type: "link", attrs: { href: node.url! } },
							],
						}
					: child,
			);
		return [{ type: "text", text: original(node) }];
	}
	function block(node: Node): OsRichTextNode {
		if (node.type === "heading")
			return {
				type: "heading",
				attrs: { level: Math.min(4, node.depth ?? 2) },
				content: (node.children ?? []).flatMap(inline),
			};
		if (node.type === "paragraph")
			return {
				type: "paragraph",
				content: (node.children ?? []).flatMap(inline),
			};
		if (node.type === "list")
			return {
				type: node.ordered ? "orderedList" : "bulletList",
				content: (node.children ?? []).map(block),
			};
		if (node.type === "listItem" || node.type === "blockquote")
			return {
				type: node.type === "listItem" ? "listItem" : "blockquote",
				content: (node.children ?? []).map(block),
			};
		if (node.type === "code")
			return {
				type: "codeBlock",
				attrs: { language: node.lang ?? null },
				content: node.value ? [{ type: "text", text: node.value }] : [],
			};
		if (node.type === "thematicBreak") return { type: "horizontalRule" };
		return {
			type: "paragraph",
			content: [{ type: "text", text: original(node) }],
		};
	}
	const content = fromMarkdown(markdown).children.map(block);
	function text(node: OsRichTextNode): string {
		return node.type === "hardBreak"
			? "\n"
			: (node.text ?? (node.content ?? []).map(text).join(""));
	}
	const blocks = content.map((node): OsDocumentBlock => {
		if (node.type === "heading")
			return {
				type: "heading",
				level: Number(node.attrs?.level),
				text: text(node),
			};
		if (node.type === "bulletList" || node.type === "orderedList")
			return {
				type: "list",
				ordered: node.type === "orderedList",
				items: (node.content ?? []).map(text),
			};
		if (node.type === "codeBlock")
			return {
				type: "code",
				...(typeof node.attrs?.language === "string"
					? { language: node.attrs.language }
					: {}),
				text: text(node),
			};
		if (node.type === "blockquote") return { type: "quote", text: text(node) };
		return {
			type: "paragraph",
			text: node.type === "horizontalRule" ? "---" : text(node),
		};
	});
	return { kind: "document", blocks, richText: { type: "doc", content } };
}
