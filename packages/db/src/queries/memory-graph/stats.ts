/**
 * Memory Graph Query Helpers
 * CRUD operations for the knowledge graph — facts, edges, and domains.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	memoryDomains,
	memoryEdges,
	memoryFacts,
} from "../../schema/memory-graph";
import { countFacts } from "./fact-search";

export interface MemoryGraphStats {
	totalFacts: number;
	totalEdges: number;
	totalDomains: number;
	factsByType: Record<string, number>;
	factsByDomain: Record<string, number>;
	avgConfidence: number;
}

export async function getMemoryGraphStats(
	db: DbClient,
	orgId: string,
): Promise<MemoryGraphStats> {
	// Run all independent queries in parallel
	const [totalFacts, edgeResult, totalDomains, byType, byDomain, avgResult] =
		await Promise.all([
			// Total active facts
			countFacts(db, orgId),
			// Count edges (join through facts to scope by org)
			db
				.select({ count: sql<number>`count(*)` })
				.from(memoryEdges)
				.innerJoin(memoryFacts, eq(memoryEdges.sourceFactId, memoryFacts.id))
				.where(eq(memoryFacts.organizationId, orgId)),
			// Count domains
			db.$count(memoryDomains, eq(memoryDomains.organizationId, orgId)),
			// Facts by type
			db
				.select({
					factType: memoryFacts.factType,
					count: sql<number>`count(*)`,
				})
				.from(memoryFacts)
				.where(
					and(
						eq(memoryFacts.organizationId, orgId),
						isNull(memoryFacts.archivedAt),
					),
				)
				.groupBy(memoryFacts.factType),
			// Facts by domain
			db
				.select({
					domainName: memoryDomains.name,
					count: sql<number>`count(*)`,
				})
				.from(memoryFacts)
				.innerJoin(memoryDomains, eq(memoryFacts.domainId, memoryDomains.id))
				.where(
					and(
						eq(memoryFacts.organizationId, orgId),
						isNull(memoryFacts.archivedAt),
					),
				)
				.groupBy(memoryDomains.name),
			// Average confidence
			db
				.select({
					avg: sql<number>`COALESCE(avg(${memoryFacts.confidence}), 0)`,
				})
				.from(memoryFacts)
				.where(
					and(
						eq(memoryFacts.organizationId, orgId),
						isNull(memoryFacts.archivedAt),
					),
				),
		]);

	const totalEdges = edgeResult[0]?.count ?? 0;

	const factsByType: Record<string, number> = {};
	for (const row of byType) {
		factsByType[row.factType] = row.count;
	}

	const factsByDomain: Record<string, number> = {};
	for (const row of byDomain) {
		factsByDomain[row.domainName] = row.count;
	}

	const avgConfidence = avgResult[0]?.avg ?? 0;

	return {
		totalFacts,
		totalEdges,
		totalDomains,
		factsByType,
		factsByDomain,
		avgConfidence,
	};
}

/**
 * Get all active (non-archived) facts for an org, optionally filtered by tediId/domain.
 * Used for vector reindex operations.
 */
