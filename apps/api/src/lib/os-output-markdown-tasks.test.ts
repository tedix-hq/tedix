import {
	markdownDocument,
	normalizeOsOutputInput,
} from "@tedix/api-contract/utils/os-document";
import { describe, expect, it } from "vite-plus/test";
import { renderOsDocumentMarkdown } from "./os-output-markdown";

const continuations = [
	{ name: "second paragraph", lines: ["Second paragraph"] },
	{ name: "hard break", lines: ["Second line  ", "Third line"] },
	{
		name: "nested bullet list",
		lines: ["- Bullet one", "  ", "  Bullet continuation", "- Bullet two"],
	},
	{
		name: "nested ordered list",
		lines: [
			"9. Ordered nine",
			"   ",
			"   Ordered continuation",
			"10. Ordered ten",
		],
	},
	{
		name: "nested task list",
		lines: ["- [ ] Child one", "  ", "  Child continuation", "- [x] Child two"],
	},
	{
		name: "fenced code block",
		lines: ["````ts", "  const value = `code`;", "", "```", "````"],
	},
];

describe("Markdown task continuations", () => {
	for (const checked of [false, true]) {
		for (const { name, lines } of continuations) {
			it(`keeps ${name} attached to ${checked ? "a checked" : "an unchecked"} item`, () => {
				const expected = [
					`- [${checked ? "x" : " "}] First line  `,
					"  Hard break continuation",
					"  ",
					...lines.map((line) => `  ${line}`),
					`- [${checked ? " " : "x"}] Next item`,
					"",
				].join("\n");
				const content = normalizeOsOutputInput(expected);
				if (content.kind !== "document") throw new Error("Expected document");
				expect(content.richText?.content.map((node) => node.type)).toEqual([
					"taskList",
				]);
				expect(
					content.richText?.content[0]?.content?.map(
						(item) => item.attrs?.checked,
					),
				).toEqual([checked, !checked]);
				const markdown = renderOsDocumentMarkdown(content);
				expect(markdown).toBe(expected);
				expect(markdownDocument(markdown)).toEqual(content.richText);
			});
		}
	}

	it("retains mixed blocks and deeply nested lists in order", () => {
		const expected = [
			"- [x] First paragraph",
			"  ",
			"  Second paragraph",
			"  ",
			"  - Bullet",
			"    ",
			"    3. Ordered",
			"       ",
			"       - [ ] Nested task",
			"         ",
			"         ```js",
			"         const answer = 42;",
			"         ```",
			"  ",
			"  After nested lists",
			"- [ ] Sibling",
			"  ",
			"  Sibling continuation",
			"",
		].join("\n");
		const content = normalizeOsOutputInput(expected);
		if (content.kind !== "document") throw new Error("Expected document");
		const markdown = renderOsDocumentMarkdown(content);
		expect(markdown).toBe(expected);
		expect(markdownDocument(markdown)).toEqual(content.richText);
	});

	it("indents sanitized HTML fallbacks inside a task continuation", () => {
		const content = normalizeOsOutputInput({
			kind: "document",
			blocks: [],
			richText: {
				type: "doc",
				content: [
					{
						type: "taskList",
						content: [
							{
								type: "taskItem",
								attrs: { checked: true },
								content: [
									{
										type: "paragraph",
										content: [{ type: "text", text: "First" }],
									},
									{
										type: "paragraph",
										content: [
											{
												type: "text",
												text: "Styled <unsafe>",
												marks: [{ type: "underline" }],
											},
										],
									},
								],
							},
						],
					},
				],
			},
		});
		if (content.kind !== "document") throw new Error("Expected document");
		expect(renderOsDocumentMarkdown(content)).toBe(
			"- [x] First\n  \n  <u>Styled &lt;unsafe&gt;</u>\n",
		);
	});

	it("retains ordinary list output beside task items", () => {
		const content = normalizeOsOutputInput(
			"- Ordinary\n\n  Continuation\n\n  4. Nested\n\n- [x] Task\n\n  Task continuation\n",
		);
		if (content.kind !== "document") throw new Error("Expected document");
		const markdown = renderOsDocumentMarkdown(content);
		expect(markdown).toBe(
			"- Ordinary\n  \n  Continuation\n  \n  4. Nested\n\n- [x] Task\n  \n  Task continuation\n",
		);
		expect(markdownDocument(markdown)).toEqual(content.richText);
	});
});
