import { describe, expect, it } from "vite-plus/test";
import { McpSkillEntrySchema } from "./skills";

const entry = {
	uri: "skill://example/translate/SKILL.md",
	frontmatter: { name: "translate" },
};

describe("SEP-2640 skill manifest schema", () => {
	it("accepts a dynamic resource manifest", () => {
		expect(
			McpSkillEntrySchema.parse({ ...entry, resources: "dynamic" }).resources,
		).toBe("dynamic");
	});

	it("requires complete static resources including UTF-8 byte sizes", () => {
		expect(
			McpSkillEntrySchema.safeParse({
				...entry,
				resources: [
					{
						uri: entry.uri,
						digest: `sha256:${"a".repeat(64)}`,
						size: new TextEncoder().encode("café 🧭").byteLength,
					},
				],
			}).success,
		).toBe(true);
		expect(
			McpSkillEntrySchema.safeParse({
				...entry,
				resources: [{ uri: entry.uri, digest: `sha256:${"a".repeat(64)}` }],
			}).success,
		).toBe(false);
	});
});
