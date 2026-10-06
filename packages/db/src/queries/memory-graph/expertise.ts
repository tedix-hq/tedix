/**
 * Memory Graph Query Helpers
 * CRUD operations for the knowledge graph — facts, edges, and domains.
 */

import { and, count, eq, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type ExpertiseLevel,
	memoryDomains,
	memoryFacts,
	type NewTediExpertise,
	type TediExpertise,
	tediExpertise,
} from "../../schema/memory-graph";

export type { ExpertiseLevel };

async function upsertExpertise(
	db: DbClient,
	input: Omit<
		NewTediExpertise,
		"id" | "createdAt" | "updatedAt" | "lastActivityAt"
	> & { id?: string },
): Promise<TediExpertise> {
	const now = new Date().toISOString();
	const existing = await db.query.tediExpertise.findFirst({
		where: { tediId: input.tediId, domainId: input.domainId },
	});

	if (existing) {
		const [updated] = await db
			.update(tediExpertise)
			.set({
				factCount: input.factCount,
				avgConfidence: input.avgConfidence,
				expertiseLevel: input.expertiseLevel,
				lastActivityAt: now,
				updatedAt: now,
			})
			.where(eq(tediExpertise.id, existing.id))
			.returning();
		if (!updated) throw new Error(`Failed to update expertise: ${existing.id}`);
		return updated;
	}

	const id = input.id ?? crypto.randomUUID();
	const [created] = await db
		.insert(tediExpertise)
		.values({
			id,
			tediId: input.tediId,
			domainId: input.domainId,
			factCount: input.factCount ?? 0,
			avgConfidence: input.avgConfidence ?? 0,
			expertiseLevel: input.expertiseLevel ?? "novice",
			lastActivityAt: now,
			createdAt: now,
			updatedAt: now,
		})
		.returning();
	if (!created) throw new Error(`Failed to create expertise: ${id}`);
	return created;
}
export async function getExpertise(
	db: DbClient,
	tediId: string,
	domainId?: string,
): Promise<
	(TediExpertise & { domainName: string | null; competenceScore: number })[]
> {
	const conditions = [eq(tediExpertise.tediId, tediId)];
	if (domainId) {
		conditions.push(eq(tediExpertise.domainId, domainId));
	}
	const rows = await db
		.select({
			id: tediExpertise.id,
			tediId: tediExpertise.tediId,
			domainId: tediExpertise.domainId,
			factCount: tediExpertise.factCount,
			avgConfidence: tediExpertise.avgConfidence,
			expertiseLevel: tediExpertise.expertiseLevel,
			lastActivityAt: tediExpertise.lastActivityAt,
			createdAt: tediExpertise.createdAt,
			updatedAt: tediExpertise.updatedAt,
			domainName: memoryDomains.name,
		})
		.from(tediExpertise)
		.leftJoin(memoryDomains, eq(tediExpertise.domainId, memoryDomains.id))
		.where(and(...conditions));

	// Compute weighted competence scores from memory_facts:
	// competenceScore = AVG(confidence * usageBoost) per domain
	// where usageBoost = clamp(0.3, usageCount / max(1, accessCount), 2.0)
	const domainIds = rows.map((r) => r.domainId).filter(Boolean) as string[];
	const competenceMap = new Map<string, number>();

	if (domainIds.length > 0) {
		const competenceRows = await db
			.select({
				domainId: memoryFacts.domainId,
				competenceScore: sql<number>`COALESCE(AVG(
					${memoryFacts.confidence} * MIN(2.0, MAX(0.3, CAST(COALESCE(${memoryFacts.usageCount}, 0) AS REAL) / MAX(1, COALESCE(${memoryFacts.accessCount}, 1))))
				), 0)`,
			})
			.from(memoryFacts)
			.where(
				and(eq(memoryFacts.tediId, tediId), isNull(memoryFacts.archivedAt)),
			)
			.groupBy(memoryFacts.domainId);
		for (const row of competenceRows) {
			if (row.domainId) {
				competenceMap.set(row.domainId, row.competenceScore ?? 0);
			}
		}
	}

	return rows.map((row) => ({
		...row,
		competenceScore: competenceMap.get(row.domainId) ?? 0,
	}));
}

function calculateExpertiseLevel(
	factCount: number,
	avgConfidence: number,
): ExpertiseLevel {
	if (factCount >= 41 && avgConfidence > 0.7) return "expert";
	if (factCount >= 16) return "proficient";
	if (factCount >= 6) return "familiar";
	return "novice";
}
export async function recalculateExpertise(
	db: DbClient,
	tediId: string,
	domainId: string,
): Promise<TediExpertise> {
	const result = await db
		.select({
			factCount: count(memoryFacts.id),
			avgConf: sql<number>`COALESCE(avg(${memoryFacts.confidence}), 0)`,
		})
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.tediId, tediId),
				eq(memoryFacts.domainId, domainId),
				isNull(memoryFacts.archivedAt),
			),
		);

	const fc = result[0]?.factCount ?? 0;
	const ac = result[0]?.avgConf ?? 0;
	const level = calculateExpertiseLevel(fc, ac);

	return upsertExpertise(db, {
		tediId,
		domainId,
		factCount: fc,
		avgConfidence: ac,
		expertiseLevel: level,
	});
}
