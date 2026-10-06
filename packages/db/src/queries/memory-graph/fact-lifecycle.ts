import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { memoryFacts } from "../../schema/memory-graph";
import { batchNonEmpty } from "../../utils/batch";
import { getAffectedRows } from "../../utils/d1-result";

export async function decayConfidence(
	db: DbClient,
	orgId: string,
	decayFactor: number = 0.99,
	minConfidence: number = 0.1,
	options?: { tediId?: string; domainId?: string; factIds?: string[] },
): Promise<number> {
	if (options?.factIds?.length === 0) return 0;
	// Usage-reinforced decay: facts with high usage decay slower, unused facts decay faster.
	// Linear approximation (D1/SQLite-compatible, no POWER() needed):
	//   effective_decay = 1 - (1 - decayFactor) / usageBoost
	// where usageBoost = clamp(0.3, usageCount / max(1, accessCount), 2.0)
	// - usageBoost ~2.0 (frequently used) → decay 0.9975 (slower)
	// - usageBoost ~0.3 (retrieved but never used) → decay 0.9833 (faster)
	// - usageBoost ~1.0 (balanced) → decay 0.995 (baseline)
	// Only decay facts not accessed/verified in 7+ days,
	// and only if they haven't already been decayed today (updatedAt guard).
	const now = new Date();
	const sevenDaysAgo = new Date(
		now.getTime() - 7 * 24 * 60 * 60 * 1000,
	).toISOString();
	const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

	const baseConditions = [
		eq(memoryFacts.organizationId, orgId),
		isNull(memoryFacts.archivedAt),
		sql`${memoryFacts.validTo} IS NULL`,
		sql`COALESCE(${memoryFacts.lastVerifiedAt}, ${memoryFacts.lastAccessedAt}, ${memoryFacts.createdAt}) < ${sevenDaysAgo}`,
		sql`${memoryFacts.updatedAt} < ${oneDayAgo}`,
	];

	if (options?.tediId) {
		baseConditions.push(eq(memoryFacts.tediId, options.tediId));
	}
	if (options?.domainId) {
		baseConditions.push(eq(memoryFacts.domainId, options.domainId));
	}

	if (options?.factIds)
		baseConditions.push(
			sql`${memoryFacts.id} IN (SELECT value FROM json_each(${JSON.stringify(options.factIds)}))`,
		);

	// Usage boost = clamp(0.3, usageCount/max(1,accessCount), 2.0)
	const usageBoostSql = sql`MIN(2.0, MAX(0.3, CAST(COALESCE(${memoryFacts.usageCount}, 0) AS REAL) / MAX(1, COALESCE(${memoryFacts.accessCount}, 1))))`;

	// Non-core facts: usage-reinforced decay
	const nonCoreConditions = [
		...baseConditions,
		sql`COALESCE(${memoryFacts.priority}, 'active') != 'core'`,
	];

	// effective_decay = 1 - (1 - decayFactor) / usageBoost
	const decayLoss = 1 - decayFactor; // e.g. 0.005 for 0.995

	const nonCoreResult = await db
		.update(memoryFacts)
		.set({
			confidence: sql`MAX(${minConfidence}, ${memoryFacts.confidence} * (1.0 - ${decayLoss} / ${usageBoostSql}))`,
			updatedAt: now.toISOString(),
		})
		.where(and(...nonCoreConditions));

	// Core facts: 10x slower decay, also usage-reinforced
	const coreDecayFactor = 1 - (1 - decayFactor) / 10;
	const coreConditions = [...baseConditions, eq(memoryFacts.priority, "core")];

	const coreDecayLoss = 1 - coreDecayFactor;

	const coreResult = await db
		.update(memoryFacts)
		.set({
			confidence: sql`MAX(${minConfidence}, ${memoryFacts.confidence} * (1.0 - ${coreDecayLoss} / ${usageBoostSql}))`,
			updatedAt: now.toISOString(),
		})
		.where(and(...coreConditions));

	const nonCoreRows = getAffectedRows(nonCoreResult);
	const coreRows = getAffectedRows(coreResult);
	return nonCoreRows + coreRows;
}

export async function archiveLowConfidence(
	db: DbClient,
	orgId: string,
	threshold: number = 0.2,
	options?: { tediId?: string; domainId?: string; factIds?: string[] },
): Promise<{ count: number; archivedIds: string[] }> {
	if (options?.factIds?.length === 0) return { count: 0, archivedIds: [] };
	const conditions = [
		eq(memoryFacts.organizationId, orgId),
		isNull(memoryFacts.archivedAt),
		sql`${memoryFacts.confidence} < ${threshold}`,
	];
	if (options?.factIds)
		conditions.push(
			sql`${memoryFacts.id} IN (SELECT value FROM json_each(${JSON.stringify(options.factIds)}))`,
		);

	if (options?.tediId) {
		conditions.push(eq(memoryFacts.tediId, options.tediId));
	}
	if (options?.domainId) {
		conditions.push(eq(memoryFacts.domainId, options.domainId));
	}

	// Archiving is a lifecycle content change, so it bumps updatedAt like its
	// siblings invalidateFact and promoteFromProbation do. Without it the
	// lifecycle parity gate cannot see its own work: that gate samples archived
	// rows ordered by desc(COALESCE(updatedAt, createdAt)) capped at 25
	// (graph-projection-health.ts), so a fact archived with a month-old timestamp
	// sorts out of the sample — the check that verifies archival reached Neo4j is
	// least likely to look at the rows that were just archived.
	const archivedAt = new Date().toISOString();
	const rows = await db
		.update(memoryFacts)
		.set({ archivedAt, updatedAt: archivedAt })
		.where(and(...conditions))
		.returning({ id: memoryFacts.id });
	return { count: rows.length, archivedIds: rows.map((r) => r.id) };
}

/**
 * Bi-temporal invalidation: mark a fact as no longer valid without deleting it.
 * Sets validTo = now, preserving history for provenance queries.
 */
export async function invalidateFact(
	db: DbClient,
	factId: string,
	reason?: string,
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.update(memoryFacts)
		.set({
			validTo: now,
			updatedAt: now,
			metadata: reason
				? sql`json_set(COALESCE(${memoryFacts.metadata}, '{}'), '$.invalidationReason', ${reason})`
				: undefined,
		})
		.where(eq(memoryFacts.id, factId));
}

/** Promote retrieved probation facts only after their producer's evidence gate. */
export async function promoteFromProbation(
	db: DbClient,
	orgId: string,
	minAccessCount: number = 1,
): Promise<number> {
	const result = await db
		.update(memoryFacts)
		.set({
			status: "active",
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				eq(memoryFacts.status, "probation"),
				isNull(memoryFacts.archivedAt),
				sql`${memoryFacts.validTo} IS NULL`,
				sql`${memoryFacts.accessCount} >= ${minAccessCount}`,
				// The afterTurn bridge writes observation:// facts. Access alone is
				// not proof that an observer's generated claim is true or durable.
				// Legacy observations without a verdict stay probationary; other
				// producers retain their existing access-based promotion path.
				sql`CASE WHEN COALESCE(${memoryFacts.source}, '') LIKE 'observation://%'
					THEN CASE WHEN json_valid(${memoryFacts.metadata})
						THEN json_extract(${memoryFacts.metadata}, '$.memoryQuality.recipe') = 'memory-quality-v1'
							AND json_extract(${memoryFacts.metadata}, '$.memoryQuality.verdict') = 'durable_candidate'
							AND json_type(${memoryFacts.metadata}, '$.memoryQuality.sourceEvidenceSha256') = 'text'
							AND length(json_extract(${memoryFacts.metadata}, '$.memoryQuality.sourceEvidenceSha256')) = 64
						ELSE 0 END
				ELSE 1 END`,
			),
		);
	return getAffectedRows(result);
}

/**
 * Expire stale probation facts that were never accessed within the probation window.
 */
export async function expireProbation(
	db: DbClient,
	orgId: string,
	maxAgeDays: number = 7,
): Promise<{ count: number; expiredIds: string[] }> {
	const cutoff = new Date(
		Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
	).toISOString();
	// Same lifecycle bump as archiveLowConfidence. Starker here: the sibling that
	// handles the opposite transition, promoteFromProbation, already sets
	// updatedAt — so promoted facts surfaced in freshness-ordered samples and
	// expired ones did not.
	const expiredAt = new Date().toISOString();
	const rows = await db
		.update(memoryFacts)
		.set({ archivedAt: expiredAt, updatedAt: expiredAt })
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				eq(memoryFacts.status, "probation"),
				isNull(memoryFacts.archivedAt),
				sql`${memoryFacts.accessCount} = 0`,
				sql`${memoryFacts.createdAt} < ${cutoff}`,
			),
		)
		.returning({ id: memoryFacts.id });
	return { count: rows.length, expiredIds: rows.map((r) => r.id) };
}

export async function boostConfidence(
	db: DbClient,
	factIds: string[],
	boostFactor: number = 1.05,
): Promise<void> {
	if (factIds.length === 0) return;
	// Batch all updates into a single D1 round-trip
	const queries = factIds.map((factId) =>
		db
			.update(memoryFacts)
			.set({
				confidence: sql`MIN(1.0, ${memoryFacts.confidence} * ${boostFactor})`,
			})
			.where(eq(memoryFacts.id, factId)),
	);
	await db.batch(batchNonEmpty(queries));
}

export async function resetCollapsedConfidence(
	db: DbClient,
	orgId: string,
	resetTo: number = 0.8,
	factIds?: string[],
): Promise<number> {
	if (factIds?.length === 0) return 0;
	const selection =
		factIds === undefined
			? undefined
			: sql`${memoryFacts.id} IN (SELECT value FROM json_each(${JSON.stringify(factIds)}))`;
	// Detect collapse: if average confidence of non-archived facts is < 0.1, reset all to resetTo
	const avgResult = await db
		.select({ avg: sql<number>`AVG(${memoryFacts.confidence})` })
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				isNull(memoryFacts.archivedAt),
				selection,
			),
		);

	const avgConfidence = Number(avgResult[0]?.avg ?? 1.0);
	console.log(
		`[MemoryGraph] Average confidence: ${avgConfidence} (raw: ${avgResult[0]?.avg})`,
	);
	if (avgConfidence >= 0.1) return 0;

	console.warn(
		`[MemoryGraph] CONFIDENCE COLLAPSE DETECTED: avg=${avgConfidence.toFixed(4)}. Resetting non-archived facts to ${resetTo}.`,
	);

	const result = await db
		.update(memoryFacts)
		.set({
			confidence: resetTo,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				isNull(memoryFacts.archivedAt),
				selection,
			),
		);

	return getAffectedRows(result);
}

// ============================================================================
// Visibility-aware search
// ============================================================================
