import { eq, inArray, or } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type MemoryEdge,
	type MemoryFact,
	memoryEdges,
	type NewMemoryEdge,
	type RelationType,
} from "../../schema/memory-graph";
import { getFactsByIds } from "./facts";

export type { RelationType };

export async function createEdge(
	db: DbClient,
	edge: NewMemoryEdge,
): Promise<MemoryEdge> {
	const [created] = await db.insert(memoryEdges).values(edge).returning();
	if (!created) throw new Error(`Failed to create edge: ${edge.id}`);
	return created;
}

/**
 * Batched both-direction edge read for a SET of facts — one chunked inArray
 * query per ~80 ids instead of two queries per fact. Exists because the
 * nightly graph reconcile called {@link getEdgesForFact} per fact: at ~15k
 * active facts that is ~30k sequential D1 queries in ONE workflow step, which
 * sails past the Workers subrequest cap and kills the whole reflection run.
 * Edges are deduped by
 * (source, target, relationType).
 */
export async function getEdgesForFacts(
	db: DbClient,
	factIds: string[],
): Promise<MemoryEdge[]> {
	if (factIds.length === 0) return [];
	const CHUNK = 80; // D1 bound-parameter cap headroom (~100)
	const edges: MemoryEdge[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < factIds.length; i += CHUNK) {
		const batch = factIds.slice(i, i + CHUNK);
		const rows = await db
			.select()
			.from(memoryEdges)
			.where(
				or(
					inArray(memoryEdges.sourceFactId, batch),
					inArray(memoryEdges.targetFactId, batch),
				),
			);
		for (const row of rows) {
			const key = `${row.sourceFactId}:${row.targetFactId}:${row.relationType}`;
			if (seen.has(key)) continue;
			seen.add(key);
			edges.push(row);
		}
	}
	return edges;
}

export async function getEdgesForFact(
	db: DbClient,
	factId: string,
	direction: "outgoing" | "incoming" | "both" = "both",
): Promise<MemoryEdge[]> {
	if (direction === "outgoing") {
		return db
			.select()
			.from(memoryEdges)
			.where(eq(memoryEdges.sourceFactId, factId));
	}
	if (direction === "incoming") {
		return db
			.select()
			.from(memoryEdges)
			.where(eq(memoryEdges.targetFactId, factId));
	}
	// Both directions
	const [outgoing, incoming] = await Promise.all([
		db.select().from(memoryEdges).where(eq(memoryEdges.sourceFactId, factId)),
		db.select().from(memoryEdges).where(eq(memoryEdges.targetFactId, factId)),
	]);
	return [...outgoing, ...incoming];
}

export async function countEdgesForFact(
	db: DbClient,
	factId: string,
): Promise<number> {
	const [outgoing, incoming] = await Promise.all([
		db.$count(memoryEdges, eq(memoryEdges.sourceFactId, factId)),
		db.$count(memoryEdges, eq(memoryEdges.targetFactId, factId)),
	]);
	return outgoing + incoming;
}

export async function getRelatedFactsForFacts(
	db: DbClient,
	factIds: string[],
	relationType?: RelationType,
): Promise<Map<string, MemoryFact[]>> {
	const uniqueFactIds = [...new Set(factIds)].filter(Boolean);
	const relatedByFactId = new Map<string, Set<string>>(
		uniqueFactIds.map((factId) => [factId, new Set<string>()]),
	);
	if (uniqueFactIds.length === 0) return new Map();

	const CHUNK = 80; // D1 bound-parameter cap headroom (~100)
	const outgoing: MemoryEdge[] = [];
	const incoming: MemoryEdge[] = [];
	for (let i = 0; i < uniqueFactIds.length; i += CHUNK) {
		const batch = uniqueFactIds.slice(i, i + CHUNK);
		const [outRows, inRows] = await Promise.all([
			db
				.select()
				.from(memoryEdges)
				.where(inArray(memoryEdges.sourceFactId, batch)),
			db
				.select()
				.from(memoryEdges)
				.where(inArray(memoryEdges.targetFactId, batch)),
		]);
		outgoing.push(...outRows);
		incoming.push(...inRows);
	}

	for (const edge of [...outgoing, ...incoming]) {
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

	const facts = await getFactsByIds(db, relatedIds);
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
