import { parseSkillFrontmatter } from "@tedix/api-contract/utils/skill-manifest";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import type { McpSkillEntry } from "@tedix/mcp-shared/skills";

/** Skill row projected into MCP resources and discovery indexes. */
export interface SkillDocumentEntry {
	id: string;
	title: string;
	slug: string | null;
	summary: string | null;
	description: string | null;
	content: string;
	files: Record<string, string> | null;
	tags: string[] | null;
	toolIds: string[] | null;
	successCount: number;
	revision: number;
	appId: string | null;
	audience: string[] | null;
	r2Path: string | null;
	updatedAt: string | null;
	createdAt: string | null;
	source: "d1";
	/** Guidance skills from aggregated apps override the serving app slug. */
	appSlugOverride?: string | null;
}

const MCP_SKILL_TOOL_METADATA_KEY = "io.modelcontextprotocol/tools";
export const MCP_SKILL_MAX_RESOURCES = 512;
export const MCP_SKILL_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export class SkillResourceLimitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SkillResourceLimitError";
	}
}

export function computeSkillPath(
	skill: SkillDocumentEntry,
	appSlug: string | null,
): string {
	const slug = skill.slug ?? skill.id;
	const effectiveSlug = skill.appSlugOverride ?? appSlug;
	return skill.appId && effectiveSlug ? `${effectiveSlug}/${slug}` : slug;
}

function stripSkillFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return content;
	let body = content.slice(end + "\n---".length);
	if (body.startsWith("\r\n")) body = body.slice(2);
	else if (body.startsWith("\n")) body = body.slice(1);
	return body.trimStart();
}

export function skillToolNames(
	skill: SkillDocumentEntry,
	uuidToToolId: Map<string, string>,
): string[] {
	return [
		...new Set((skill.toolIds ?? []).map((id) => uuidToToolId.get(id) ?? id)),
	].filter(Boolean);
}

export function renderSkillMarkdown(
	skill: SkillDocumentEntry,
	appSlug: string | null,
	uuidToToolId: Map<string, string>,
): string {
	const slug = skill.slug ?? skill.id;
	const skillAudience = skill.audience ?? ["assistant"];
	const skillDescription =
		skill.description || skill.summary || skill.title || slug;
	const toolNames = skillToolNames(skill, uuidToToolId);
	const authored = parseSkillFrontmatter(skill.content) ?? {};
	const authoredMetadata = isRecord(authored.metadata) ? authored.metadata : {};
	const {
		[MCP_SKILL_TOOL_METADATA_KEY]: _authoredToolMetadata,
		...otherMetadata
	} = authoredMetadata;
	// Keep author-defined fields (license, compatibility, custom metadata, etc.)
	// while replacing the projection-owned keys with the canonical Tedix values.
	// JSON scalar/collection syntax is valid YAML and avoids lossy hand-rendering.
	const projected: Record<string, unknown> = {
		...authored,
		name: slug,
		description: skillDescription,
		version: skill.revision,
		audience: skillAudience,
		provenance: `${appSlug ?? "tedix"}.mcp.tedix.dev`,
	};
	if (skill.title) projected.title = skill.title;
	else delete projected.title;
	if (skill.summary && skill.summary !== skillDescription) {
		projected.summary = skill.summary;
	} else delete projected.summary;
	if (skill.tags?.length) projected.tags = skill.tags;
	else delete projected.tags;
	if (toolNames.length) {
		projected.tools = toolNames;
	} else delete projected.tools;
	const projectedMetadata = {
		...otherMetadata,
		...(toolNames.length ? { [MCP_SKILL_TOOL_METADATA_KEY]: toolNames } : {}),
	};
	if (Object.keys(projectedMetadata).length > 0) {
		projected.metadata = projectedMetadata;
	} else {
		delete projected.metadata;
	}
	const frontmatter = [
		"---",
		...Object.entries(projected).map(
			([key, value]) => `${key}: ${JSON.stringify(value)}`,
		),
		"---",
	].join("\n");
	const body = stripSkillFrontmatter(skill.content);
	return `${frontmatter}\n\n${body}`;
}

/** sha256 content hash formatted as `sha256:<hex>` (Skills extension form). */
export async function sha256Digest(text: string): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	const hex = Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `sha256:${hex}`;
}

export async function renderSkillIndexEntry(
	skill: SkillDocumentEntry,
	appSlug: string | null,
	uuidToToolId: Map<string, string>,
): Promise<McpSkillEntry> {
	const path = computeSkillPath(skill, appSlug);
	const markdown = renderSkillMarkdown(skill, appSlug, uuidToToolId);
	const frontmatter = parseSkillFrontmatter(markdown) ?? {
		name: skill.slug ?? skill.id,
		description: skill.description || skill.summary || skill.title || skill.id,
	};
	const uri = `skill://${path}/SKILL.md`;
	const files = Object.entries(skill.files ?? {});
	const encoder = new TextEncoder();
	const totalBytes =
		encoder.encode(markdown).byteLength +
		files.reduce(
			(sum, [, content]) => sum + encoder.encode(content).byteLength,
			0,
		);
	if (files.length + 1 > MCP_SKILL_MAX_RESOURCES) {
		throw new SkillResourceLimitError(
			`Skill ${uri} has ${files.length + 1} resources; SEP-2640 allows at most ${MCP_SKILL_MAX_RESOURCES}`,
		);
	}
	if (totalBytes > MCP_SKILL_MAX_TOTAL_BYTES) {
		throw new SkillResourceLimitError(
			`Skill ${uri} has ${totalBytes} bytes; SEP-2640 allows at most ${MCP_SKILL_MAX_TOTAL_BYTES}`,
		);
	}
	// Keep digesting serial. A broad aggregate gateway already retains thousands
	// of tool schemas while this runs; fan-out through Web Crypto can starve the
	// isolate and leave skills/list pending until the client disconnects.
	const resources = [
		{
			uri,
			digest: await sha256Digest(markdown),
			size: encoder.encode(markdown).byteLength,
		},
	];
	for (const [filePath, content] of files) {
		resources.push({
			uri: `skill://${path}/${filePath}`,
			digest: await sha256Digest(content),
			size: encoder.encode(content).byteLength,
		});
	}
	return {
		uri,
		frontmatter,
		resources,
	};
}
