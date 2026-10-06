import {
	and,
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
		.limit(params.limit ?? 50)
		.offset(params.offset ?? 0);
}

export async function countFacts(db: DbClient, orgId: string): Promise<number> {
	return db.$count(
		memoryFacts,
		and(eq(memoryFacts.organizationId, orgId), isNull(memoryFacts.archivedAt)),
	);
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
		.limit(params.limit ?? 50)
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
