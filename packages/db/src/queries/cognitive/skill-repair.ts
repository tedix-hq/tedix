import type { DbClient } from "../../client";
import type { NewSkillEntry, SkillEntry } from "../../schema/cognitive";
import {
	extractMcpToolMetadataSlugs,
	resolveToolSlugsForApp,
} from "./skill-tool-metadata";
import { slugify } from "./skill-validation";

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SkillRepairChange {
	code: string;
	field: string;
	before?: unknown;
	after?: unknown;
	note?: string;
}

/**
 * Compute the set of safe automatic repairs for an existing skill entry.
 * Pure function — does NOT mutate the DB. Returns the list of changes plus
 * a `patch` ready to feed into `updateSkillEntry`.
 *
 * Repairs:
 *  - SYNTHESIZE_DESCRIPTION: description ← summary || title
 *  - NORMALIZE_SLUG: slugify(title) when stored slug breaks SEP regex
 *  - MOVE_SKILL_MD: files["SKILL.md"] → content
 *  - DEDUP_FILE_PATHS: case-folded path collisions in files
 *  - STRIP_TRAVERSAL_PATHS: drop unsafe file keys (.., leading /, \, scheme:)
 *  - CONVERT_TOOL_SLUG: toolIds slug-like entry → resolved UUID via app_tools
 *  - RESOLVE_MCP_TOOL_METADATA: frontmatter tool names → toolIds UUIDs
 */
export async function computeSkillRepairs(
	db: DbClient,
	entry: SkillEntry,
): Promise<{ changes: SkillRepairChange[]; patch: Partial<NewSkillEntry> }> {
	const changes: SkillRepairChange[] = [];
	const patch: Partial<NewSkillEntry> = {};

	// 1. SYNTHESIZE_DESCRIPTION
	if (!entry.description && (entry.summary || entry.title)) {
		const synthesized = (entry.summary ?? entry.title).trim();
		if (synthesized) {
			patch.description = synthesized;
			changes.push({
				code: "SYNTHESIZE_DESCRIPTION",
				field: "description",
				before: entry.description,
				after: synthesized,
				note: entry.summary ? "from summary" : "from title",
			});
		}
	}

	// 2. NORMALIZE_SLUG
	if (entry.slug && !SLUG_RE.test(entry.slug) && entry.title) {
		const fresh = slugify(entry.title);
		if (fresh && SLUG_RE.test(fresh) && fresh !== entry.slug) {
			patch.slug = fresh;
			changes.push({
				code: "NORMALIZE_SLUG",
				field: "slug",
				before: entry.slug,
				after: fresh,
			});
		}
	}

	// 3. MOVE_SKILL_MD + 4. DEDUP_FILE_PATHS + 5. STRIP_TRAVERSAL_PATHS
	const originalFiles = (entry.files ?? null) as Record<string, string> | null;
	if (originalFiles) {
		const workingFiles: Record<string, string> = { ...originalFiles };
		let filesChanged = false;

		// MOVE_SKILL_MD
		if ("SKILL.md" in workingFiles) {
			const newContent = workingFiles["SKILL.md"]!;
			delete workingFiles["SKILL.md"];
			filesChanged = true;
			patch.content = newContent;
			changes.push({
				code: "MOVE_SKILL_MD",
				field: "content",
				before: entry.content,
				after: newContent,
				note: "moved files['SKILL.md'] into canonical content",
			});
		}

		// STRIP_TRAVERSAL_PATHS
		for (const filePath of Object.keys(workingFiles)) {
			if (
				filePath.includes("..") ||
				filePath.startsWith("/") ||
				filePath.includes("\\") ||
				/^\w+:/.test(filePath)
			) {
				delete workingFiles[filePath];
				filesChanged = true;
				changes.push({
					code: "STRIP_TRAVERSAL_PATHS",
					field: `files["${filePath}"]`,
					before: filePath,
					note: "unsafe path (traversal/absolute/scheme) dropped",
				});
			}
		}

		// DEDUP_FILE_PATHS — case-folded collisions; iteration order = insertion order,
		// so the LAST occurrence wins ("most recent").
		const byFolded = new Map<string, string>();
		for (const k of Object.keys(workingFiles)) {
			byFolded.set(k.toLowerCase(), k);
		}
		if (byFolded.size !== Object.keys(workingFiles).length) {
			const kept = new Set(byFolded.values());
			for (const k of Object.keys(workingFiles)) {
				if (!kept.has(k)) {
					const winner = byFolded.get(k.toLowerCase())!;
					delete workingFiles[k];
					filesChanged = true;
					changes.push({
						code: "DEDUP_FILE_PATHS",
						field: `files["${k}"]`,
						before: k,
						after: winner,
						note: `case-folded collision with "${winner}" — dropped older`,
					});
				}
			}
		}

		if (filesChanged) {
			patch.files = Object.keys(workingFiles).length ? workingFiles : null;
		}
	}

	// 6. CONVERT_TOOL_SLUG → UUID
	const currentToolIds = (entry.toolIds ?? null) as string[] | null;
	if (entry.appId && currentToolIds?.length) {
		const slugLike: string[] = [];
		for (const t of currentToolIds) {
			if (typeof t !== "string") continue;
			const looksLikeSlug =
				t.length < 64 &&
				t === t.toLowerCase() &&
				t.includes("_") &&
				!UUID_RE.test(t);
			if (looksLikeSlug) slugLike.push(t);
		}
		if (slugLike.length) {
			const { resolvedIds, unresolved } = await resolveToolSlugsForApp(
				db,
				entry.appId,
				slugLike,
			);
			if (resolvedIds.length) {
				const slugSet = new Set(slugLike);
				const nextIds: string[] = [];
				let i = 0;
				for (const t of currentToolIds) {
					if (slugSet.has(t) && !unresolved.includes(t)) {
						const replacement = resolvedIds[i++];
						if (replacement) nextIds.push(replacement);
					} else {
						nextIds.push(t);
					}
				}
				const dedup = [...new Set(nextIds)];
				patch.toolIds = dedup;
				changes.push({
					code: "CONVERT_TOOL_SLUG",
					field: "toolIds",
					before: currentToolIds,
					after: dedup,
					note: unresolved.length
						? `resolved ${resolvedIds.length}, unresolved: ${unresolved.join(", ")}`
						: `resolved ${resolvedIds.length} slugs to UUIDs`,
				});
			}
		}
	}

	// 7. RESOLVE_MCP_TOOL_METADATA → UUIDs
	const metadataToolSlugs = extractMcpToolMetadataSlugs(entry.content);
	if (metadataToolSlugs.length) {
		if (!entry.appId) {
			changes.push({
				code: "UNRESOLVED_MCP_TOOL_METADATA",
				field: "metadata.io.modelcontextprotocol/tools",
				before: metadataToolSlugs,
				note: "skill has MCP tool metadata but no appId scope, so tool names cannot be resolved",
			});
		} else {
			const { resolvedIds, unresolved } = await resolveToolSlugsForApp(
				db,
				entry.appId,
				metadataToolSlugs,
			);
			const baseToolIds = ((patch.toolIds as string[] | undefined) ??
				currentToolIds ??
				[]) as string[];
			const merged = [...new Set([...baseToolIds, ...resolvedIds])];
			if (merged.length !== baseToolIds.length) {
				patch.toolIds = merged;
				changes.push({
					code: "RESOLVE_MCP_TOOL_METADATA",
					field: "toolIds",
					before: baseToolIds,
					after: merged,
					note: unresolved.length
						? `resolved ${resolvedIds.length}; unresolved metadata tools: ${unresolved.join(", ")}`
						: `resolved ${resolvedIds.length} metadata tool names to UUIDs`,
				});
			} else if (unresolved.length) {
				changes.push({
					code: "UNRESOLVED_MCP_TOOL_METADATA",
					field: "metadata.io.modelcontextprotocol/tools",
					before: metadataToolSlugs,
					note: `unresolved metadata tools: ${unresolved.join(", ")}`,
				});
			}
		}
	}

	return { changes, patch };
}
