import { coreTable } from "../../core-store/client";
import { anyIds } from "../../core-store/dialect";
import { type TenantScope, normalizeTenantScope } from "../../tenant-scope";
import { refreshConsolidatedForFact } from "./observations";
import { and, eq, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type MemoryEdge,
	type MemoryFact,
	memoryEdges as d1MemoryEdges,
	type NewMemoryEdge,
	type RelationType,
} from "../../schema/memory-graph";
import { getFactsByIds } from "./facts";

export type { RelationType };

export async function createEdge(
	db: DbClient,
	tenantScope: TenantScope,
	edge: NewMemoryEdge,
): Promise<MemoryEdge> {
	const memoryEdges = coreTable(db, d1MemoryEdges);
	tenantScope = normalizeTenantScope(tenantScope);
	const [created] = await db.insert(memoryEdges).values(edge).returning();
	if (!created) throw new Error(`Failed to create edge: ${edge.id}`);
	if (
		edge.relationType === "supersedes" ||
		edge.relationType === "contradicts"
	) {
		const facts = await getFactsByIds(
			db,
			tenantScope,
			[edge.sourceFactId, edge.targetFactId],
			{ includeGraphAnchors: true },
		);
		if (
			facts.length === 2 &&
			facts[0]!.organizationId === facts[1]!.organizationId
		)
			for (const fact of facts)
				await refreshConsolidatedForFact(db, tenantScope, fact.id);
	}
	return created;
}

export async function getEdgesForFacts(
	db: DbClient,
	tenantScope: TenantScope,
	factIds: string[],
): Promise<MemoryEdge[]> {
	const memoryEdges = coreTable(db, d1MemoryEdges);
	tenantScope = normalizeTenantScope(tenantScope);
	if (factIds.length === 0) return [];
	return db
		.select()
		.from(memoryEdges)
		.where(
			and(
				sql`EXISTS (SELECT 1 FROM memory_facts owned WHERE owned.id = ${memoryEdges.sourceFactId} AND owned.organization_id = ${tenantScope.organizationId})`,
				or(
					anyIds(db, memoryEdges.sourceFactId, factIds),
					anyIds(db, memoryEdges.targetFactId, factIds),
				),
			),
		);
}

export async function getEdgesForFact(
	db: DbClient,
	tenantScope: TenantScope,
	factId: string,
	direction: "outgoing" | "incoming" | "both" = "both",
): Promise<MemoryEdge[]> {
	tenantScope = normalizeTenantScope(tenantScope);
	const edges = await getEdgesForFacts(db, tenantScope, [factId]);
	if (direction === "outgoing")
		return edges.filter((edge) => edge.sourceFactId === factId);
	if (direction === "incoming")
		return edges.filter((edge) => edge.targetFactId === factId);
	// A self-edge participates once in each direction, matching the count contract.
	return [
		...edges.filter((edge) => edge.sourceFactId === factId),
		...edges.filter((edge) => edge.targetFactId === factId),
	];
}

export async function countEdgesForFact(
	db: DbClient,
	tenantScope: TenantScope,
	factId: string,
): Promise<number> {
	const memoryEdges = coreTable(db, d1MemoryEdges);
	tenantScope = normalizeTenantScope(tenantScope);
	const [row] = await db
		.select({
			total:
				sql<number>`coalesce(sum(CASE WHEN ${memoryEdges.sourceFactId} = ${factId} THEN 1 ELSE 0 END + CASE WHEN ${memoryEdges.targetFactId} = ${factId} THEN 1 ELSE 0 END), 0)`.mapWith(
					Number,
				),
		})
		.from(memoryEdges)
		.where(
			and(
				sql`EXISTS (SELECT 1 FROM memory_facts owned WHERE owned.id = ${memoryEdges.sourceFactId} AND owned.organization_id = ${tenantScope.organizationId})`,
				or(
					eq(memoryEdges.sourceFactId, factId),
					eq(memoryEdges.targetFactId, factId),
				),
			),
		);
	return row?.total ?? 0;
}

export async function getRelatedFactsForFacts(
	db: DbClient,
	tenantScope: TenantScope,
	factIds: string[],
	relationType?: RelationType,
): Promise<Map<string, MemoryFact[]>> {
	tenantScope = normalizeTenantScope(tenantScope);
	const uniqueFactIds = [...new Set(factIds)].filter(Boolean);
	const relatedByFactId = new Map<string, Set<string>>(
		uniqueFactIds.map((factId) => [factId, new Set<string>()]),
	);
	if (uniqueFactIds.length === 0) return new Map();

	const edges = await getEdgesForFacts(db, tenantScope, uniqueFactIds);

	for (const edge of edges) {
		if (relationType && edge.relationType !== relationType) continue;
		relatedByFactId.get(edge.sourceFactId)?.add(edge.targetFactId);
		relatedByFactId.get(edge.targetFactId)?.add(edge.sourceFactId);
	}

	const relatedIds = [
		...new Set([...relatedByFactId.values()].flatMap((ids) => [...ids])),
	];
	if (relatedIds.length === 0) {
		return new Map(uniqueFactIds.map((factId) => [factId, []]));
	}

	const facts = await getFactsByIds(db, tenantScope, relatedIds);
	const factById = new Map(facts.map((fact) => [fact.id, fact]));

	return new Map(
		uniqueFactIds.map((factId) => [
			factId,
			[...(relatedByFactId.get(factId) ?? [])]
				.map((relatedId) => factById.get(relatedId))
				.filter((fact): fact is MemoryFact => Boolean(fact)),
		]),
	);
}
