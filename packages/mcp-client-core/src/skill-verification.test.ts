import type { McpSkillEntry } from "@tedix/mcp-shared/skills";
import { describe, expect, it } from "vite-plus/test";
import {
	resolveAdvertisedSkill,
	verifySkillResourceRead,
} from "./skill-verification";

const root = "skill://example/guide/SKILL.md";
const support = "skill://example/guide/references/Q%26A.md";
const markdown =
	'---\nname: guide\ndescription: "Read safely"\nmetadata:\n  tags: [one, two]\n---\n\n# Guide\n';
const frontmatter = {
	name: "guide",
	description: "Read safely",
	metadata: { tags: ["one", "two"] },
};

async function manifest(
	files: Record<string, string | Uint8Array> = { [root]: markdown },
): Promise<McpSkillEntry> {
	const resources = [];
	for (const [uri, content] of Object.entries(files)) {
		const bytes =
			typeof content === "string"
				? new TextEncoder().encode(content)
				: new Uint8Array(content);
		const hash = await crypto.subtle.digest("SHA-256", bytes);
		resources.push({
			uri,
			size: bytes.byteLength,
			digest: `sha256:${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
		});
	}
	return { uri: root, frontmatter, resources };
}

function textResult(uri: string, text: string) {
	return { contents: [{ uri, text }] };
}

describe("advertised skill resolution", () => {
	it("resolves root/support fragments and equivalent percent/slash spellings", async () => {
		const skill = await manifest({ [root]: markdown, [support]: "support" });
		for (const uri of [
			root + "#intro",
			support,
			"skill://example/guide/references%2fQ&A.md#faq",
		]) {
			expect(resolveAdvertisedSkill([skill], uri)).toBe(skill);
		}
	});

	it("rejects unlisted static files before a fetch, including encoded paths", async () => {
		const skill = await manifest();
		for (const uri of [
			"skill://example/guide/extra.md",
			"skill://example/guide%2fextra.md",
			"skill://example/guide/nested%2f..%2fextra.md",
		]) {
			expect(() => resolveAdvertisedSkill([skill], uri)).toThrow(
				"unlisted resource",
			);
		}
	});

	it("preserves ordinary resources, sibling paths and nested advertised skills", async () => {
		const skill = await manifest();
		const nested = {
			...skill,
			uri: "skill://example/guide/nested/SKILL.md",
			resources: "dynamic" as const,
		};
		expect(
			resolveAdvertisedSkill([skill], "https://example.com/manual"),
		).toBeUndefined();
		expect(
			resolveAdvertisedSkill([skill], "skill://example/guidelines/file.md"),
		).toBeUndefined();
		expect(
			resolveAdvertisedSkill(
				[{ ...skill, uri: "urn:example:skill", resources: [] }],
				"urn:example:ordinary",
			),
		).toBeUndefined();
		expect(resolveAdvertisedSkill([skill, nested], nested.uri)).toBe(nested);
		expect(
			resolveAdvertisedSkill(
				[skill, nested],
				"skill://example/guide/nested/extra.md",
			),
		).toBe(nested);
	});
});

describe("skill resource verification", () => {
	it("checks exact UTF-8 bytes before any trimming", async () => {
		const text = markdown + "  café\n";
		const skill = await manifest({ [root]: text });
		await expect(
			verifySkillResourceRead(skill, root, textResult(root, text)),
		).resolves.toBeUndefined();
		await expect(
			verifySkillResourceRead(skill, root, textResult(root, text.trim())),
		).rejects.toThrow("size");
	});

	it("checks binary blobs and equivalent returned URI spellings", async () => {
		const bytes = new Uint8Array([0, 255, 1, 128]);
		const skill = await manifest({ [root]: markdown, [support]: bytes });
		await expect(
			verifySkillResourceRead(skill, support + "#part", {
				contents: [
					{
						uri: "skill://example/guide/references/Q&A.md",
						blob: btoa(String.fromCharCode(...bytes)),
					},
				],
			}),
		).resolves.toBeUndefined();
	});

	it("rejects equal-size tampering without echoing secret payloads", async () => {
		const skill = await manifest({ [root]: markdown, [support]: "secret-one" });
		await expect(
			verifySkillResourceRead(
				skill,
				support,
				textResult(support, "secret-two"),
			),
		).rejects.toThrow(/^Skill verification failed: digest$/);
	});

	it.each([
		{ contents: [] },
		{
			contents: [
				{ uri: root, text: markdown },
				{ uri: root, text: "extra instructions" },
			],
		},
	])("rejects missing/extra content parts (%j)", async ({ contents }) => {
		await expect(
			verifySkillResourceRead(await manifest(), root, { contents }),
		).rejects.toThrow("content parts");
	});

	it.each([
		{ uri: "skill://example/other/SKILL.md", text: markdown },
		{ uri: root, text: markdown, blob: "AA==" },
		{ uri: root },
		{ uri: root, blob: "not!base64" },
	])("rejects malformed content (%j)", async (part) => {
		await expect(
			verifySkillResourceRead(await manifest(), root, { contents: [part] }),
		).rejects.toThrow("Skill verification failed:");
	});

	it("checks complete frontmatter regardless of key order", async () => {
		const reordered = markdown.replace(
			'name: guide\ndescription: "Read safely"',
			'description: "Read safely"\nname: guide',
		);
		await expect(
			verifySkillResourceRead(
				await manifest({ [root]: reordered }),
				root,
				textResult(root, reordered),
			),
		).resolves.toBeUndefined();
		const changed = markdown.replace("[one, two]", "[one, secret]");
		await expect(
			verifySkillResourceRead(
				await manifest({ [root]: changed }),
				root,
				textResult(root, changed),
			),
		).rejects.toThrow(/^Skill verification failed: frontmatter$/);
	});

	it("checks dynamic root frontmatter while allowing dynamic supporting bytes", async () => {
		const skill: McpSkillEntry = {
			uri: root,
			frontmatter,
			resources: "dynamic",
		};
		await expect(
			verifySkillResourceRead(
				skill,
				root,
				textResult(root, markdown + "new body"),
			),
		).resolves.toBeUndefined();
		await expect(
			verifySkillResourceRead(
				skill,
				support,
				textResult(support, "new supporting content"),
			),
		).resolves.toBeUndefined();
		await expect(
			verifySkillResourceRead(
				skill,
				root,
				textResult(root, markdown.replace("Read safely", "secret")),
			),
		).rejects.toThrow("frontmatter");
	});

	it("accepts UTF-8 blob roots with BOM/CRLF and rejects missing frontmatter", async () => {
		const text = "\uFEFF" + markdown.replaceAll("\n", "\r\n");
		const bytes = new TextEncoder().encode(text);
		await expect(
			verifySkillResourceRead(await manifest({ [root]: bytes }), root, {
				contents: [{ uri: root, blob: btoa(String.fromCharCode(...bytes)) }],
			}),
		).resolves.toBeUndefined();
		await expect(
			verifySkillResourceRead(
				await manifest({ [root]: "# No metadata" }),
				root,
				textResult(root, "# No metadata"),
			),
		).rejects.toThrow("frontmatter");
	});

	it("accepts equivalent YAML aliases and rejects duplicate keys", async () => {
		const aliased =
			"---\nname: guide\ndescription: Read safely\nfirst: &tags [one, two]\nsecond: *tags\n---\nBody";
		const skill = await manifest({ [root]: aliased });
		skill.frontmatter = {
			name: "guide",
			description: "Read safely",
			first: ["one", "two"],
			second: ["one", "two"],
		};
		await expect(
			verifySkillResourceRead(skill, root, textResult(root, aliased)),
		).resolves.toBeUndefined();
		const duplicate = markdown.replace(
			"name: guide",
			"name: guide\nname: malicious",
		);
		await expect(
			verifySkillResourceRead(
				await manifest({ [root]: duplicate }),
				root,
				textResult(root, duplicate),
			),
		).rejects.toThrow("frontmatter");
	});
});
