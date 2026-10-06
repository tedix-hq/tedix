import { sql } from "drizzle-orm";
import type { DbClient } from "../../client";

export interface FactTierRow {
	tier: string;
	cnt: number;
	avgConf: number;
}

export interface ConfidenceHistogramRow {
	bucket: string;
	cnt: number;
}

/**
 * Get tier distribution of active facts using CASE-based classification.
 * Tiers: probation, active_low, active_mid, active_high, gold.
 */
export async function getFactTierDistribution(
	db: DbClient,
	orgId: string,
	tediId?: string,
): Promise<FactTierRow[]> {
	const tediFilter = tediId
		? sql`AND (tedi_id = ${tediId} OR tedi_id IS NULL)`
		: sql``;

	return db.all<FactTierRow>(
		sql`SELECT
			CASE
				WHEN status = 'probation' THEN 'probation'
				WHEN confidence >= 0.85 AND access_count > 5 THEN 'gold'
				WHEN confidence >= 0.7 THEN 'active_high'
				WHEN confidence >= 0.5 THEN 'active_mid'
				ELSE 'active_low'
			END as tier,
			count(*) as cnt,
			avg(confidence) as avgConf
		FROM memory_facts
		WHERE organization_id = ${orgId}
			AND archived_at IS NULL
			AND valid_to IS NULL
			${tediFilter}
		GROUP BY tier
		ORDER BY
			CASE tier
				WHEN 'probation' THEN 1
				WHEN 'active_low' THEN 2
				WHEN 'active_mid' THEN 3
				WHEN 'active_high' THEN 4
				WHEN 'gold' THEN 5
			END`,
	);
}

/**
 * Get confidence histogram of active facts in 10% buckets.
 */
export async function getFactConfidenceHistogram(
	db: DbClient,
	orgId: string,
	tediId?: string,
): Promise<ConfidenceHistogramRow[]> {
	const tediFilter = tediId
		? sql`AND (tedi_id = ${tediId} OR tedi_id IS NULL)`
		: sql``;

	return db.all<ConfidenceHistogramRow>(
		sql`SELECT
			CASE
				WHEN confidence < 0.1 THEN '0-10%'
				WHEN confidence < 0.2 THEN '10-20%'
				WHEN confidence < 0.3 THEN '20-30%'
				WHEN confidence < 0.4 THEN '30-40%'
				WHEN confidence < 0.5 THEN '40-50%'
				WHEN confidence < 0.6 THEN '50-60%'
				WHEN confidence < 0.7 THEN '60-70%'
				WHEN confidence < 0.8 THEN '70-80%'
				WHEN confidence < 0.9 THEN '80-90%'
				ELSE '90-100%'
			END as bucket,
			count(*) as cnt
		FROM memory_facts
		WHERE organization_id = ${orgId}
			AND archived_at IS NULL
			AND valid_to IS NULL
			${tediFilter}
		GROUP BY bucket
		ORDER BY confidence`,
	);
}
