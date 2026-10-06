/**
 * Memory Graph Query Helpers
 * CRUD operations for the knowledge graph — facts, edges, and domains.
 */

import { and, eq, isNull, not, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	memoryDomains,
	memoryEdges,
	memoryFacts,
	tediCuriosityQueue,
} from "../../schema/memory-graph";

export interface MemoryHealthExtended {
	totalFacts: number;
	activeFacts: number;
	archivedFacts: number;
	totalGaps: number;
	totalOpinions: number;
	totalEdges: number;
	totalDomains: number;
	avgConfidence: number;
	orphanRatio: number;
	staleFacts: number;
	contradictions: number;
	curiosityQueue: {
		queued: number;
		exploring: number;
		completedTotal: number;
	};
}

export async function getMemoryHealthExtended(
	db: DbClient,
	orgId: string,
): Promise<MemoryHealthExtended> {
	const sixtyDaysAgo = new Date(
		Date.now() - 60 * 24 * 60 * 60 * 1000,
	).toISOString();

	// Batch all independent count/aggregate queries into a single D1 round-trip
	const [
		activeFactsResult,
		archivedFactsResult,
		totalGapsResult,
		totalOpinionsResult,
		edgeCountResult,
		domainCountResult,
		avgConfResult,
		factsWithEdgesResult,
		staleFactsResult,
		contradictionResult,
		curiosityStatsResult,
	] = await db.batch([
		// 0: active facts count
		db
			.select({ count: sql<number>`count(*)` })
			.from(memoryFacts)
			.where(
				and(
					eq(memoryFacts.organizationId, orgId),
					isNull(memoryFacts.archivedAt),
				),
			),
		// 1: archived facts count
		db
			.select({ count: sql<number>`count(*)` })
			.from(memoryFacts)
			.where(
				and(
					eq(memoryFacts.organizationId, orgId),
					not(isNull(memoryFacts.archivedAt)),
				),
			),
		// 2: gaps count
		db
			.select({ count: sql<number>`count(*)` })
			.from(memoryFacts)
			.where(
				and(
					eq(memoryFacts.organizationId, orgId),
					eq(memoryFacts.factType, "gap"),
					isNull(memoryFacts.archivedAt),
				),
			),
		// 3: opinions count
		db
			.select({ count: sql<number>`count(*)` })
			.from(memoryFacts)
			.where(
				and(
					eq(memoryFacts.organizationId, orgId),
					eq(memoryFacts.factType, "opinion"),
					isNull(memoryFacts.archivedAt),
				),
			),
		// 4: total edges (join through facts to scope by org)
		db
			.select({ count: sql<number>`count(*)` })
			.from(memoryEdges)
			.innerJoin(memoryFacts, eq(memoryEdges.sourceFactId, memoryFacts.id))
			.where(eq(memoryFacts.organizationId, orgId)),
		// 5: total domains
		db
			.select({ count: sql<number>`count(*)` })
			.from(memoryDomains)
			.where(eq(memoryDomains.organizationId, orgId)),
		// 6: avg confidence
		db
			.select({ avg: sql<number>`COALESCE(avg(${memoryFacts.confidence}), 0)` })
			.from(memoryFacts)
			.where(
				and(
					eq(memoryFacts.organizationId, orgId),
					isNull(memoryFacts.archivedAt),
				),
			),
		// 7: facts with edges (for orphan ratio)
		db
			.select({
				count: sql<number>`count(DISTINCT ${memoryEdges.sourceFactId})`,
			})
			.from(memoryEdges)
			.innerJoin(memoryFacts, eq(memoryEdges.sourceFactId, memoryFacts.id))
			.where(eq(memoryFacts.organizationId, orgId)),
		// 8: stale facts (not accessed in 60+ days)
		db
			.select({ count: sql<number>`count(*)` })
			.from(memoryFacts)
			.where(
				and(
					eq(memoryFacts.organizationId, orgId),
					isNull(memoryFacts.archivedAt),
					sql`COALESCE(${memoryFacts.lastAccessedAt}, ${memoryFacts.createdAt}) < ${sixtyDaysAgo}`,
				),
			),
		// 9: contradictions
		db
			.select({ count: sql<number>`count(*)` })
			.from(memoryEdges)
			.innerJoin(memoryFacts, eq(memoryEdges.sourceFactId, memoryFacts.id))
			.where(
				and(
					eq(memoryFacts.organizationId, orgId),
					eq(memoryEdges.relationType, "contradicts"),
				),
			),
		// 10: curiosity queue stats
		db
			.select({
				status: tediCuriosityQueue.status,
				count: sql<number>`count(*)`,
			})
			.from(tediCuriosityQueue)
			.where(eq(tediCuriosityQueue.organizationId, orgId))
			.groupBy(tediCuriosityQueue.status),
	]);

	const activeFacts = activeFactsResult[0]?.count ?? 0;
	const archivedFacts = archivedFactsResult[0]?.count ?? 0;
	const totalGaps = totalGapsResult[0]?.count ?? 0;
	const totalOpinions = totalOpinionsResult[0]?.count ?? 0;
	const totalEdges = edgeCountResult[0]?.count ?? 0;
	const totalDomains = domainCountResult[0]?.count ?? 0;
	const avgConfidence = avgConfResult[0]?.avg ?? 0;
	const linkedCount = factsWithEdgesResult[0]?.count ?? 0;
	const staleFacts = staleFactsResult[0]?.count ?? 0;
	const contradictions = contradictionResult[0]?.count ?? 0;

	const orphanRatio = activeFacts > 0 ? 1 - linkedCount / activeFacts : 0;

	const curiosityMap: Record<string, number> = {};
	for (const row of curiosityStatsResult) {
		curiosityMap[row.status] = row.count;
	}

	return {
		totalFacts: activeFacts + archivedFacts,
		activeFacts,
		archivedFacts,
		totalGaps,
		totalOpinions,
		totalEdges,
		totalDomains,
		avgConfidence,
		orphanRatio,
		staleFacts,
		contradictions,
		curiosityQueue: {
			queued: curiosityMap.queued ?? 0,
			exploring: curiosityMap.exploring ?? 0,
			completedTotal: curiosityMap.completed ?? 0,
		},
	};
}

// ============================================================================
// Auto-Link Facts
// ============================================================================
