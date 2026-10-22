import {
	and,
	count,
	desc,
	eq,
	getColumns,
	gte,
	isNull,
	not,
	or,
	sql,
} from "drizzle-orm";
import type { MemoryFactType } from "@tedix/api-contract/constants/enums";
import type { DbClient } from "../../client";
import {
	type MemoryFact,
	memoryDomains,
	memoryFacts,
} from "../../schema/memory-graph";

export type FactType = MemoryFactType;

/** Largest page any caller reads; keeps every search a bounded index walk. */
export const FACT_SEARCH_MAX_LIMIT = 500;

function boundedLimit(limit: number | undefined): number {
	return Math.max(1, Math.min(FACT_SEARCH_MAX_LIMIT, limit ?? 50));
}

export interface FactSearchParams {
	orgId: string;
	tediId?: string;
	domainId?: string;
	factType?: MemoryFactType;
	minConfidence?: number;
	includeArchived?: boolean;
	includeInvalidated?: boolean;
	includeGraphAnchors?: boolean;
	limit?: number;
	offset?: number;
}

export async function searchFacts(
	db: DbClient,
	params: FactSearchParams,
): Promise<MemoryFact[]> {
	const conditions = [eq(memoryFacts.organizationId, params.orgId)];

	if (params.tediId) {
		conditions.push(eq(memoryFacts.tediId, params.tediId));
	}
	if (params.domainId) {
		conditions.push(eq(memoryFacts.domainId, params.domainId));
	}
	if (params.factType) {
		conditions.push(eq(memoryFacts.factType, params.factType));
	}
	if (params.minConfidence !== undefined) {
		conditions.push(gte(memoryFacts.confidence, params.minConfidence));
	}
	if (!params.includeArchived) {
		conditions.push(isNull(memoryFacts.archivedAt));
	}
	// By default, exclude invalidated facts (validTo IS NOT NULL)
	if (!params.includeInvalidated) {
		conditions.push(sql`${memoryFacts.validTo} IS NULL`);
	}
	if (!params.includeGraphAnchors) {
		conditions.push(
			not(eq(memoryFacts.memoryScope, "graph")),
			not(eq(memoryFacts.usePolicy, "do_not_inject_automatically")),
		);
	}

	return db
		.select()
		.from(memoryFacts)
		.where(and(...conditions))
		.orderBy(
			desc(memoryFacts.confidence),
			desc(memoryFacts.lastAccessedAt),
			desc(memoryFacts.createdAt),
		)
		.limit(boundedLimit(params.limit))
		.offset(params.offset ?? 0);
}

export interface BoundedFactCount {
	count: number;
	/** True when the organization has more active facts than `cap`. */
	capped: boolean;
}

/**
 * Count an organization's active facts, reading at most `cap + 1` entries of
 * `idx_memory_facts_org_live_rank`. An exact count read every active fact of
 * the organization (30k rows per call on 2026-10-22).
 */
export async function countActiveFactsUpTo(
	db: DbClient,
	orgId: string,
	cap: number,
): Promise<BoundedFactCount> {
	const live = db
		.select({ one: sql<number>`1`.as("one") })
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				isNull(memoryFacts.archivedAt),
			),
		)
		.limit(cap + 1)
		.as("live_facts");
	const [row] = await db.select({ value: count() }).from(live);
	const value = row?.value ?? 0;
	return { count: Math.min(value, cap), capped: value > cap };
}

/**
 * Hard-delete all facts whose source matches `skill://runs/{runId}`. Used
 * by `skills.revokeSkillRun` to cascade-clean memory state when a workflow
 * run is revoked. Org-scoped to prevent cross-tenant deletion.
 *
 * Edges (memory_edges) cascade automatically via the schema FK
 * `onDelete: "cascade"` on both source_fact_id and target_fact_id.
 *
 * Returns the number of fact rows deleted.
 *
 * Note: external semantic projections for these facts become orphans (lookups
 * still join back to D1 and miss, so they don't surface). Vector cleanup
 * is best-effort and deferred to a periodic reindex.
 */
export async function deleteFactsByRunId(
	db: DbClient,
	orgId: string,
	runId: string,
): Promise<number> {
	const source = `skill://runs/${runId}`;
	const result = await db
		.delete(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				eq(memoryFacts.source, source),
			),
		)
		.returning({ id: memoryFacts.id });
	return result.length;
}

// ============================================================================
// Edges
// ============================================================================

export interface VisibilityAwareSearchParams extends FactSearchParams {
	/** When set, applies visibility rules: private (own) + shared + org */
	visibilityTediId?: string;
}

export async function searchFactsWithVisibility(
	db: DbClient,
	params: VisibilityAwareSearchParams,
): Promise<MemoryFact[]> {
	const conditions = [eq(memoryFacts.organizationId, params.orgId)];

	if (params.visibilityTediId) {
		// Tedi sees: org facts + shared facts + own private facts
		conditions.push(
			or(
				eq(memoryFacts.visibility, "org"),
				eq(memoryFacts.visibility, "shared"),
				and(
					eq(memoryFacts.visibility, "private"),
					eq(memoryFacts.tediId, params.visibilityTediId),
				),
			)!,
		);
	} else {
		// No tedi identity: least-privileged read — org + shared only, never
		// any tedi's private facts. Mirrors isMemorySearchFactEligible in
		// apps/api's tenant visibility rules.
		conditions.push(
			or(
				eq(memoryFacts.visibility, "org"),
				eq(memoryFacts.visibility, "shared"),
			)!,
		);
	}

	if (params.domainId) {
		conditions.push(eq(memoryFacts.domainId, params.domainId));
	}
	if (params.factType) {
		conditions.push(eq(memoryFacts.factType, params.factType));
	}
	if (params.minConfidence !== undefined) {
		conditions.push(gte(memoryFacts.confidence, params.minConfidence));
	}
	if (!params.includeArchived) {
		conditions.push(isNull(memoryFacts.archivedAt));
	}
	if (!params.includeInvalidated) {
		conditions.push(sql`${memoryFacts.validTo} IS NULL`);
	}
	if (!params.includeGraphAnchors) {
		conditions.push(
			not(eq(memoryFacts.memoryScope, "graph")),
			not(eq(memoryFacts.usePolicy, "do_not_inject_automatically")),
		);
	}

	return db
		.select()
		.from(memoryFacts)
		.where(and(...conditions))
		.orderBy(
			desc(memoryFacts.confidence),
			desc(memoryFacts.lastAccessedAt),
			desc(memoryFacts.createdAt),
		)
		.limit(boundedLimit(params.limit))
		.offset(params.offset ?? 0);
}

// ============================================================================
// Tedi Expertise
// ============================================================================

export async function getActiveFacts(
	db: DbClient,
	orgId: string,
	options?: {
		tediId?: string;
		domainId?: string;
		includeGraphAnchors?: boolean;
	},
) {
	const conditions = [
		eq(memoryFacts.organizationId, orgId),
		isNull(memoryFacts.archivedAt),
		isNull(memoryFacts.validTo),
	];

	if (options?.tediId) {
		conditions.push(eq(memoryFacts.tediId, options.tediId));
	}
	if (options?.domainId) {
		conditions.push(eq(memoryFacts.domainId, options.domainId));
	}
	if (!options?.includeGraphAnchors) {
		conditions.push(
			not(eq(memoryFacts.memoryScope, "graph")),
			not(eq(memoryFacts.usePolicy, "do_not_inject_automatically")),
		);
	}

	// Explicitly projected, not `.select()`. A star select across this join emits
	// `id`, `organization_id`, `description`, and `created_at` twice — once per
	// table — and Drizzle's D1 path rebuilds rows positionally from the object D1
	// returns (`d1ToRawMapping`), so duplicate keys collapse and every later
	// column decodes into the wrong field. Naming the domain columns keeps them
	// distinct from the fact's own.
	return db
		.select({
			...getColumns(memoryFacts),
			domainName: memoryDomains.name,
			domainDescription: memoryDomains.description,
		})
		.from(memoryFacts)
		.leftJoin(memoryDomains, eq(memoryFacts.domainId, memoryDomains.id))
		.where(and(...conditions));
}

// ============================================================================
// Platform Knowledge (top facts for tedi container injection)
// ============================================================================

/**
 * Fetch the top N core/active facts for an org, ordered by priority (core first)
 * then confidence descending. Used to populate tediConfig.platformKnowledge
 * which gets written into the container as memory/platform-knowledge.md.
 */
