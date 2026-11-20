/**
 * Canonical D1 sample used to assess Neo4j projection coverage and freshness.
 *
 * This query is intentionally bounded. It does not make Neo4j authoritative and
 * it does not claim fleet-wide coverage from a sample: callers must label the
 * resulting ratio as sample coverage.
 */

import {
	and,
	count,
	desc,
	eq,
	gt,
	isNotNull,
	isNull,
	or,
	sql,
} from "drizzle-orm";
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
	memoryEdgeOrgCounts,
	memoryEdges,
	memoryFactOrgCounts,
	memoryFacts,
	tediExpertise,
} from "../schema/memory-graph";
import { platformCronCheckpoints } from "../schema/platform-cron-executions";
import { rationaleOrgCounts } from "../schema/rationale-records";
import { tedis } from "../schema/tedis";

export const GRAPH_PROJECTION_SAMPLE_LIMIT = 25;
export const GRAPH_PROJECTION_MAX_SAMPLE_LIMIT = 100;
export const GRAPH_PROJECTION_EDGE_SAMPLE_LIMIT = 25;
export const GRAPH_PROJECTION_EDGE_SCAN_WINDOW = 1_000;
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
		// Database triggers keep this total equal to the organization's facts
		// on every insert and delete, so one row replaces a count over all of
		// them (about 69,000 rows per call on 17 Nov 2026).
		db
			.select({ value: memoryFactOrgCounts.total })
			.from(memoryFactOrgCounts)
			.where(eq(memoryFactOrgCounts.organizationId, orgId)),
		// Triggers keep this total equal to the organization's edges (both
		// facts in the organization), so one row replaces joining every edge
		// to both facts (102k rows per call on 19 Nov 2026).
		db
			.select({ value: memoryEdgeOrgCounts.total })
			.from(memoryEdgeOrgCounts)
			.where(eq(memoryEdgeOrgCounts.organizationId, orgId)),
		db
			.select({ value: count() })
			.from(memoryDomains)
			.where(eq(memoryDomains.organizationId, orgId)),
		db
			.select({ value: count() })
			.from(tedis)
			.where(eq(tedis.organizationId, orgId)),
		// Database triggers keep this total equal to the organization's
		// rationale records on every insert and delete, so one row replaces a
		// count over all of them (36k rows per call on 16 Nov 2026).
		db
			.select({ value: rationaleOrgCounts.total })
			.from(rationaleOrgCounts)
			.where(eq(rationaleOrgCounts.orgId, orgId)),
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

/**
 * The last exact inventory a drain tick ran without certifying the
 * projection, kept so later ticks of the same hour can reuse it instead of
 * counting again.
 */
export type GraphProjectionManagedCountAttempt = {
	checkedAt: string;
	/** Inventories in a row that did not certify the projection. */
	attempts: number;
	canonical: GraphProjectionManagedCounts;
	projected: GraphProjectionManagedCounts;
	/** False when the projection could not be read, so nothing was compared. */
	compared: boolean;
};

const MANAGED_COUNT_ATTEMPT = "graph-projection-managed-counts:org:";

function storedManagedCounts(
	value: unknown,
): GraphProjectionManagedCounts | null {
	if (!value || typeof value !== "object") return null;
	const counts = value as Record<string, unknown>;
	return GRAPH_PROJECTION_MANAGED_COUNT_KEYS.every(
		(key) => typeof counts[key] === "number",
	)
		? (Object.fromEntries(
				GRAPH_PROJECTION_MANAGED_COUNT_KEYS.map((key) => [key, counts[key]]),
			) as GraphProjectionManagedCounts)
		: null;
}

/** Null when nothing is stored or the stored value cannot be read back whole. */
export async function getGraphProjectionManagedCountAttempt(
	db: DbClient,
	orgId: string,
): Promise<GraphProjectionManagedCountAttempt | null> {
	const [row] = await db
		.select({ through: platformCronCheckpoints.through })
		.from(platformCronCheckpoints)
		.where(
			eq(platformCronCheckpoints.scheduleId, MANAGED_COUNT_ATTEMPT + orgId),
		)
		.limit(1);
	if (!row) return null;
	let stored: Record<string, unknown> | null;
	try {
		stored = JSON.parse(row.through) as Record<string, unknown> | null;
	} catch {
		return null;
	}
	const canonical = storedManagedCounts(stored?.canonical);
	const projected = storedManagedCounts(stored?.projected);
	if (
		!stored ||
		!canonical ||
		!projected ||
		typeof stored.checkedAt !== "string" ||
		typeof stored.attempts !== "number" ||
		typeof stored.compared !== "boolean"
	)
		return null;
	return {
		checkedAt: stored.checkedAt,
		attempts: stored.attempts,
		canonical,
		projected,
		compared: stored.compared,
	};
}

export async function recordGraphProjectionManagedCountAttempt(
	db: DbClient,
	orgId: string,
	attempt: GraphProjectionManagedCountAttempt,
): Promise<void> {
	const through = JSON.stringify(attempt);
	await db
		.insert(platformCronCheckpoints)
		.values({ scheduleId: MANAGED_COUNT_ATTEMPT + orgId, through })
		.onConflictDoUpdate({
			target: platformCronCheckpoints.scheduleId,
			set: { through },
		});
}

export async function clearGraphProjectionManagedCountAttempt(
	db: DbClient,
	orgId: string,
): Promise<void> {
	await db
		.delete(platformCronCheckpoints)
		.where(
			eq(platformCronCheckpoints.scheduleId, MANAGED_COUNT_ATTEMPT + orgId),
		);
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
 *
 * Only the newest GRAPH_PROJECTION_EDGE_SCAN_WINDOW edges (by rowid, across
 * all organizations) are considered, so an organization with no recent edges
 * gets an empty sample; the hourly managed counts still cover its total. The
 * CROSS JOINs pin the order edges → facts: a regular join let the planner start
 * from every current fact and read 73k rows per check (2026-10-22).
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
		.crossJoin(sourceFact)
		.crossJoin(targetFact)
		.where(
			and(
				gt(
					sql`${memoryEdges}.rowid`,
					sql`(SELECT coalesce(max(rowid), 0) FROM ${memoryEdges}) - ${GRAPH_PROJECTION_EDGE_SCAN_WINDOW}`,
				),
				eq(sourceFact.id, memoryEdges.sourceFactId),
				eq(targetFact.id, memoryEdges.targetFactId),
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
