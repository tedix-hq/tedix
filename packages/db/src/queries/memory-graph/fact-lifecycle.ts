import { type TenantScope, normalizeTenantScope } from "../../tenant-scope";
import { refreshConsolidatedForFact } from "./observations";
import { and, asc, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { DbClient } from "../../client";
import { memoryFacts } from "../../schema/memory-graph";
import { getAffectedRows } from "../../utils/d1-result";
import type { FactChangeRecorder } from "./memory-adapter";
import { freshReadMarkExists } from "../read-marks";

/**
 * Admit a bounded set of lifecycle changes before mutating rows. Returns null
 * when the recorder has no daily budget so the caller keeps its existing path.
 */
async function cappedLifecycleFactIds(
	db: DbClient,
	organizationId: string,
	conditions: SQL<unknown>[],
	recordChange: FactChangeRecorder | undefined,
): Promise<string[] | null> {
	if (!recordChange?.reserve) return null;
	const remaining = recordChange.remaining
		? await recordChange.remaining(organizationId)
		: Number.MAX_SAFE_INTEGER;
	const maxCandidates = Math.max(0, Math.floor(remaining));
	if (maxCandidates === 0) return [];
	const candidates = await db
		.select({ id: memoryFacts.id })
		.from(memoryFacts)
		.where(and(...conditions))
		.orderBy(asc(memoryFacts.createdAt), asc(memoryFacts.id))
		.limit(maxCandidates);
	if (candidates.length === 0) return [];
	const allowed = await recordChange.reserve(organizationId, candidates.length);
	return candidates.slice(0, allowed).map((row) => row.id);
}

export async function decayConfidence(
	db: DbClient,
	tenantScope: TenantScope,
	decayFactor: number = 0.99,
	minConfidence: number = 0.1,
	options?: { tediId?: string; domainId?: string; factIds?: string[] },
): Promise<number> {
	const { organizationId: orgId } = normalizeTenantScope(tenantScope);
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
	// A lesson read within the decay window is not stale: lesson reads leave a
	// daily date in read_marks even when they never bump last_accessed_at.
	const lessonReadCutoff = sevenDaysAgo.slice(0, 10);

	const baseConditions = [
		eq(memoryFacts.organizationId, orgId),
		isNull(memoryFacts.archivedAt),
		sql`${memoryFacts.validTo} IS NULL`,
		sql`COALESCE(${memoryFacts.lastVerifiedAt}, ${memoryFacts.lastAccessedAt}, ${memoryFacts.createdAt}) < ${sevenDaysAgo}`,
		sql`${memoryFacts.updatedAt} < ${oneDayAgo}`,
		sql`NOT ${freshReadMarkExists({
			organizationId: orgId,
			kind: "lesson",
			rowId: memoryFacts.id,
			sinceDate: lessonReadCutoff,
		})}`,
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
	tenantScope: TenantScope,
	threshold: number = 0.2,
	options?: { tediId?: string; domainId?: string; factIds?: string[] },
	recordChange?: FactChangeRecorder,
): Promise<{ count: number; archivedIds: string[] }> {
	const { organizationId: orgId } = normalizeTenantScope(tenantScope);
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
	const cappedIds = await cappedLifecycleFactIds(
		db,
		orgId,
		conditions,
		recordChange,
	);
	if (cappedIds) {
		if (cappedIds.length === 0) return { count: 0, archivedIds: [] };
		const rows = await db
			.update(memoryFacts)
			.set({ archivedAt, updatedAt: archivedAt })
			.where(
				and(
					...conditions,
					sql`${memoryFacts.id} IN (SELECT value FROM json_each(${JSON.stringify(cappedIds)}))`,
				),
			)
			.returning();
		for (const fact of rows) await recordChange?.(fact);
		return { count: rows.length, archivedIds: rows.map((row) => row.id) };
	}
	const mutation = db
		.update(memoryFacts)
		.set({ archivedAt, updatedAt: archivedAt })
		.where(and(...conditions));
	const rows = recordChange
		? await mutation.returning().then(async (facts) => {
				for (const fact of facts) await recordChange(fact);
				return facts.map(({ id }) => ({ id }));
			})
		: await mutation.returning({ id: memoryFacts.id });
	return { count: rows.length, archivedIds: rows.map((r) => r.id) };
}

/**
 * Bi-temporal invalidation: mark a fact as no longer valid without deleting it.
 * Sets validTo = now, preserving history for provenance queries.
 */
export async function invalidateFact(
	db: DbClient,
	tenantScope: TenantScope,
	factId: string,
	reason?: string,
	recordChange?: FactChangeRecorder,
): Promise<void> {
	const { organizationId } = normalizeTenantScope(tenantScope);
	if (
		recordChange?.reserve &&
		(await recordChange.reserve(organizationId, 1)) === 0
	) {
		return;
	}
	const now = new Date().toISOString();
	const mutation = db
		.update(memoryFacts)
		.set({
			validTo: now,
			updatedAt: now,
			metadata: reason
				? sql`json_set(COALESCE(${memoryFacts.metadata}, '{}'), '$.invalidationReason', ${reason})`
				: undefined,
		})
		.where(
			and(
				eq(memoryFacts.organizationId, organizationId),
				eq(memoryFacts.id, factId),
			),
		);
	const changed = recordChange
		? await mutation.returning()
		: (await mutation, []);
	const [fact] = await db
		.select({ orgId: memoryFacts.organizationId })
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, organizationId),
				eq(memoryFacts.id, factId),
			),
		);
	if (fact) await refreshConsolidatedForFact(db, tenantScope, factId);
	for (const row of changed) await recordChange?.(row);
}

/** Promote retrieved probation facts unless the evidence check rejected them. */
export async function promoteFromProbation(
	db: DbClient,
	tenantScope: TenantScope,
	minAccessCount: number = 1,
	recordChange?: FactChangeRecorder,
): Promise<number> {
	const { organizationId: orgId } = normalizeTenantScope(tenantScope);
	const conditions: SQL<unknown>[] = [
		eq(memoryFacts.organizationId, orgId),
		eq(memoryFacts.status, "probation"),
		isNull(memoryFacts.archivedAt),
		sql`${memoryFacts.validTo} IS NULL`,
		sql`${memoryFacts.accessCount} >= ${minAccessCount}`,
		// The afterTurn bridge writes observation:// facts. Use earns
		// promotion like any other fact; only an observation the evidence
		// check found unsupported stays probationary. Malformed metadata
		// cannot prove it passed, so it also stays.
		sql`CASE WHEN COALESCE(${memoryFacts.source}, '') LIKE 'observation://%'
			THEN CASE WHEN json_valid(COALESCE(${memoryFacts.metadata}, '{}'))
				THEN COALESCE(json_extract(COALESCE(${memoryFacts.metadata}, '{}'), '$.memoryQuality.verdict'), '')
					NOT IN ('unsupported', 'transient_or_unsupported')
				ELSE 0 END
		ELSE 1 END`,
	];
	const updatedAt = new Date().toISOString();
	const cappedIds = await cappedLifecycleFactIds(
		db,
		orgId,
		conditions,
		recordChange,
	);
	if (cappedIds) {
		if (cappedIds.length === 0) return 0;
		const rows = await db
			.update(memoryFacts)
			.set({ status: "active", updatedAt })
			.where(
				and(
					...conditions,
					sql`${memoryFacts.id} IN (SELECT value FROM json_each(${JSON.stringify(cappedIds)}))`,
				),
			)
			.returning();
		for (const fact of rows) await recordChange?.(fact);
		return rows.length;
	}
	const mutation = db
		.update(memoryFacts)
		.set({ status: "active", updatedAt })
		.where(and(...conditions));
	if (!recordChange) return getAffectedRows(await mutation);
	const rows = await mutation.returning();
	for (const fact of rows) await recordChange(fact);
	return rows.length;
}

/**
 * Expire stale probation facts that were never accessed within the probation window.
 */
export async function expireProbation(
	db: DbClient,
	tenantScope: TenantScope,
	maxAgeDays: number = 7,
	recordChange?: FactChangeRecorder,
): Promise<{ count: number; expiredIds: string[] }> {
	const { organizationId: orgId } = normalizeTenantScope(tenantScope);
	const cutoff = new Date(
		Date.now() - maxAgeDays * 24 * 60 * 60 * 1000,
	).toISOString();
	// A lesson read within the probation window is accessed, even when the
	// access never reached access_count: reads leave a daily date in
	// read_marks (kind 'lesson').
	const lessonReadCutoff = cutoff.slice(0, 10);
	// Same lifecycle bump as archiveLowConfidence. Starker here: the sibling that
	// handles the opposite transition, promoteFromProbation, already sets
	// updatedAt — so promoted facts surfaced in freshness-ordered samples and
	// expired ones did not.
	const expiredAt = new Date().toISOString();
	const conditions: SQL<unknown>[] = [
		eq(memoryFacts.organizationId, orgId),
		eq(memoryFacts.status, "probation"),
		isNull(memoryFacts.archivedAt),
		sql`${memoryFacts.accessCount} = 0`,
		sql`${memoryFacts.createdAt} < ${cutoff}`,
		sql`NOT ${freshReadMarkExists({
			organizationId: orgId,
			kind: "lesson",
			rowId: memoryFacts.id,
			sinceDate: lessonReadCutoff,
		})}`,
	];
	const cappedIds = await cappedLifecycleFactIds(
		db,
		orgId,
		conditions,
		recordChange,
	);
	if (cappedIds) {
		if (cappedIds.length === 0) return { count: 0, expiredIds: [] };
		const rows = await db
			.update(memoryFacts)
			.set({ archivedAt: expiredAt, updatedAt: expiredAt })
			.where(
				and(
					...conditions,
					sql`${memoryFacts.id} IN (SELECT value FROM json_each(${JSON.stringify(cappedIds)}))`,
				),
			)
			.returning();
		for (const fact of rows) await recordChange?.(fact);
		return { count: rows.length, expiredIds: rows.map((row) => row.id) };
	}
	const mutation = db
		.update(memoryFacts)
		.set({ archivedAt: expiredAt, updatedAt: expiredAt })
		.where(and(...conditions));
	const rows = recordChange
		? await mutation.returning().then(async (facts) => {
				for (const fact of facts) await recordChange(fact);
				return facts.map(({ id }) => ({ id }));
			})
		: await mutation.returning({ id: memoryFacts.id });
	return { count: rows.length, expiredIds: rows.map((r) => r.id) };
}

export async function resetCollapsedConfidence(
	db: DbClient,
	tenantScope: TenantScope,
	resetTo: number = 0.8,
	factIds?: string[],
): Promise<number> {
	const { organizationId: orgId } = normalizeTenantScope(tenantScope);
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
