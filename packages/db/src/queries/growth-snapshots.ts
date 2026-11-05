/**
 * Tedi Growth Snapshot Query Helpers
 * CRUD operations for the tedi_growth_snapshots table
 *
 * Used by the growth snapshots router, Growth Timeline UI,
 * and the weekly growth snapshot cron.
 */

import {
	count,
	countDistinct,
	desc,
	eq,
	inArray,
	isNull,
	sql,
} from "drizzle-orm";
import type { DbClient } from "../client";
import { createDbQueryClient } from "../query-client";
import { skillEntries, tediMuscleMemory } from "../schema/cognitive";
import { memoryFacts, tediExpertise } from "../schema/memory-graph";
import { tediRationaleRecords } from "../schema/rationale-records";
import { tedis as tedisTable } from "../schema/tedis";
import { chunkForBoundParams } from "../utils/batch";

const D1_IN_LIST_CHUNK = 50;
import {
	type GrowthSnapshotMetrics,
	type TediGrowthSnapshot,
	tediGrowthSnapshots,
} from "../schema/tedi-growth-snapshots";

// ============================================================================
// Read Operations
// ============================================================================

/**
 * List growth snapshots for a tedi, ordered by date descending
 */
export async function listGrowthSnapshots(
	db: DbClient,
	tediId: string,
	limit = 52,
	offset = 0,
): Promise<{ data: TediGrowthSnapshot[]; total: number }> {
	const [data, total] = await Promise.all([
		db
			.select()
			.from(tediGrowthSnapshots)
			.where(eq(tediGrowthSnapshots.tediId, tediId))
			.orderBy(desc(tediGrowthSnapshots.snapshotDate))
			.limit(limit)
			.offset(offset),
		db.$count(tediGrowthSnapshots, eq(tediGrowthSnapshots.tediId, tediId)),
	]);

	return { data, total };
}

/**
 * Get the most recent growth snapshot for a tedi
 */
export async function getLatestGrowthSnapshot(
	db: DbClient,
	tediId: string,
): Promise<TediGrowthSnapshot | null> {
	const [row] = await db
		.select()
		.from(tediGrowthSnapshots)
		.where(eq(tediGrowthSnapshots.tediId, tediId))
		.orderBy(desc(tediGrowthSnapshots.snapshotDate))
		.limit(1);
	return row ?? null;
}

// ============================================================================
// Write Operations
// ============================================================================

/**
 * Create a growth snapshot (upserts on tediId + snapshotDate)
 */
export async function createGrowthSnapshot(
	db: DbClient,
	data: {
		tediId: string;
		orgId: string;
		snapshotDate: string;
		metrics: GrowthSnapshotMetrics;
	},
): Promise<TediGrowthSnapshot> {
	const [row] = await db
		.insert(tediGrowthSnapshots)
		.values({
			tediId: data.tediId,
			orgId: data.orgId,
			snapshotDate: data.snapshotDate,
			metrics: data.metrics,
		})
		.onConflictDoUpdate({
			target: [tediGrowthSnapshots.tediId, tediGrowthSnapshots.snapshotDate],
			set: { metrics: data.metrics },
		})
		.returning();
	return row!;
}

// ============================================================================
// Batch Collection (Cron)
// ============================================================================

/**
 * Metrics row returned by the batch SQL query for a single tedi.
 */
type TediMetricsRow = {
	tedi_id: string;
	org_id: string;
	facts: number;
	avg_confidence: number;
	skills: number;
	avg_revision: number;
	muscles: number;
	avg_usage: number;
	domains: number;
};

/**
 * Autonomy row — auto-approved ratio per tedi from rationale records.
 */
type AutonomyRow = {
	tedi_id: string;
	total: number;
	auto_approved: number;
};

/**
 * Expertise row — domain expertise levels per tedi.
 */
type ExpertiseRow = {
	tedi_id: string;
	domain_id: string;
	expertise_level: string;
};

/**
 * Collect cognitive metrics for ALL active tedis in batch.
 * Three bulk queries — no per-tedi round trips.
 *
 * Returns an array ready to be inserted via createGrowthSnapshot.
 */
export async function collectAllTediGrowthMetrics(
	d1: D1Database,
	snapshotDate: string,
): Promise<
	Array<{
		tediId: string;
		orgId: string;
		snapshotDate: string;
		metrics: GrowthSnapshotMetrics;
	}>
> {
	const db = createDbQueryClient(d1);

	// 1. Get all active tedis with their core cognitive counts in one query
	const f = db
		.select({
			tediId: memoryFacts.tediId,
			factCount: count().as("fact_count"),
			avgConfidence: sql<number>`AVG(${memoryFacts.confidence})`.as(
				"avg_confidence",
			),
		})
		.from(memoryFacts)
		.where(isNull(memoryFacts.archivedAt))
		.groupBy(memoryFacts.tediId)
		.as("f");
	const s = db
		.select({
			tediId: skillEntries.tediId,
			skillCount: count().as("skill_count"),
			avgRevision: sql<number>`AVG(${skillEntries.revision})`.as(
				"avg_revision",
			),
		})
		.from(skillEntries)
		.groupBy(skillEntries.tediId)
		.as("s");
	const m = db
		.select({
			tediId: tediMuscleMemory.tediId,
			muscleCount: count().as("muscle_count"),
			avgUsage: sql<number>`AVG(${tediMuscleMemory.usageCount})`.as(
				"avg_usage",
			),
		})
		.from(tediMuscleMemory)
		.groupBy(tediMuscleMemory.tediId)
		.as("m");
	const d = db
		.select({
			tediId: tediExpertise.tediId,
			domainCount: countDistinct(tediExpertise.domainId).as("domain_count"),
		})
		.from(tediExpertise)
		.groupBy(tediExpertise.tediId)
		.as("d");
	const tedis: TediMetricsRow[] = await db
		.select({
			tedi_id: sql<string>`${tedisTable.id}`.as("tedi_id"),
			org_id: sql<string>`${tedisTable.organizationId}`.as("org_id"),
			facts: sql<number>`COALESCE(${f.factCount}, 0)`.as("facts"),
			avg_confidence: sql<number>`COALESCE(${f.avgConfidence}, 0)`.as(
				"avg_confidence",
			),
			skills: sql<number>`COALESCE(${s.skillCount}, 0)`.as("skills"),
			avg_revision: sql<number>`COALESCE(${s.avgRevision}, 0)`.as(
				"avg_revision",
			),
			muscles: sql<number>`COALESCE(${m.muscleCount}, 0)`.as("muscles"),
			avg_usage: sql<number>`COALESCE(${m.avgUsage}, 0)`.as("avg_usage"),
			domains: sql<number>`COALESCE(${d.domainCount}, 0)`.as("domains"),
		})
		.from(tedisTable)
		.leftJoin(f, eq(f.tediId, tedisTable.id))
		.leftJoin(s, eq(s.tediId, tedisTable.id))
		.leftJoin(m, eq(m.tediId, tedisTable.id))
		.leftJoin(d, eq(d.tediId, tedisTable.id))
		.where(eq(tedisTable.status, "active"));

	if (tedis.length === 0) return [];

	const tediIds = tedis.map((t) => t.tedi_id);

	// D1 caps bound parameters per statement; each chunk's groups are disjoint
	// by tedi, so merged rows equal one unchunked read.
	const tediIdChunks = chunkForBoundParams(tediIds, D1_IN_LIST_CHUNK);

	// 2. Batch autonomy rate from rationale records
	const autonomyRows: AutonomyRow[] = [];
	for (const ids of tediIdChunks) {
		autonomyRows.push(
			...(await db
				.select({
					tedi_id: sql<string>`${tediRationaleRecords.tediId}`.as("tedi_id"),
					total: count().as("total"),
					auto_approved:
						sql<number>`SUM(CASE WHEN ${tediRationaleRecords.approvalRequestId} IS NULL THEN 1 ELSE 0 END)`.as(
							"auto_approved",
						),
				})
				.from(tediRationaleRecords)
				.where(inArray(tediRationaleRecords.tediId, ids))
				.groupBy(tediRationaleRecords.tediId)),
		);
	}

	const autonomyMap = new Map<string, number>();
	for (const row of autonomyRows) {
		autonomyMap.set(
			row.tedi_id,
			row.total > 0 ? row.auto_approved / row.total : 0,
		);
	}

	// 3. Batch expertise levels per domain
	const expertiseRows: ExpertiseRow[] = [];
	for (const ids of tediIdChunks) {
		expertiseRows.push(
			...(await db
				.select({
					tedi_id: tediExpertise.tediId,
					domain_id: tediExpertise.domainId,
					expertise_level: tediExpertise.expertiseLevel,
				})
				.from(tediExpertise)
				.where(inArray(tediExpertise.tediId, ids))),
		);
	}

	const expertiseMap = new Map<string, Record<string, string>>();
	for (const row of expertiseRows) {
		if (!expertiseMap.has(row.tedi_id)) {
			expertiseMap.set(row.tedi_id, {});
		}
		expertiseMap.get(row.tedi_id)![row.domain_id] = row.expertise_level;
	}

	// 4. Assemble snapshot data for each tedi
	return tedis.map((t) => ({
		tediId: t.tedi_id,
		orgId: t.org_id,
		snapshotDate,
		metrics: {
			facts: t.facts,
			avgConfidence: Math.round(t.avg_confidence * 1000) / 1000,
			skills: t.skills,
			avgRevision: Math.round(t.avg_revision * 100) / 100,
			muscles: t.muscles,
			avgUsage: Math.round(t.avg_usage * 100) / 100,
			domains: t.domains,
			autonomyRate: Math.round((autonomyMap.get(t.tedi_id) ?? 0) * 1000) / 1000,
			expertiseLevels: expertiseMap.get(t.tedi_id) ?? {},
		},
	}));
}
