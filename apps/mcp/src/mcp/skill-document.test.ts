import { parseSkillFrontmatter } from "@tedix/api-contract/utils/skill-manifest";
import { describe, expect, it } from "vite-plus/test";
import { renderSkillMarkdown, type SkillDocumentEntry } from "./skill-document";

const skill: SkillDocumentEntry = {
	id: "skill-1",
	title: "Canonical title",
	slug: "canonical-skill",
	summary: "Canonical summary",
	description: "Canonical description",
	content: [
		"---",
		"name: author-name",
		"description: Author description",
		"license: MIT",
		"compatibility: [linux, macos]",
		"metadata:",
		"  author.example/custom: retained",
		"  io.modelcontextprotocol/tools: [untrusted-tool]",
		"---",
		"",
		"# Body",
	].join("\n"),
	files: null,
	tags: ["tedix-tag"],
	toolIds: ["tool-1"],
	successCount: 0,
	revision: 7,
	appId: null,
	audience: ["assistant"],
	r2Path: null,
	updatedAt: null,
	createdAt: null,
	source: "d1",
};

describe("renderSkillMarkdown author frontmatter", () => {
	it("retains author fields and metadata while Tedix projection wins collisions", () => {
		const rendered = renderSkillMarkdown(
			skill,
			"example",
			new Map([["tool-1", "deploy_widget"]]),
		);
		const frontmatter = parseSkillFrontmatter(rendered);
		expect(frontmatter).toMatchObject({
			name: "canonical-skill",
			description: "Canonical description",
			version: 7,
			license: "MIT",
			compatibility: ["linux", "macos"],
			tags: ["tedix-tag"],
			tools: ["deploy_widget"],
			metadata: {
				"author.example/custom": "retained",
				"io.modelcontextprotocol/tools": ["deploy_widget"],
			},
		});
		expect(rendered).toContain("# Body");
	});

	it("does not trust author-supplied Tedix tool projections", () => {
		const rendered = renderSkillMarkdown(
			{ ...skill, toolIds: [] },
			"example",
			new Map(),
		);
		const frontmatter = parseSkillFrontmatter(rendered);
		expect(frontmatter?.tools).toBeUndefined();
		expect(frontmatter?.metadata).toEqual({
			"author.example/custom": "retained",
		});
	});
});
