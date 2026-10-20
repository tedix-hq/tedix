import { parse as parseYaml } from "yaml";
import type {
	McpGuidanceInfo,
	McpGuidanceMetadata,
	McpResourceInfo,
} from "./types";
import type { ManagedConnection } from "./connections";

function truncate(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function normalizeStringArray(value: unknown): string[] | undefined {
	const values = Array.isArray(value) ? value : [value];
	const items = values
		.flatMap((item) => {
			if (typeof item === "string" && item.includes(",")) {
				return item.split(",").map((part) => part.trim());
			}
			return [item];
		})
		.map((item) => normalizeFrontmatterScalar(item))
		.filter((item): item is string => Boolean(item));
	return items.length > 0 ? items : undefined;
}

function normalizeFrontmatterScalar(value: unknown): string | undefined {
	if (typeof value === "string") {
		return (
			value
				.trim()
				.replace(/^['"]|['"]$/g, "")
				.trim() || undefined
		);
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return undefined;
}

export function parseGuidanceFrontmatter(
	text: string,
): McpGuidanceMetadata | undefined {
	const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
	if (!match) return undefined;

	let frontmatter: unknown;
	try {
		frontmatter = parseYaml(match[1] ?? "");
	} catch {
		return undefined;
	}
	if (
		!frontmatter ||
		typeof frontmatter !== "object" ||
		Array.isArray(frontmatter)
	) {
		return undefined;
	}

	const record = frontmatter as Record<string, unknown>;
	const metadata: McpGuidanceMetadata = {};

	const title = normalizeFrontmatterScalar(record.title);
	if (title) metadata.title = title;
	const summary = normalizeFrontmatterScalar(record.summary);
	if (summary) metadata.summary = summary;
	const description = normalizeFrontmatterScalar(record.description);
	if (description) metadata.description = description;
	const version = normalizeFrontmatterScalar(record.version);
	if (version) metadata.version = version;
	const provenance = normalizeFrontmatterScalar(record.provenance);
	if (provenance) metadata.provenance = provenance;
	const source = normalizeFrontmatterScalar(record.source);
	if (source) metadata.source = source;
	const tags = normalizeStringArray(record.tags);
	if (tags) metadata.tags = tags;
	const dependencies = normalizeStringArray(record.dependencies);
	if (dependencies) metadata.dependencies = dependencies;

	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * Resolve annotations for a resource from the spec-aligned shape: top-level
 * `annotations` (audience/priority/lastModified) plus Tedix custom fields on
 * `_meta` under the `io.tedix/` prefix (per SEP-2640 §_meta key-name format).
 */
function resolveResourceAnnotations(
	resource: McpResourceInfo,
): Record<string, unknown> | undefined {
	const top = resource.annotations;
	const meta = resource._meta;
	const out: Record<string, unknown> = {};
	if (meta) {
		const TEDIX_KEYS = [
			"toolIds",
			"tags",
			"version",
			"provenance",
			"successCount",
			"size",
			"skillId",
		] as const;
		for (const key of TEDIX_KEYS) {
			const value = meta[`io.tedix/${key}`];
			if (value !== undefined) out[key] = value;
		}
	}
	if (top) Object.assign(out, top);
	return Object.keys(out).length > 0 ? out : undefined;
}

export function classifyGuidanceResource(
	resource: McpResourceInfo,
): McpGuidanceInfo["kind"] | null {
	const uri = resource.uri;

	// WG convention: skill://{path}/SKILL.md resources are skills.
	// SEP-2640 archives are also skills and are extracted on read.
	// Indexes (index.json) and supporting files are NOT guidance.
	if (uri.startsWith("skill://")) {
		if (uri.endsWith("/SKILL.md")) return "skill";
		if (uri.endsWith(".tar.gz") && !uri.endsWith("/archive.tar.gz"))
			return "skill";
		return null;
	}

	// ext-skills convention: annotations with toolIds indicate a skill resource
	const ann = resolveResourceAnnotations(resource);
	if (ann?.toolIds && Array.isArray(ann.toolIds)) {
		return "skill";
	}

	// Non-skill:// heuristic patterns for guides/policies from other servers
	const haystack =
		`${uri} ${resource.name ?? ""} ${resource.description ?? ""}`.toLowerCase();
	if (
		haystack.includes("/skills/") ||
		haystack.includes("skill.md") ||
		haystack.includes(".skill")
	) {
		return "skill";
	}
	if (haystack.includes("policy") || haystack.includes("runbook-policy"))
		return "policy";
	if (
		haystack.includes("guide") ||
		haystack.includes("instruction") ||
		haystack.includes("workflow") ||
		haystack.includes("playbook")
	) {
		return "guide";
	}
	return null;
}

function extractTextFromResourceResult(result: unknown): string {
	const payload = result as {
		contents?: Array<{
			text?: string;
			blob?: string;
			mimeType?: string;
			uri?: string;
		}>;
	};
	return (payload.contents ?? [])
		.filter((item) => typeof item.text === "string")
		.map((item) => item.text!.trim())
		.filter(Boolean)
		.join("\n\n");
}

export function buildGuidanceSummary(
	text: string,
	description: string | undefined,
	metadata: McpGuidanceMetadata | undefined,
	maxChars: number,
): string {
	const fallback = normalizeWhitespace(
		metadata?.description ?? description ?? "",
	);
	const lines = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	const heading = lines
		.find((line) => line.startsWith("#"))
		?.replace(/^#+\s*/, "")
		.trim();
	const paragraph = lines.find(
		(line) =>
			!line.startsWith("#") &&
			!line.startsWith("```") &&
			!line.startsWith("---"),
	);
	const summarySeed =
		metadata?.summary ?? heading ?? paragraph ?? metadata?.title ?? fallback;
	const summary = normalizeWhitespace(summarySeed || text);
	return truncate(summary, maxChars);
}

export function scoreGuidanceResource(
	resource: McpResourceInfo,
	kind: McpGuidanceInfo["kind"],
): number {
	// WG convention: use annotations.priority (0.0–1.0) as primary signal.
	// Falls back to heuristic scoring when priority is absent.
	const ann = resolveResourceAnnotations(resource);
	const priority = typeof ann?.priority === "number" ? ann.priority : 0.5;

	// Priority is the dominant factor (0–1000 range)
	let score = priority * 1000;

	// Kind tiebreaker
	score += kind === "skill" ? 30 : kind === "guide" ? 20 : 10;

	// Structural signals as minor tiebreakers
	if (resource.uri.startsWith("skill://")) score += 5;
	if ((resource.mimeType ?? "").includes("markdown")) score += 2;
	if (ann) {
		if (Array.isArray(ann.toolIds) && ann.toolIds.length > 0) score += 3;
		if (ann.provenance != null) score += 1;
	}
	return score;
}

export function guidanceNameFromUri(uri: string): string {
	const withoutSkillFile = uri.replace(/\/SKILL\.md$/, "");
	const parts = withoutSkillFile.split("/").filter(Boolean);
	return parts.at(-1) ?? uri;
}

export function guidanceMetadataFromResource(
	resource: McpResourceInfo,
): McpGuidanceMetadata | undefined {
	const ann = resolveResourceAnnotations(resource);
	const metadata: McpGuidanceMetadata = {};
	if (resource.name) metadata.title = resource.name;
	if (resource.description) metadata.description = resource.description;
	if (ann) {
		if (typeof ann.version === "string" && ann.version)
			metadata.version = ann.version;
		if (Array.isArray(ann.tags) && ann.tags.length > 0)
			metadata.tags = ann.tags.map(String);
		if (Array.isArray(ann.audience) && ann.audience.length > 0)
			metadata.audience = ann.audience.map(String);
		const provUrl = (ann.provenance as Record<string, unknown> | undefined)
			?.serverUrl;
		if (typeof provUrl === "string" && provUrl) metadata.provenance = provUrl;
	}
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function buildGuidanceResourceSummaries(
	conn: ManagedConnection,
	disabledSkills: Set<string>,
	guidanceSummaryMaxChars: number,
): McpGuidanceInfo[] {
	const candidates = conn.resources
		.map((resource) => ({
			resource,
			kind: classifyGuidanceResource(resource),
		}))
		.filter(
			(
				entry,
			): entry is {
				resource: McpResourceInfo;
				kind: McpGuidanceInfo["kind"];
			} => Boolean(entry.kind),
		)
		// Audience filter: exclude resources that don't target "assistant"
		.filter((entry) => {
			const ann = resolveResourceAnnotations(entry.resource);
			const audience = ann?.audience;
			if (!Array.isArray(audience) || audience.length === 0) return true;
			return audience.includes("assistant");
		})
		// Disabled-skills filter: exclude operator-disabled skills by URI or name
		.filter((entry) => {
			if (disabledSkills.size === 0) return true;
			const uri = entry.resource.uri;
			const name = entry.resource.name;
			return !disabledSkills.has(uri) && (!name || !disabledSkills.has(name));
		})
		.sort(
			(a, b) =>
				scoreGuidanceResource(b.resource, b.kind) -
				scoreGuidanceResource(a.resource, a.kind),
		);

	return candidates.map((entry) => {
		const metadata = guidanceMetadataFromResource(entry.resource);
		const name =
			metadata?.title ??
			entry.resource.name ??
			guidanceNameFromUri(entry.resource.uri);
		const description =
			metadata?.description ?? entry.resource.description ?? undefined;
		return {
			serverId: conn.info.serverId,
			uri: entry.resource.uri,
			name,
			description,
			mimeType: entry.resource.mimeType,
			kind: entry.kind,
			summary: buildGuidanceSummary(
				"",
				description,
				metadata,
				guidanceSummaryMaxChars,
			),
			sourceUrl: conn.info.url,
			serverName: conn.info.serverName,
			serverVersion: conn.info.serverVersion,
			metadata,
		};
	});
}

export function readGuidanceResult(
	conn: ManagedConnection,
	serverId: string,
	uri: string,
	result: unknown,
	guidanceMaxChars: number,
	guidanceSummaryMaxChars: number,
): { text: string; guidance: McpGuidanceInfo } {
	const text = truncate(
		extractTextFromResourceResult(result),
		guidanceMaxChars,
	);
	const existing = conn.guidance.find((item) => item.uri === uri);
	const metadata = parseGuidanceFrontmatter(text) ?? existing?.metadata;
	const guidance: McpGuidanceInfo = existing ?? {
		serverId,
		uri,
		name: uri,
		kind: "guide",
		summary: buildGuidanceSummary(
			text,
			undefined,
			metadata,
			guidanceSummaryMaxChars,
		),
		sourceUrl: conn.info.url,
		serverName: conn.info.serverName,
		serverVersion: conn.info.serverVersion,
		metadata,
	};
	return {
		text,
		guidance: {
			...guidance,
			name: metadata?.title ?? guidance.name,
			description: metadata?.description ?? guidance.description,
			metadata,
			summary: buildGuidanceSummary(
				text,
				guidance.description,
				metadata,
				guidanceSummaryMaxChars,
			),
		},
	};
}
