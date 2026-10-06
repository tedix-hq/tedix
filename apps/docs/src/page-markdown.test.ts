/// <reference types="node" />
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@cloudflare/nimbus-docs", () => ({
	getIndexedEntries: () => [],
	renderEntryAsMarkdown: () => "",
}));
vi.mock("virtual:nimbus/config", () => ({
	config: {
		site: "https://docs.example.invalid",
		socialImage: undefined,
	},
}));

const templatePath = "../template/page-markdown";
const { resolveMarkdownPageLinks } = (await import(
	/* @vite-ignore */ templatePath
)) as {
	resolveMarkdownPageLinks: (markdown: string, sourceId: string) => string;
};

describe("Markdown alternate links", () => {
	it("resolves nested page links in authored source space", () => {
		const markdown = [
			"1. [Start](../getting-started.md)",
			"2. [Concepts](../concepts.mdx#workers)",
			"3. [Sibling](advanced.md?mode=cloud#start)",
		].join("\n");

		expect(
			resolveMarkdownPageLinks(markdown, "learning-paths/first-worker"),
		).toBe(
			[
				"1. [Start](/getting-started)",
				"2. [Concepts](/concepts#workers)",
				"3. [Sibling](/learning-paths/advanced?mode=cloud#start)",
			].join("\n"),
		);
	});

	it("resolves reference definitions while preserving link titles", () => {
		expect(
			resolveMarkdownPageLinks(
				'[guide]: ../getting-started.md "Start here"\n[^note]: ../literal.md is footnote text.\n\nRead [the guide][guide].',
				"learning-paths/first-worker",
			),
		).toBe(
			'[guide]: /getting-started "Start here"\n[^note]: ../literal.md is footnote text.\n\nRead [the guide][guide].',
		);
	});

	it("preserves explicit resources and code examples", () => {
		const markdown = [
			"[root](/guide.md)",
			"[external](https://example.invalid/guide.md)",
			"[protocol](//example.invalid/guide.md)",
			"[fragment](#guide)",
			"[asset](./diagram.svg)",
			"`[inline](../guide.md)`",
			"```md",
			"[fenced](../guide.md)",
			"```",
		].join("\n");

		expect(resolveMarkdownPageLinks(markdown, "nested/page")).toBe(markdown);
	});
});
