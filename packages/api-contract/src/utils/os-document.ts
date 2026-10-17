import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import type {
	OsDocumentBlock,
	OsRichTextDocument,
	OsRichTextNode,
	OsOutputContent,
} from "../schemas/os-workspaces";
type DocumentContent = Extract<OsOutputContent, { kind: "document" }>;
function textNode(text: string): OsRichTextNode[] {
	return text ? [{ type: "text", text }] : [];
}

/** Upgrade the stable block projection to the editor's Tiptap document. */
export function richTextFromBlocks(
	blocks: readonly OsDocumentBlock[],
): OsRichTextDocument {
	return {
		type: "doc",
		content: blocks.map((block): OsRichTextNode => {
			switch (block.type) {
				case "heading":
					return {
						type: "heading",
						attrs: { level: block.level },
						content: inlineMarkdown(block.text),
					};
				case "paragraph":
					return { type: "paragraph", content: inlineMarkdown(block.text) };
				case "list":
					return {
						type: block.ordered ? "orderedList" : "bulletList",
						content: block.items.map((item) => ({
							type: "listItem",
							content: markdownDocument(item).content,
						})),
					};
				case "code":
					return {
						type: "codeBlock",
						attrs: { language: block.language ?? null },
						content: textNode(block.text),
					};
				case "table":
					return {
						type: "table",
						content: [block.headers, ...block.rows].map((row, index) => ({
							type: "tableRow",
							content: block.headers.map((_, col) => ({
								type: index === 0 ? "tableHeader" : "tableCell",
								attrs: {
									colwidth: block.widths?.[col] ? [block.widths[col]!] : null,
								},
								content: [
									{
										type: "paragraph",
										attrs: { textAlign: block.align?.[col] ?? "left" },
										content: inlineMarkdown(row[col] ?? ""),
									},
								],
							})),
						})),
					};
				case "divider":
					return { type: "horizontalRule" };
				case "callout":
					return {
						type: "callout",
						content: markdownDocument(block.text).content,
					};
				case "toggle":
					return {
						type: "details",
						content: [
							{ type: "detailsSummary", content: textNode(block.summary) },
							{
								type: "detailsContent",
								content: markdownDocument(block.text).content,
							},
						],
					};
				case "checklist":
					return {
						type: "taskList",
						content: block.items.map((item) => ({
							type: "taskItem",
							attrs: { checked: item.checked },
							content: [
								{ type: "paragraph", content: inlineMarkdown(item.text) },
							],
						})),
					};
				case "quote":
					return {
						type: "blockquote",
						content: [{ type: "paragraph", content: textNode(block.text) }],
					};
			}
		}),
	};
}

function markedText(node: OsRichTextNode): string {
	let value = node.text ?? (node.content ?? []).map(markedText).join("");
	for (const mark of node.marks ?? []) {
		switch (mark.type) {
			case "bold":
				value = `**${value}**`;
				break;
			case "italic":
				value = `_${value}_`;
				break;
			case "strike":
				value = `~~${value}~~`;
				break;
			case "code":
				value = `\`${value}\``;
				break;
			case "link": {
				const href = mark.attrs?.href;
				if (typeof href === "string") value = `[${value}](${href})`;
				break;
			}
		}
	}
	return value;
}

function nodeText(node: OsRichTextNode): string {
	return node.text ?? (node.content ?? []).map(markedText).join("");
}

function listItemText(item: OsRichTextNode): string {
	return (item.content ?? [])
		.map((child) => {
			if (child.type === "bulletList" || child.type === "orderedList")
				return (child.content ?? [])
					.map(
						(nested, index) =>
							`  ${child.type === "orderedList" ? `${index + 1}.` : "-"} ${listItemText(nested).replace(/\n/g, "\n  ")}`,
					)
					.join("\n");
			return nodeText(child);
		})
		.join("\n");
}

/** Project rich editor JSON back to the stable headless block vocabulary. */
export function blocksFromRichText(
	document: OsRichTextDocument,
): OsDocumentBlock[] {
	const blocks: OsDocumentBlock[] = [];
	for (const node of document.content) {
		switch (node.type) {
			case "table": {
				const rows = node.content ?? [];
				const cells = (row: OsRichTextNode) =>
					(row.content ?? []).map(nodeText);
				const first = rows[0];
				blocks.push({
					type: "table",
					headers: first ? cells(first) : [""],
					rows: rows.slice(1).map(cells),
					align: (first?.content ?? []).map((cell) => {
						const align = cell.content?.[0]?.attrs?.textAlign;
						return align === "center" || align === "right" ? align : "left";
					}),
					...(first?.content?.every(
						(cell) =>
							Array.isArray(cell.attrs?.colwidth) &&
							Number(cell.attrs.colwidth[0]) >= 40,
					)
						? {
								widths: first.content.map((cell) =>
									Number((cell.attrs!.colwidth as number[])[0]),
								),
							}
						: {}),
				});
				break;
			}
			case "taskList":
				blocks.push({
					type: "checklist",
					items: (node.content ?? []).map((item) => ({
						text: nodeText(item),
						checked: item.attrs?.checked === true,
					})),
				});
				break;
			case "callout":
				blocks.push({ type: "callout", text: nodeText(node) });
				break;
			case "details":
				blocks.push({
					type: "toggle",
					summary: nodeText(node.content?.[0] ?? { type: "text" }),
					text: nodeText(node.content?.[1] ?? { type: "text" }),
				});
				break;
			case "heading":
				blocks.push({
					type: "heading",
					level: Math.min(4, Math.max(1, Number(node.attrs?.level) || 2)),
					text: nodeText(node).slice(0, 2_000),
				});
				break;
			case "bulletList":
			case "orderedList":
				blocks.push({
					type: "list",
					ordered: node.type === "orderedList",
					items: (node.content ?? []).map(listItemText).slice(0, 200),
				});
				break;
			case "codeBlock":
				blocks.push({
					type: "code",
					...(typeof node.attrs?.language === "string"
						? { language: node.attrs.language }
						: {}),
					text: nodeText(node).slice(0, 40_000),
				});
				break;
			case "blockquote":
				blocks.push({
					type: "quote",
					text: nodeText(node).slice(0, 20_000),
				});
				break;
			case "image": {
				const src = node.attrs?.src;
				const alt =
					typeof node.attrs?.alt === "string"
						? node.attrs.alt.slice(0, 2_000)
						: "Image";
				// This is a semantic projection, not a second binary image store.
				// Embedding data URLs here violates paragraph limits and duplicates media.
				const url =
					typeof src === "string" &&
					/^https?:\/\//i.test(src) &&
					src.length <= 2_048
						? src
						: null;
				blocks.push({
					type: "paragraph",
					text: url ? `![${alt}](${url})` : `[Image: ${alt}]`,
				});
				break;
			}
			case "horizontalRule":
				blocks.push({ type: "divider" });
				break;
			default: {
				const text = nodeText(node);
				if (text || node.type === "paragraph") {
					blocks.push({ type: "paragraph", text: text.slice(0, 20_000) });
				}
			}
		}
	}
	return blocks.slice(0, 500);
}

export function normalizeDocumentContent(
	content: DocumentContent,
): DocumentContent {
	return content.richText
		? content
		: { ...content, richText: richTextFromBlocks(content.blocks) };
}

type MarkdownNode = {
	type: string;
	value?: string;
	depth?: number;
	lang?: string | null;
	url?: string;
	alt?: string | null;
	ordered?: boolean | null;
	start?: number | null;
	checked?: boolean | null;
	align?: ("left" | "center" | "right" | null)[] | null;
	children?: MarkdownNode[];
};
function convertMarkdown(node: MarkdownNode): OsRichTextNode[] {
	const children = () => (node.children ?? []).flatMap(convertMarkdown);
	switch (node.type) {
		case "text":
			return textNode(node.value ?? "");
		case "inlineCode":
			return [
				{ type: "text", text: node.value ?? "", marks: [{ type: "code" }] },
			];
		case "strong":
		case "emphasis":
		case "delete":
		case "link": {
			const mark =
				node.type === "link"
					? { type: "link", attrs: { href: node.url ?? "" } }
					: {
							type:
								node.type === "strong"
									? "bold"
									: node.type === "emphasis"
										? "italic"
										: "strike",
						};
			return children().map((child) => ({
				...child,
				marks: [...(child.marks ?? []), mark],
			}));
		}
		case "heading":
			return [
				{
					type: "heading",
					attrs: { level: Math.min(4, node.depth ?? 2) },
					content: children(),
				},
			];
		case "paragraph": {
			const nodes: OsRichTextNode[] = [];
			for (const child of children()) {
				if (child.type === "image") nodes.push(child);
				else {
					if (nodes.at(-1)?.type !== "paragraph")
						nodes.push({ type: "paragraph", content: [] });
					nodes.at(-1)!.content!.push(child);
				}
			}
			return nodes.length ? nodes : [{ type: "paragraph", content: [] }];
		}
		case "break":
			return [{ type: "hardBreak" }];
		case "thematicBreak":
			return [{ type: "horizontalRule" }];
		case "code":
			return [
				{
					type: "codeBlock",
					attrs: { language: node.lang ?? null },
					content: textNode(node.value ?? ""),
				},
			];
		case "image":
			return [
				{ type: "image", attrs: { src: node.url ?? "", alt: node.alt ?? "" } },
			];
		case "blockquote":
			return [{ type: "blockquote", content: children() }];
		case "list": {
			const items = node.children ?? [];
			// Split mixed task and ordinary items so both have valid editor schemas.
			const groups: OsRichTextNode[] = [];
			for (const item of items) {
				const task = typeof item.checked === "boolean";
				const type = task
					? "taskList"
					: node.ordered
						? "orderedList"
						: "bulletList";
				if (groups.at(-1)?.type !== type)
					groups.push({
						type,
						attrs: type === "orderedList" ? { start: node.start ?? 1 } : {},
						content: [],
					});
				groups.at(-1)!.content!.push({
					type: task ? "taskItem" : "listItem",
					...(task ? { attrs: { checked: item.checked! } } : {}),
					content: (item.children ?? []).flatMap(convertMarkdown),
				});
			}
			return groups;
		}
		case "table":
			return [
				{
					type: "table",
					content: (node.children ?? []).map((row, index) => ({
						type: "tableRow",
						content: (row.children ?? []).map((cell, col) => ({
							type: index === 0 ? "tableHeader" : "tableCell",
							content: [
								{
									type: "paragraph",
									attrs: { textAlign: node.align?.[col] ?? "left" },
									content: (cell.children ?? []).flatMap(convertMarkdown),
								},
							],
						})),
					})),
				},
			];
		// Raw HTML stays visible text; ingestion never executes agent-authored HTML.
		case "html":
			return [{ type: "paragraph", content: textNode(node.value ?? "") }];
		default:
			return children();
	}
}
export function markdownDocument(markdown: string): OsRichTextDocument {
	return {
		type: "doc",
		content: convertMarkdown(
			fromMarkdown(markdown, {
				extensions: [gfm()],
				mdastExtensions: [gfmFromMarkdown()],
			}),
		),
	};
}
function inlineMarkdown(text: string): OsRichTextNode[] {
	const doc = markdownDocument(text);
	return doc.content.length === 1 && doc.content[0]?.type === "paragraph"
		? (doc.content[0].content ?? [])
		: textNode(text);
}
export function normalizeOsOutputInput(
	input: OsOutputContent | string,
): OsOutputContent {
	if (typeof input === "string") {
		const richText = markdownDocument(input);
		return { kind: "document", richText, blocks: blocksFromRichText(richText) };
	}
	if (input.kind !== "document") return input;
	if (input.richText) {
		let changed = false;
		const expand = (node: OsRichTextNode): OsRichTextNode[] => {
			if (node.type === "codeBlock") return [node];
			if (
				node.type === "paragraph" &&
				node.content?.every(
					(child) => child.type === "text" && !child.marks?.length,
				)
			) {
				const text = node.content.map((child) => child.text ?? "").join("");
				if (/^#{1,4}\s|^\s*\|.+\|\s*$|^[-*] \[[ xX]\]/m.test(text)) {
					changed = true;
					return markdownDocument(text).content;
				}
			}
			return [
				{
					...node,
					...(node.content ? { content: node.content.flatMap(expand) } : {}),
				},
			];
		};
		const richText: OsRichTextDocument = {
			type: "doc",
			content: input.richText.content.flatMap(expand),
		};
		return changed
			? { ...input, richText, blocks: blocksFromRichText(richText) }
			: input;
	}
	const richText: OsRichTextDocument = {
		type: "doc",
		content: input.blocks.flatMap((block) =>
			block.type === "paragraph"
				? markdownDocument(block.text).content
				: richTextFromBlocks([block]).content,
		),
	};
	return { ...input, richText, blocks: blocksFromRichText(richText) };
}

export function documentBlockText(block: OsDocumentBlock): string[] {
	switch (block.type) {
		case "list":
			return block.items;
		case "table":
			return [
				block.headers.join(" · "),
				...block.rows.map((row) => row.join(" · ")),
			];
		case "checklist":
			return block.items.map(
				(item) => `${item.checked ? "[x]" : "[ ]"} ${item.text}`,
			);
		case "divider":
			return ["---"];
		case "toggle":
			return [block.summary, block.text];
		default:
			return [block.text];
	}
}
