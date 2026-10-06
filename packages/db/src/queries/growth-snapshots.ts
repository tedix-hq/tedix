/**
 * Tedi Growth Snapshot Query Helpers
 * CRUD operations for the tedi_growth_snapshots table
 *
 * Used by the growth snapshots router, Growth Timeline UI,
 * and the weekly growth snapshot cron.
 */

import { desc, eq } from "drizzle-orm";
import type { DbClient } from "../client";
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
 * Uses raw D1 SQL for efficiency — no per-tedi round trips.
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
	// 1. Get all active tedis with their core cognitive counts in one query
	const metricsResult = await d1
		.prepare(
			`
		SELECT
			t.id AS tedi_id,
			t.organization_id AS org_id,
			COALESCE(f.fact_count, 0) AS facts,
			COALESCE(f.avg_confidence, 0) AS avg_confidence,
			COALESCE(s.skill_count, 0) AS skills,
			COALESCE(s.avg_revision, 0) AS avg_revision,
			COALESCE(m.muscle_count, 0) AS muscles,
			COALESCE(m.avg_usage, 0) AS avg_usage,
			COALESCE(d.domain_count, 0) AS domains
		FROM tedis t
		LEFT JOIN (
			SELECT tedi_id,
				COUNT(*) AS fact_count,
				AVG(confidence) AS avg_confidence
			FROM memory_facts
			WHERE archived_at IS NULL
			GROUP BY tedi_id
		) f ON f.tedi_id = t.id
		LEFT JOIN (
			SELECT tedi_id,
				COUNT(*) AS skill_count,
				AVG(revision) AS avg_revision
			FROM skill_entries
			GROUP BY tedi_id
		) s ON s.tedi_id = t.id
		LEFT JOIN (
			SELECT tedi_id,
				COUNT(*) AS muscle_count,
				AVG(usage_count) AS avg_usage
			FROM tedi_muscle_memory
			GROUP BY tedi_id
		) m ON m.tedi_id = t.id
		LEFT JOIN (
			SELECT tedi_id,
				COUNT(DISTINCT domain_id) AS domain_count
			FROM tedi_expertise
			GROUP BY tedi_id
		) d ON d.tedi_id = t.id
		WHERE t.status = 'active'
		`,
		)
		.all<TediMetricsRow>();

	const tedis = metricsResult.results;
	if (tedis.length === 0) return [];

	const tediIds = tedis.map((t) => t.tedi_id);

	// 2. Batch autonomy rate from rationale records
	// Use a single query with IN clause for all active tedis
	const placeholders = tediIds.map(() => "?").join(",");
	const autonomyResult = await d1
		.prepare(
			`
		SELECT
			tedi_id,
			COUNT(*) AS total,
			SUM(CASE WHEN approval_request_id IS NULL THEN 1 ELSE 0 END) AS auto_approved
		FROM tedi_rationale_records
		WHERE tedi_id IN (${placeholders})
		GROUP BY tedi_id
		`,
		)
		.bind(...tediIds)
		.all<AutonomyRow>();

	const autonomyMap = new Map<string, number>();
	for (const row of autonomyResult.results) {
		autonomyMap.set(
			row.tedi_id,
			row.total > 0 ? row.auto_approved / row.total : 0,
		);
	}

	// 3. Batch expertise levels per domain
	const expertiseResult = await d1
		.prepare(
			`
		SELECT tedi_id, domain_id, expertise_level
		FROM tedi_expertise
		WHERE tedi_id IN (${placeholders})
		`,
		)
		.bind(...tediIds)
		.all<ExpertiseRow>();

	const expertiseMap = new Map<string, Record<string, string>>();
	for (const row of expertiseResult.results) {
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
