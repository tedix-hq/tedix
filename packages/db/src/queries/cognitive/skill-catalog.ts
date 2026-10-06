import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { DbClient } from "../../client";
import { type SkillEntry, skillEntries } from "../../schema/cognitive";
import type { SkillLifecycleState } from "../skill-lifecycle";
import { chunkForBoundParams } from "../../utils/batch";
import { applySupersedes, readableSkillCondition } from "./skill-crud";

export async function listSkillsByDomain(
	db: DbClient,
	orgId: string,
	domainId: string,
	options?: { lifecycleState?: SkillLifecycleState; limit?: number },
): Promise<SkillEntry[]> {
	const conditions = [
		eq(skillEntries.organizationId, orgId),
		eq(skillEntries.domainId, domainId),
	];
	if (options?.lifecycleState) {
		conditions.push(eq(skillEntries.lifecycleState, options.lifecycleState));
	}
	return db
		.select()
		.from(skillEntries)
		.where(and(...conditions))
		.orderBy(desc(skillEntries.successCount), desc(skillEntries.createdAt))
		.limit(options?.limit ?? 50);
}

export async function listSkillsByTedi(
	db: DbClient,
	orgId: string,
	tediId: string,
	options?: {
		domainId?: string;
		lifecycleState?: SkillLifecycleState;
		limit?: number;
	},
): Promise<SkillEntry[]> {
	const conditions = [
		eq(skillEntries.organizationId, orgId),
		readableSkillCondition(tediId),
	];
	if (options?.domainId) {
		conditions.push(eq(skillEntries.domainId, options.domainId));
	}
	if (options?.lifecycleState) {
		conditions.push(eq(skillEntries.lifecycleState, options.lifecycleState));
	} else {
		conditions.push(ne(skillEntries.lifecycleState, "draft"));
	}
	const results = await db
		.select()
		.from(skillEntries)
		.where(and(...conditions))
		.orderBy(
			desc(skillEntries.tediId),
			desc(skillEntries.successCount),
			desc(skillEntries.createdAt),
		)
		.limit(Math.min(options?.limit ?? 50, 200));
	return applySupersedes(results);
}

export async function listSkillLabelsByTediIds(
	db: DbClient,
	organizationId: string,
	tediIds: string[],
): Promise<
	Array<{ tediId: string | null; slug: string | null; title: string }>
> {
	if (tediIds.length === 0) return [];
	const rows: Array<{
		tediId: string | null;
		slug: string | null;
		title: string;
	}> = [];
	// D1 caps bound parameters at 100 per statement; chunk the id IN() list.
	for (const chunk of chunkForBoundParams([...new Set(tediIds)], 50)) {
		rows.push(
			...(await db
				.select({
					tediId: skillEntries.tediId,
					slug: skillEntries.slug,
					title: skillEntries.title,
				})
				.from(skillEntries)
				.where(
					and(
						eq(skillEntries.organizationId, organizationId),
						inArray(skillEntries.tediId, chunk),
					),
				)),
		);
	}
	return rows;
}

/**
 * Bounded org-wide workflow catalog for the kernel ROUTER context. Surfaces the
 * org's runnable workflow slugs (deduped to one row per slug, best revision first
 * via the successCount/createdAt ordering), INDEPENDENT of tedi assignment or
 * kernel-visibility — so the planner can ground a `run_workflow` route on a real
 * slug even when no visible tedi carries the skill on its capability card (the
 * `run_workflow` grounding gap). Excludes drafts and private skills; dispatch
 * resolves the owner later via getSkillEntryBySlug, so the catalog needs only
 * {slug, title}.
 */
export async function listKernelWorkflowCatalog(
	db: DbClient,
	orgId: string,
	options?: { limit?: number },
): Promise<Array<{ slug: string; title: string }>> {
	const rows = await db
		.select({
			slug: skillEntries.slug,
			title: skillEntries.title,
		})
		.from(skillEntries)
		.where(
			and(
				eq(skillEntries.organizationId, orgId),
				ne(skillEntries.lifecycleState, "draft"),
				ne(skillEntries.visibility, "private"),
			),
		)
		.orderBy(desc(skillEntries.successCount), desc(skillEntries.createdAt))
		.limit(200);
	const bySlug = new Map<string, { slug: string; title: string }>();
	for (const row of rows) {
		if (!row.slug || bySlug.has(row.slug)) continue;
		bySlug.set(row.slug, { slug: row.slug, title: row.title ?? row.slug });
	}
	return [...bySlug.values()].slice(0, Math.min(options?.limit ?? 24, 100));
}

export async function listSkillsByApp(
	db: DbClient,
	orgId: string,
	appId: string,
	options?: {
		limit?: number;
		tediId?: string;
		includeDrafts?: boolean;
		lifecycleState?: SkillLifecycleState;
		slugs?: string[];
	},
): Promise<SkillEntry[]> {
	const conditions = [
		eq(skillEntries.organizationId, orgId),
		eq(skillEntries.appId, appId),
	];
	conditions.push(readableSkillCondition(options?.tediId));
	if (options?.slugs?.length) {
		// bound-params: explicit per-request slug filter (one app's skill
		// manifest scale), never a data-derived fan-out list
		conditions.push(inArray(skillEntries.slug, options.slugs));
	}
	// Drafts are auto-suggested candidates — never surface them in default listings
	// (skill://index.json, list_skills, registerAppSkills). Explicit callers
	// (promotion UI / review tools) opt in via includeDrafts: true.
	if (options?.lifecycleState) {
		conditions.push(eq(skillEntries.lifecycleState, options.lifecycleState));
	} else if (!options?.includeDrafts) {
		conditions.push(ne(skillEntries.lifecycleState, "draft"));
	}
	const results = await db
		.select()
		.from(skillEntries)
		.where(and(...conditions))
		.orderBy(
			desc(skillEntries.tediId),
			desc(skillEntries.successCount),
			desc(skillEntries.createdAt),
		)
		.limit(Math.min(options?.limit ?? 50, 200));
	// Apply supersedes: tedi-specific overrides replace baseline skills
	return applySupersedes(results);
}

export async function listSkillSummariesByApp(
	db: DbClient,
	orgId: string,
	appId: string,
	options?: {
		limit?: number;
		tediId?: string;
		includeDrafts?: boolean;
		lifecycleState?: SkillLifecycleState;
	},
): Promise<
	Pick<
		SkillEntry,
		| "id"
		| "title"
		| "slug"
		| "summary"
		| "description"
		| "tags"
		| "toolIds"
		| "successCount"
		| "revision"
		| "audience"
		| "appId"
		| "r2Path"
		| "lifecycleState"
		| "paceLayer"
	>[]
> {
	const conditions = [
		eq(skillEntries.organizationId, orgId),
		eq(skillEntries.appId, appId),
	];
	conditions.push(readableSkillCondition(options?.tediId));
	// Drafts are auto-suggested candidates — exclude by default. See listSkillsByApp.
	if (options?.lifecycleState) {
		conditions.push(eq(skillEntries.lifecycleState, options.lifecycleState));
	} else if (!options?.includeDrafts) {
		conditions.push(ne(skillEntries.lifecycleState, "draft"));
	}
	const results = await db
		.select()
		.from(skillEntries)
		.where(and(...conditions))
		.orderBy(
			desc(skillEntries.tediId),
			desc(skillEntries.successCount),
			desc(skillEntries.createdAt),
		)
		.limit(Math.min(options?.limit ?? 50, 200));
	return applySupersedes(results).map((entry) => ({
		id: entry.id,
		title: entry.title,
		slug: entry.slug,
		summary: entry.summary,
		description: entry.description,
		tags: entry.tags,
		toolIds: entry.toolIds,
		successCount: entry.successCount,
		revision: entry.revision,
		audience: entry.audience,
		appId: entry.appId,
		r2Path: entry.r2Path,
		lifecycleState: entry.lifecycleState,
		paceLayer: entry.paceLayer,
	}));
}

/**
 * Batched {@link listSkillSummariesByApp} — one query per chunk of apps instead
 * of one query per app.
 *
 * The MCP aggregate surface enriches every app per rebuild and was calling
 * `skills.listByApp` once each; every one of those apps/api invocations pays a
 * cold-isolate CPU cost (the `worker-app` graph is evaluated per isolate), so a
 * rebuild blew the client timeout. Collapsing the fan-out is the cheapest large
 * win available: many cold isolates become 1.
 *
 * Chunked at 50 app ids: D1 caps bound parameters at 100 per statement, and the
 * other conditions consume a few, so 50 keeps a comfortable margin.
 *
 * Per-app ordering and limit are preserved. The single query orders by the same
 * keys, then rows are grouped by appId and each group is independently passed
 * through `applySupersedes` (id-based, so grouping first is equivalent) and
 * sliced to `limit`.
 */
export async function listSkillSummariesByApps(
	db: DbClient,
	orgId: string,
	appIds: string[],
	options?: {
		limit?: number;
		tediId?: string;
		includeDrafts?: boolean;
		lifecycleState?: SkillLifecycleState;
	},
): Promise<Map<string, Awaited<ReturnType<typeof listSkillSummariesByApp>>>> {
	const perApp = Math.min(options?.limit ?? 50, 200);
	const unique = [...new Set(appIds.filter(Boolean))];
	const out = new Map<
		string,
		Awaited<ReturnType<typeof listSkillSummariesByApp>>
	>();
	for (const appId of unique) out.set(appId, []);
	if (unique.length === 0) return out;

	const CHUNK = 50;
	for (let start = 0; start < unique.length; start += CHUNK) {
		const chunk = unique.slice(start, start + CHUNK);
		const conditions = [
			eq(skillEntries.organizationId, orgId),
			inArray(skillEntries.appId, chunk),
		];
		conditions.push(readableSkillCondition(options?.tediId));
		if (options?.lifecycleState) {
			conditions.push(eq(skillEntries.lifecycleState, options.lifecycleState));
		} else if (!options?.includeDrafts) {
			conditions.push(ne(skillEntries.lifecycleState, "draft"));
		}
		const rows = await db
			.select()
			.from(skillEntries)
			.where(and(...conditions))
			.orderBy(
				desc(skillEntries.tediId),
				desc(skillEntries.successCount),
				desc(skillEntries.createdAt),
			)
			// Global cap for the chunk. Per-app slicing happens below; this only
			// bounds a pathological org with tens of thousands of skill rows.
			.limit(perApp * chunk.length);

		const grouped = new Map<string, SkillEntry[]>();
		for (const row of rows) {
			const key = row.appId;
			if (!key) continue;
			const bucket = grouped.get(key);
			if (bucket) bucket.push(row);
			else grouped.set(key, [row]);
		}
		for (const [appId, entries] of grouped) {
			out.set(
				appId,
				applySupersedes(entries)
					.slice(0, perApp)
					.map((entry) => ({
						id: entry.id,
						title: entry.title,
						slug: entry.slug,
						summary: entry.summary,
						description: entry.description,
						tags: entry.tags,
						toolIds: entry.toolIds,
						successCount: entry.successCount,
						revision: entry.revision,
						audience: entry.audience,
						appId: entry.appId,
						r2Path: entry.r2Path,
						lifecycleState: entry.lifecycleState,
						paceLayer: entry.paceLayer,
					})),
			);
		}
	}
	return out;
}
