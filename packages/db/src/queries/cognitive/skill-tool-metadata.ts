import {
	validateGroundingPolicy,
	validateWorkflowReliabilityPolicy,
} from "@tedix/api-contract/utils/skill-manifest";
import { eq } from "drizzle-orm";
import { parse as parseYaml } from "yaml";
import type { DbClient } from "../../client";
import { appTools } from "../../schema/tools";
import { isRecord } from "@tedix/api-contract/utils/is-record";

interface SkillValidationIssue {
	code: string;
	message: string;
	path?: string;
}

/**
 * Resolve human-friendly tool slugs (matches `app_tools.tool_id`) to UUIDs scoped to a single app.
 * Returns `{ resolvedIds, unresolved }` — caller decides whether to throw or warn on unresolved.
 */
export async function resolveToolSlugsForApp(
	db: DbClient,
	appId: string,
	toolSlugs: string[],
): Promise<{ resolvedIds: string[]; unresolved: string[] }> {
	if (!toolSlugs.length) return { resolvedIds: [], unresolved: [] };
	const rows = await db
		.select({ id: appTools.id, toolId: appTools.toolId })
		.from(appTools)
		.where(eq(appTools.appId, appId));
	const bySlug = new Map(rows.map((r) => [r.toolId, r.id]));
	const resolvedIds: string[] = [];
	const unresolved: string[] = [];
	for (const slug of toolSlugs) {
		const id = bySlug.get(slug);
		if (id) resolvedIds.push(id);
		else unresolved.push(slug);
	}
	return { resolvedIds, unresolved };
}

/**
 * Load the tool fields used by the skill-coverage audit for one app.
 *
 * The API router owns coverage policy; this helper owns the D1 projection and
 * keeps the router free of Drizzle/schema imports.
 */
export async function listSkillCoverageToolsForApp(
	db: DbClient,
	appId: string,
) {
	return db
		.select({
			id: appTools.id,
			toolId: appTools.toolId,
			title: appTools.title,
			outputSchema: appTools.outputSchema,
			annotations: appTools.annotations,
			meta: appTools.meta,
			enabled: appTools.enabled,
		})
		.from(appTools)
		.where(eq(appTools.appId, appId));
}

const MCP_TOOLS_METADATA_KEY = "io.modelcontextprotocol/tools";

function uniqueTrimmedStrings(values: Iterable<string | null | undefined>) {
	return [
		...new Set(
			[...values].map((value) => value?.trim()).filter(Boolean) as string[],
		),
	];
}

function extractSkillFrontmatterBlock(content?: string): string | null {
	if (!content?.startsWith("---")) return null;
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	return match?.[1] ?? null;
}

function parseDelimitedStringList(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
			.filter(Boolean);
	}
	return trimmed
		.split(/[\s,]+/)
		.map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
		.filter(Boolean);
}

function stringListFromYamlValue(value: unknown): string[] {
	if (typeof value === "string") return parseDelimitedStringList(value);
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) =>
		typeof item === "string" ? parseDelimitedStringList(item) : [],
	);
}

function yamlArrayStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item) =>
		typeof item === "string" ? parseDelimitedStringList(item) : [],
	);
}

function parseSkillFrontmatter(
	content?: string,
): Record<string, unknown> | null {
	const frontmatter = extractSkillFrontmatterBlock(content);
	if (!frontmatter?.trim()) return null;
	try {
		const parsed = parseYaml(frontmatter);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

export function extractMcpToolMetadataSlugs(content?: string): string[] {
	const frontmatter = parseSkillFrontmatter(content);
	if (!frontmatter) return [];
	const metadata = frontmatter.metadata;
	if (!isRecord(metadata)) return [];
	return uniqueTrimmedStrings(
		stringListFromYamlValue(metadata[MCP_TOOLS_METADATA_KEY]),
	);
}

// ============================================================================
// Workflow Source Validation (executable skills)
// ============================================================================

/**
 * Capability manifest parsed from SKILL.md frontmatter.
 * `network: true` permits direct fetch() calls inside the run handler.
 * `mcp.{namespace}: [methods]` lists allowed env.MCP.<namespace>.<method> calls.
 */
export interface WorkflowCapabilities {
	network: boolean;
	mcp: Record<string, string[]>;
}

/** Parse the capability manifest from SKILL.md frontmatter. */
export function parseSkillFrontmatterCapabilities(
	content: string,
): WorkflowCapabilities {
	const empty: WorkflowCapabilities = { network: false, mcp: {} };
	const frontmatter = parseSkillFrontmatter(content);
	const capabilities = frontmatter?.capabilities;
	if (!isRecord(capabilities)) return empty;
	const mcp: Record<string, string[]> = {};
	if (isRecord(capabilities.mcp)) {
		for (const [namespace, methods] of Object.entries(capabilities.mcp)) {
			const allowedMethods = uniqueTrimmedStrings(yamlArrayStringList(methods));
			if (allowedMethods.length) mcp[namespace] = allowedMethods;
		}
	}
	return { network: capabilities.network === true, mcp };
}

/**
 * Write-time validation of `capabilities.grounding`.
 *
 * The runtime parser is total by contract (it also runs against rows already in
 * D1), so a typo there degrades silently to "no grounding required" — which is
 * exactly the failure this policy exists to prevent. Catch it at the only place
 * a human is still in the loop: `record_skill` / `improve_skill` admission.
 */
export function validateSkillGroundingPolicy(
	content: string,
): SkillValidationIssue[] {
	const frontmatter = parseSkillFrontmatter(content);
	const capabilities = frontmatter?.capabilities;
	if (!isRecord(capabilities)) return [];
	if (capabilities.grounding === undefined) return [];
	return validateGroundingPolicy(capabilities.grounding).issues;
}

export function validateSkillReliabilityPolicy(
	content: string,
): SkillValidationIssue[] {
	const frontmatter = parseSkillFrontmatter(content);
	const capabilities = frontmatter?.capabilities;
	if (!isRecord(capabilities) || capabilities.reliability === undefined) {
		return [];
	}
	return validateWorkflowReliabilityPolicy(capabilities.reliability).issues;
}

/**
 * Validate a workflow source file. These lightweight regex-based checks are
 * conservative authoring feedback, not the runtime trust boundary. The
 * Loader capability sandbox and injected step-context gates remain
 * authoritative for execution.
 *
 * TODO: upgrade to TS compiler API once `typescript` is added as a dep. Until
 * then, the following heuristics are intentionally conservative — false
 * positives are preferred over silent escapes.
 */
