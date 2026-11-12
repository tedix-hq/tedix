import type {
	OsRichTextDocument,
	OsRichTextNode,
} from "@tedix/api-contract/schemas/os-workspaces";

/**
 * A document as Markdown, written from the rich text the editor shows, so
 * bold, links, nested lists, to-dos, tables and images are kept. Colour,
 * size, underline and alignment have no Markdown form and become plain text.
 *
 * `image` gives the address to write for a picture; a picture stored with
 * the file has none a reader could open, so its caller passes an embedded
 * copy. Without one the picture's description is written.
 */
export function richTextToMarkdown(
	doc: OsRichTextDocument,
	image: (source: string) => string | undefined = (source) => source,
): string {
	const escape = (text: string) =>
		text
			.replace(/[\\`*_[\]<>]/g, "\\$&")
			.replace(/^(\s*)([#+-])(?=\s)/gm, "$1\\$2")
			.replace(/^(\s*\d+)([.)])(?=\s)/gm, "$1\\$2");
	const picture = (node: OsRichTextNode) => {
		const alt = String(node.attrs?.alt ?? "").replace(/[[\]]/g, ""),
			source = image(String(node.attrs?.src ?? ""));
		return source ? `![${alt}](${source})` : alt;
	};
	const inline = (nodes: OsRichTextNode[] = []): string =>
		nodes
			.map((node) => {
				if (node.type === "hardBreak") return "\\\n";
				if (node.type === "image") return picture(node);
				if (node.type !== "text") return inline(node.content);
				const marks = new Map(
					(node.marks ?? []).map((mark) => [mark.type, mark.attrs]),
				);
				const text = node.text ?? "";
				// Emphasis may not start or end with a space.
				const [, lead, body, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
				if (!body) return text;
				let out: string;
				if (marks.has("code")) {
					const fence = "`".repeat(
						Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length)) +
							1,
					);
					const pad = /^`|`$/.test(body) ? " " : "";
					out = fence + pad + body + pad + fence;
				} else out = escape(body);
				if (marks.has("strike")) out = `~~${out}~~`;
				if (marks.has("italic")) out = `*${out}*`;
				if (marks.has("bold")) out = `**${out}**`;
				const href = marks.get("link")?.href;
				if (typeof href === "string")
					out = `[${out}](${href.replace(/[()\s]/g, encodeURIComponent)})`;
				return lead + out + trail;
			})
			.join("");
	const indent = (text: string, first: string) =>
		first + text.replace(/\n(?=.)/g, "\n" + " ".repeat(first.length));
	const list = (node: OsRichTextNode): string =>
		(node.content ?? [])
			.map((item, index) =>
				indent(
					blocks(item.content, "\n"),
					node.type === "orderedList"
						? `${Number(node.attrs?.start ?? 1) + index}. `
						: node.type === "taskList"
							? `- [${item.attrs?.checked ? "x" : " "}] `
							: "- ",
				),
			)
			.join("\n");
	const cell = (node: OsRichTextNode) =>
		(node.content ?? [])
			.map((part) =>
				part.type === "paragraph" ? inline(part.content) : block(part),
			)
			.join("<br>")
			.replace(/\|/g, "\\|")
			.replace(/\\?\n/g, "<br>");
	const table = (node: OsRichTextNode) => {
		const rows = (node.content ?? []).map((row) => row.content ?? []);
		if (!rows.length) return "";
		const width = Math.max(...rows.map((row) => row.length));
		const line = (cells: string[]) =>
			`| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
		// Markdown has no table without a header row: write an empty one.
		const headed = rows[0]!.every((item) => item.type === "tableHeader");
		return [
			line(headed ? rows[0]!.map(cell) : []),
			line(Array.from({ length: width }, () => "---")),
			...rows.slice(headed ? 1 : 0).map((row) => line(row.map(cell))),
		].join("\n");
	};
	const quote = (text: string) =>
		text.replace(/^/gm, "> ").replace(/^> $/gm, ">");
	function block(node: OsRichTextNode): string {
		switch (node.type) {
			case "heading":
				return `${"#".repeat(Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1))))} ${inline(node.content).replace(/\\?\n/g, " ")}`;
			case "bulletList":
			case "orderedList":
			case "taskList":
				return list(node);
			case "blockquote":
			case "callout":
				return quote(blocks(node.content));
			case "codeBlock": {
				const text = (node.content ?? [])
					.map((part) => part.text ?? "")
					.join("");
				const fence = "`".repeat(
					Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length)) +
						1,
				);
				return `${fence}${String(node.attrs?.language ?? "")}\n${text}\n${fence}`;
			}
			case "horizontalRule":
				return "---";
			case "image":
				return picture(node);
			case "table":
				return table(node);
			case "details": {
				const [summary, ...rest] = node.content ?? [];
				return `<details>\n<summary>${inline(summary?.content)}</summary>\n\n${blocks(rest.flatMap((part) => part.content ?? []))}\n\n</details>`;
			}
			case "paragraph":
				return inline(node.content);
			default:
				return node.content?.some((part) => part.type === "text")
					? inline(node.content)
					: blocks(node.content);
		}
	}
	function blocks(nodes: OsRichTextNode[] = [], gap = "\n\n"): string {
		return nodes
			.map(block)
			.filter(
				(text, index, all) => text || (index > 0 && index < all.length - 1),
			)
			.join(gap);
	}
	const text = blocks(doc.content)
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return text ? text + "\n" : "";
}
