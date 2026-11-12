import type { OsRichTextNode } from "@tedix/api-contract/schemas/os-workspaces";
import { describe, expect, it } from "vite-plus/test";
import { richTextToMarkdown } from "./rich-text-markdown";

const text = (value: string, ...marks: (string | [string, object])[]) => ({
	type: "text",
	text: value,
	...(marks.length
		? {
				marks: marks.map((mark) =>
					typeof mark === "string"
						? { type: mark }
						: { type: mark[0], attrs: mark[1] },
				),
			}
		: {}),
});
const p = (...content: object[]) => ({ type: "paragraph", content });
const md = (...content: object[]) =>
	richTextToMarkdown({ type: "doc", content: content as OsRichTextNode[] });

describe("richTextToMarkdown", () => {
	it("keeps headings, bold, italic, strikethrough, code and links", () => {
		expect(
			md(
				{ type: "heading", attrs: { level: 2 }, content: [text("Plan")] },
				p(
					text("Ship "),
					text("on Friday ", "bold"),
					text("or"),
					text(" later", "italic"),
					text(", "),
					text("not now", "strike"),
					text(". Run "),
					text("bun run push", "code"),
					text(" and read "),
					text("the guide", ["link", { href: "https://example.com/a b" }]),
					text("."),
				),
			),
		).toBe(
			"## Plan\n\nShip **on Friday** or *later*, ~~not now~~. Run `bun run push` and read [the guide](https://example.com/a%20b).\n",
		);
	});

	it("writes text that looks like Markdown as text", () => {
		expect(md(p(text("# not a heading, 2 * 3 and [x]")))).toBe(
			"\\# not a heading, 2 \\* 3 and \\[x\\]\n",
		);
		expect(md(p(text("1. not a list")))).toBe("1\\. not a list\n");
	});

	it("keeps nested lists, numbering and to-dos", () => {
		const item = (...content: object[]) => ({ type: "listItem", content });
		expect(
			md(
				{
					type: "bulletList",
					content: [
						item(p(text("One")), {
							type: "orderedList",
							attrs: { start: 3 },
							content: [item(p(text("Three"))), item(p(text("Four")))],
						}),
						item(p(text("Two"))),
					],
				},
				{
					type: "taskList",
					content: [
						{
							type: "taskItem",
							attrs: { checked: true },
							content: [p(text("Done"))],
						},
						{
							type: "taskItem",
							attrs: { checked: false },
							content: [p(text("Open"))],
						},
					],
				},
			),
		).toBe("- One\n  3. Three\n  4. Four\n- Two\n\n- [x] Done\n- [ ] Open\n");
	});

	it("keeps tables, with an empty header row when the table has none", () => {
		const row = (type: string, ...cells: string[]) => ({
			type: "tableRow",
			content: cells.map((value) => ({ type, content: [p(text(value))] })),
		});
		expect(
			md({
				type: "table",
				content: [
					row("tableHeader", "Name", "Owner"),
					row("tableCell", "A|B", "Ada"),
				],
			}),
		).toBe("| Name | Owner |\n| --- | --- |\n| A\\|B | Ada |\n");
		expect(md({ type: "table", content: [row("tableCell", "1", "2")] })).toBe(
			"|  |  |\n| --- | --- |\n| 1 | 2 |\n",
		);
	});

	it("keeps images, quotes, notes, code blocks, dividers and collapsible sections", () => {
		const out = richTextToMarkdown(
			{
				type: "doc",
				content: [
					{ type: "image", attrs: { src: "tedix-asset:abc", alt: "Chart" } },
					{ type: "image", attrs: { src: "tedix-asset:gone", alt: "Lost" } },
					{
						type: "blockquote",
						content: [p(text("Quoted")), p(text("Twice"))],
					},
					{ type: "callout", content: [p(text("Note"))] },
					{
						type: "codeBlock",
						attrs: { language: "ts" },
						content: [text("const a = `x`;\n```")],
					},
					{ type: "horizontalRule" },
					{
						type: "details",
						content: [
							{ type: "detailsSummary", content: [text("More")] },
							{ type: "detailsContent", content: [p(text("Hidden"))] },
						],
					},
				] as OsRichTextNode[],
			},
			(source) =>
				source === "tedix-asset:abc" ? "data:image/png;base64,AAAA" : undefined,
		);
		expect(out).toBe(
			[
				"![Chart](data:image/png;base64,AAAA)",
				"Lost",
				"> Quoted\n>\n> Twice",
				"> Note",
				"````ts\nconst a = `x`;\n```\n````",
				"---",
				"<details>\n<summary>More</summary>\n\nHidden\n\n</details>",
			].join("\n\n") + "\n",
		);
	});

	it("writes an empty document as nothing", () => {
		expect(md(p())).toBe("");
	});
});
