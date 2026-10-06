/**
 * Canonical D1 sample used to assess Neo4j projection coverage and freshness.
 *
 * This query is intentionally bounded. It does not make Neo4j authoritative and
 * it does not claim fleet-wide coverage from a sample: callers must label the
 * resulting ratio as sample coverage.
 */

import { and, count, desc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbClient } from "../client";
import { capabilityLinks, orgCapabilities } from "../schema/capabilities";
import { knowledgeEntries, skillEntries } from "../schema/cognitive";
import {
	memoryEntities,
	memoryEntityResolutions,
} from "../schema/memory-entities";
import {
	memoryDomains,
	memoryEdges,
	memoryFacts,
	tediExpertise,
} from "../schema/memory-graph";
import { tediRationaleRecords } from "../schema/rationale-records";
import { tedis } from "../schema/tedis";

export const GRAPH_PROJECTION_SAMPLE_LIMIT = 25;
export const GRAPH_PROJECTION_MAX_SAMPLE_LIMIT = 100;
export const GRAPH_PROJECTION_EDGE_SAMPLE_LIMIT = 25;
export const GRAPH_PROJECTION_LIFECYCLE_SAMPLE_LIMIT = 25;

export const GRAPH_PROJECTION_MANAGED_COUNT_KEYS = [
	"facts",
	"edges",
	"domains",
	"tedis",
	"decisions",
	"decisionOutcomes",
	"decisionOwners",
	"decisionCompletions",
	"knowledgeEntries",
	"skills",
	"tediExpertise",
	"capabilities",
	"capabilityLinks",
	"entities",
	"entityResolutions",
] as const;
export type GraphProjectionManagedCountKey =
	(typeof GRAPH_PROJECTION_MANAGED_COUNT_KEYS)[number];
export type GraphProjectionManagedCounts = Record<
	GraphProjectionManagedCountKey,
	number
>;

function selectedCount(rows: Array<{ value: number }>): number {
	return Number(rows[0]?.value ?? 0);
}

/** Exact D1 inventory used to detect both missing projection rows and ghosts. */
export async function getGraphProjectionCanonicalManagedCounts(
	db: DbClient,
	orgId: string,
): Promise<GraphProjectionManagedCounts> {
	const sourceFact = alias(memoryFacts, "projection_count_source_fact");
	const targetFact = alias(memoryFacts, "projection_count_target_fact");
	const [
		facts,
		edges,
		domains,
		tediRows,
		decisions,
		entries,
		skills,
		expertise,
		capabilities,
		links,
		entities,
		resolutions,
	] = await Promise.all([
		db
			.select({ value: count() })
			.from(memoryFacts)
			.where(eq(memoryFacts.organizationId, orgId)),
		db
			.select({ value: count() })
			.from(memoryEdges)
			.innerJoin(sourceFact, eq(sourceFact.id, memoryEdges.sourceFactId))
			.innerJoin(targetFact, eq(targetFact.id, memoryEdges.targetFactId))
			.where(
				and(
					eq(sourceFact.organizationId, orgId),
					eq(targetFact.organizationId, orgId),
				),
			),
		db
			.select({ value: count() })
			.from(memoryDomains)
			.where(eq(memoryDomains.organizationId, orgId)),
		db
			.select({ value: count() })
			.from(tedis)
			.where(eq(tedis.organizationId, orgId)),
		db
			.select({ value: count() })
			.from(tediRationaleRecords)
			.where(eq(tediRationaleRecords.orgId, orgId)),
		db
			.select({ value: count() })
			.from(knowledgeEntries)
			.where(eq(knowledgeEntries.organizationId, orgId)),
		db
			.select({ value: count() })
			.from(skillEntries)
			.where(eq(skillEntries.organizationId, orgId)),
		db
			.select({ value: count() })
			.from(tediExpertise)
			.innerJoin(tedis, eq(tedis.id, tediExpertise.tediId))
			.where(eq(tedis.organizationId, orgId)),
		db
			.select({ value: count() })
			.from(orgCapabilities)
			.where(eq(orgCapabilities.organizationId, orgId)),
		db
			.select({ value: count() })
			.from(capabilityLinks)
			.where(eq(capabilityLinks.organizationId, orgId)),
		db
			.select({ value: count() })
			.from(memoryEntities)
			.where(eq(memoryEntities.organizationId, orgId)),
		db
			.select({ value: count() })
			.from(memoryEntityResolutions)
			.where(
				and(
					eq(memoryEntityResolutions.organizationId, orgId),
					isNotNull(memoryEntityResolutions.entityId),
				),
			),
	]);
	return {
		facts: selectedCount(facts),
		edges: selectedCount(edges),
		domains: selectedCount(domains),
		tedis: selectedCount(tediRows),
		decisions: selectedCount(decisions),
		// Every canonical decision deterministically materializes one Outcome,
		// one DECIDED_BY edge, and one COMPLETED_AS edge.
		decisionOutcomes: selectedCount(decisions),
		decisionOwners: selectedCount(decisions),
		decisionCompletions: selectedCount(decisions),
		knowledgeEntries: selectedCount(entries),
		skills: selectedCount(skills),
		tediExpertise: selectedCount(expertise),
		capabilities: selectedCount(capabilities),
		capabilityLinks: selectedCount(links),
		entities: selectedCount(entities),
		entityResolutions: selectedCount(resolutions),
	};
}

export type GraphProjectionCanonicalFact = {
	id: string;
	canonicalUpdatedAt: string | null;
};

export type GraphProjectionCanonicalEdge = {
	id: string;
	sourceFactId: string;
	targetFactId: string;
	relationType: string;
	canonicalCreatedAt: string | null;
};

export type GraphProjectionCanonicalLifecycleFact = {
	id: string;
	canonicalUpdatedAt: string | null;
	validTo: string | null;
	archivedAt: string | null;
};

export async function getGraphProjectionCanonicalSample(
	db: DbClient,
	orgId: string,
	limit = GRAPH_PROJECTION_SAMPLE_LIMIT,
): Promise<GraphProjectionCanonicalFact[]> {
	const requestedLimit = Number.isFinite(limit)
		? Math.trunc(limit)
		: GRAPH_PROJECTION_SAMPLE_LIMIT;
	const boundedLimit = Math.max(
		1,
		Math.min(GRAPH_PROJECTION_MAX_SAMPLE_LIMIT, requestedLimit),
	);

	return db
		.select({
			id: memoryFacts.id,
			canonicalUpdatedAt: sql<
				string | null
			>`COALESCE(${memoryFacts.updatedAt}, ${memoryFacts.createdAt})`,
		})
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				isNull(memoryFacts.archivedAt),
				isNull(memoryFacts.validTo),
			),
		)
		.orderBy(
			// Preserve the `(organization_id, updated_at)` index path. The
			// created-at fallback only orders legacy rows whose updated_at is null.
			desc(memoryFacts.updatedAt),
			desc(memoryFacts.createdAt),
			desc(memoryFacts.id),
		)
		.limit(boundedLimit);
}

/**
 * Bounded canonical relationship sample for projection parity.
 *
 * Both endpoints must still be current D1 facts in the caller's organization.
 * Neo4j is checked against these exact edge ids; no graph-side count is treated
 * as canonical coverage.
 */
export async function getGraphProjectionCanonicalEdgeSample(
	db: DbClient,
	orgId: string,
	limit = GRAPH_PROJECTION_EDGE_SAMPLE_LIMIT,
): Promise<GraphProjectionCanonicalEdge[]> {
	const requestedLimit = Number.isFinite(limit)
		? Math.trunc(limit)
		: GRAPH_PROJECTION_EDGE_SAMPLE_LIMIT;
	const boundedLimit = Math.max(
		1,
		Math.min(GRAPH_PROJECTION_MAX_SAMPLE_LIMIT, requestedLimit),
	);
	const sourceFact = alias(memoryFacts, "projection_health_source_fact");
	const targetFact = alias(memoryFacts, "projection_health_target_fact");

	return db
		.select({
			id: memoryEdges.id,
			sourceFactId: memoryEdges.sourceFactId,
			targetFactId: memoryEdges.targetFactId,
			relationType: memoryEdges.relationType,
			canonicalCreatedAt: memoryEdges.createdAt,
		})
		.from(memoryEdges)
		.innerJoin(sourceFact, eq(sourceFact.id, memoryEdges.sourceFactId))
		.innerJoin(targetFact, eq(targetFact.id, memoryEdges.targetFactId))
		.where(
			and(
				eq(sourceFact.organizationId, orgId),
				eq(targetFact.organizationId, orgId),
				isNull(sourceFact.archivedAt),
				isNull(sourceFact.validTo),
				isNull(targetFact.archivedAt),
				isNull(targetFact.validTo),
			),
		)
		.orderBy(desc(memoryEdges.createdAt), desc(memoryEdges.id))
		.limit(boundedLimit);
}

/**
 * Bounded sample of facts whose lifecycle is no longer current.
 *
 * These rows are deliberately excluded from normal recall, but they must stay
 * visible in Neo4j with matching lifecycle fields for historical explanations.
 */
export async function getGraphProjectionCanonicalLifecycleSample(
	db: DbClient,
	orgId: string,
	limit = GRAPH_PROJECTION_LIFECYCLE_SAMPLE_LIMIT,
): Promise<GraphProjectionCanonicalLifecycleFact[]> {
	const requestedLimit = Number.isFinite(limit)
		? Math.trunc(limit)
		: GRAPH_PROJECTION_LIFECYCLE_SAMPLE_LIMIT;
	const boundedLimit = Math.max(
		1,
		Math.min(GRAPH_PROJECTION_MAX_SAMPLE_LIMIT, requestedLimit),
	);

	return db
		.select({
			id: memoryFacts.id,
			canonicalUpdatedAt: sql<
				string | null
			>`COALESCE(${memoryFacts.updatedAt}, ${memoryFacts.createdAt})`,
			validTo: memoryFacts.validTo,
			archivedAt: memoryFacts.archivedAt,
		})
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				or(isNotNull(memoryFacts.validTo), isNotNull(memoryFacts.archivedAt)),
			),
		)
		.orderBy(
			desc(sql`COALESCE(${memoryFacts.updatedAt}, ${memoryFacts.createdAt})`),
			desc(memoryFacts.id),
		)
		.limit(boundedLimit);
}
