import { describe, expect, it } from "vite-plus/test";
import {
	currentPageMarkdownUrl,
	pageAgentPrompt,
} from "../template/agent-page-handoff";

describe("page-local agent handoff", () => {
	it("uses the current published page for a public site", () => {
		expect(
			currentPageMarkdownUrl(
				"https://docs.example.invalid/learning-paths/first-worker/",
			),
		).toBe("https://docs.example.invalid/learning-paths/first-worker/index.md");
	});

	it("normalizes a published index.html URL to its Markdown sibling", () => {
		expect(
			currentPageMarkdownUrl(
				"https://docs.example.invalid/learning-paths/first-worker/index.html",
			),
		).toBe("https://docs.example.invalid/learning-paths/first-worker/index.md");
	});

	it("keeps an organization-protected handoff on its current tenant host", () => {
		expect(
			currentPageMarkdownUrl("https://internal.example.invalid/runbook/"),
		).toBe("https://internal.example.invalid/runbook/index.md");
	});

	it("keeps a private preview handoff in the preview and drops access parameters", () => {
		const markdownUrl = currentPageMarkdownUrl(
			"https://docs-admin.example.invalid/preview/build-1/guide/?org=acme&expires=123&signature=secret#step",
		);

		expect(markdownUrl).toBe(
			"https://docs-admin.example.invalid/preview/build-1/guide/index.md",
		);
		expect(markdownUrl).not.toContain("docs.example.invalid/guide");
		expect(markdownUrl).not.toContain("org=acme");
		expect(markdownUrl).not.toContain("expires=123");
		expect(markdownUrl).not.toContain("secret");
	});

	it("normalizes a private preview index.html URL inside that preview", () => {
		expect(
			currentPageMarkdownUrl(
				"https://docs-admin.example.invalid/preview/build-1/guide/index.html?org=acme&signature=secret",
			),
		).toBe("https://docs-admin.example.invalid/preview/build-1/guide/index.md");
	});

	it("describes access neutrally and keeps explicit authority limits", () => {
		const markdownUrl = "https://internal.example.invalid/runbook/index.md";
		const prompt = pageAgentPrompt(markdownUrl);

		expect(prompt).toContain(markdownUrl);
		expect(prompt).toContain("if you can access it");
		expect(prompt).toContain("organization-protected");
		expect(prompt).toContain("private preview");
		expect(prompt).toContain("grants no additional access");
		expect(prompt).toContain("does not authorize any change");
		expect(prompt).not.toContain("public reference material");
	});
});
