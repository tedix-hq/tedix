import type {
	OsOutputContent,
	OsRichTextNode,
} from "@tedix/api-contract/schemas/os-workspaces";
import { renderRichTextNode } from "./os-output-html";

function escapeMarkdown(text: string): string {
	return text
		.replace(/[\\`*_[\]<>~#|]/g, "\\$&")
		.replace(/^(\s*)([-+] |\d+[.)] )/gm, "$1\\$2");
}

function plainText(node: OsRichTextNode): string {
	return node.text ?? (node.content ?? []).map(plainText).join("");
}

function markdownNode(node: OsRichTextNode): string {
	if (node.type === "text") {
		// Markdown has no equivalent for these marks. Keep their sanitized HTML.
		if (
			node.marks?.some((mark) =>
				["underline", "highlight", "textStyle"].includes(mark.type),
			)
		)
			return renderRichTextNode(node);
		let text = escapeMarkdown(node.text ?? "");
		for (const mark of [...(node.marks ?? [])].sort(
			(left, right) =>
				Number(right.type === "code") - Number(left.type === "code"),
		)) {
			switch (mark.type) {
				case "bold":
					text = `**${text}**`;
					break;
				case "italic":
					text = `*${text}*`;
					break;
				case "strike":
					text = `~~${text}~~`;
					break;
				case "code": {
					const raw = node.text ?? "";
					const fence = "`".repeat(
						Math.max(
							0,
							...(raw.match(/`+/g) ?? []).map((value) => value.length),
						) + 1,
					);
					text = `${fence} ${raw} ${fence}`;
					break;
				}
				case "link": {
					const href = mark.attrs?.href;
					if (typeof href === "string" && /^(https?:\/\/|mailto:)/i.test(href))
						text = `[${text}](<${href.replace(/[<>\r\n]/g, (character) => encodeURIComponent(character))}>)`;
					break;
				}
			}
		}
		return text;
	}
	const children = (node.content ?? []).map(markdownNode).join("");
	switch (node.type) {
		case "doc":
			return children;
		case "heading":
			return `${"#".repeat(Math.min(6, Math.max(1, Math.trunc(Number(node.attrs?.level) || 2))))} ${children}\n\n`;
		case "paragraph":
			return `${children}\n\n`;
		case "hardBreak":
			return "  \n";
		case "horizontalRule":
			return "---\n\n";
		case "blockquote":
			return `${children
				.trimEnd()
				.split("\n")
				.map((line) => `> ${line}`)
				.join("\n")}\n\n`;
		case "bulletList":
		case "orderedList": {
			const start = Number(node.attrs?.start) || 1;
			return `${(node.content ?? [])
				.map((item, index) => {
					const prefix =
						node.type === "orderedList" ? `${start + index}. ` : "- ";
					return markdownNode(item)
						.trimEnd()
						.split("\n")
						.map(
							(line, row) =>
								`${row === 0 ? prefix : " ".repeat(prefix.length)}${line}`,
						)
						.join("\n");
				})
				.join("\n")}\n\n`;
		}
		case "codeBlock": {
			const raw = plainText(node);
			const fence = "`".repeat(
				Math.max(2, ...(raw.match(/`+/g) ?? []).map((value) => value.length)) +
					1,
			);
			const language = String(node.attrs?.language ?? "").replace(
				/[^\w+-]/g,
				"",
			);
			return `${fence}${language}\n${raw}\n${fence}\n\n`;
		}
		case "image":
			return `${renderRichTextNode(node)}\n\n`;
		default:
			return children;
	}
}

export function renderOsDocumentMarkdown(
	content: Extract<OsOutputContent, { kind: "document" }>,
): string {
	if (content.richText) return markdownNode(content.richText).trimEnd() + "\n";
	return (
		content.blocks
			.map((block) => {
				switch (block.type) {
					case "heading":
						return `${"#".repeat(block.level)} ${escapeMarkdown(block.text)}\n\n`;
					case "paragraph":
						return `${escapeMarkdown(block.text)}\n\n`;
					case "quote":
						return `${escapeMarkdown(block.text)
							.split("\n")
							.map((line) => `> ${line}`)
							.join("\n")}\n\n`;
					case "list":
						return `${block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : "-"} ${escapeMarkdown(item)}`).join("\n")}\n\n`;
					case "code":
						return markdownNode({
							type: "codeBlock",
							attrs: { language: block.language ?? "" },
							content: [{ type: "text", text: block.text }],
						});
				}
			})
			.join("")
			.trimEnd() + "\n"
	);
}
