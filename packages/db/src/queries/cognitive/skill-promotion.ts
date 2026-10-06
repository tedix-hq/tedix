import { and, eq, isNull, ne } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type NewSkillEntry,
	type SkillEntry,
	skillEntries,
} from "../../schema/cognitive";
import type { SkillLifecycleState } from "../skill-lifecycle";
import {
	extractMcpToolMetadataSlugs,
	resolveToolSlugsForApp,
} from "./skill-tool-metadata";

export interface SkillPromotionChange {
	code: string;
	field: string;
	before?: unknown;
	after?: unknown;
	note?: string;
}

export interface SkillPromotionOptions {
	visibility?: NonNullable<SkillEntry["visibility"]>;
	lifecycleState?: SkillLifecycleState;
	supersedesId?: string | null;
	revisionReasoning?: string;
}

export function defaultPromotedLifecycleState(
	state: SkillEntry["lifecycleState"],
): SkillLifecycleState {
	if (state === "proven" || state === "crystallized") return state;
	return "active";
}

export function computeSkillPromotion(
	entry: Pick<
		SkillEntry,
		"tediId" | "visibility" | "lifecycleState" | "supersedesId" | "revision"
	>,
	options: SkillPromotionOptions = {},
): { changes: SkillPromotionChange[]; patch: Partial<NewSkillEntry> } {
	const changes: SkillPromotionChange[] = [];
	const patch: Partial<NewSkillEntry> = {};
	const targetVisibility = options.visibility ?? "org";
	const targetLifecycleState =
		options.lifecycleState ??
		defaultPromotedLifecycleState(entry.lifecycleState ?? "active");

	if (entry.tediId !== null) {
		patch.tediId = null;
		changes.push({
			code: "PROMOTE_TO_BASELINE",
			field: "tediId",
			before: entry.tediId,
			after: null,
			note: "Clears tedi ownership so the skill becomes a baseline org-library skill.",
		});
	}

	if (entry.visibility !== targetVisibility) {
		patch.visibility = targetVisibility;
		changes.push({
			code: "SET_BASELINE_VISIBILITY",
			field: "visibility",
			before: entry.visibility,
			after: targetVisibility,
		});
	}

	if ((entry.lifecycleState ?? null) !== targetLifecycleState) {
		patch.lifecycleState = targetLifecycleState;
		changes.push({
			code: "SET_BASELINE_LIFECYCLE",
			field: "lifecycleState",
			before: entry.lifecycleState ?? null,
			after: targetLifecycleState,
		});
	}

	if (
		options.supersedesId !== undefined &&
		entry.supersedesId !== options.supersedesId
	) {
		patch.supersedesId = options.supersedesId;
		changes.push({
			code: "SET_SUPERSEDES",
			field: "supersedesId",
			before: entry.supersedesId ?? null,
			after: options.supersedesId,
		});
	}

	if (options.revisionReasoning !== undefined) {
		patch.revisionReasoning = options.revisionReasoning;
		changes.push({
			code: "SET_REVISION_REASONING",
			field: "revisionReasoning",
			after: options.revisionReasoning,
		});
	}

	if (Object.keys(patch).length > 0) {
		patch.revision = (entry.revision ?? 0) + 1;
	}

	return { changes, patch };
}

export async function findBaselineSkillEntryBySlug(
	db: DbClient,
	orgId: string,
	slug: string,
	options: { excludeId?: string } = {},
): Promise<SkillEntry | undefined> {
	const conditions = [
		eq(skillEntries.organizationId, orgId),
		eq(skillEntries.slug, slug),
		isNull(skillEntries.tediId),
	];
	if (options.excludeId) {
		conditions.push(ne(skillEntries.id, options.excludeId));
	}
	const rows = await db
		.select()
		.from(skillEntries)
		.where(and(...conditions));
	return rows[0];
}

export async function computeSkillPromotionBlockers(
	db: DbClient,
	entry: Pick<
		SkillEntry,
		"id" | "organizationId" | "slug" | "content" | "appId"
	>,
): Promise<SkillPromotionChange[]> {
	const blockers: SkillPromotionChange[] = [];
	const metadataToolSlugs = extractMcpToolMetadataSlugs(entry.content);
	if (metadataToolSlugs.length && !entry.appId) {
		blockers.push({
			code: "UNRESOLVED_MCP_TOOL_METADATA",
			field: "metadata.io.modelcontextprotocol/tools",
			before: metadataToolSlugs,
			note: "skill has MCP tool metadata but no appId scope, so tool names cannot be resolved before promotion",
		});
	} else if (metadataToolSlugs.length && entry.appId) {
		const { unresolved } = await resolveToolSlugsForApp(
			db,
			entry.appId,
			metadataToolSlugs,
		);
		if (unresolved.length) {
			blockers.push({
				code: "UNRESOLVED_MCP_TOOL_METADATA",
				field: "metadata.io.modelcontextprotocol/tools",
				before: metadataToolSlugs,
				after: unresolved,
				note: `unresolved metadata tools: ${unresolved.join(", ")}`,
			});
		}
	}

	if (entry.slug) {
		const existingBaseline = await findBaselineSkillEntryBySlug(
			db,
			entry.organizationId,
			entry.slug,
			{ excludeId: entry.id },
		);
		if (existingBaseline) {
			blockers.push({
				code: "BASELINE_SLUG_EXISTS",
				field: "slug",
				before: entry.slug,
				after: existingBaseline.id,
				note: `baseline skill ${existingBaseline.id} already uses slug "${entry.slug}"`,
			});
		}
	}

	return blockers;
}
