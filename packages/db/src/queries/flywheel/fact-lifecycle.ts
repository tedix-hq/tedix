import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { memoryFacts } from "../../schema/memory-graph";

export interface FactTierRow {
	tier: string;
	cnt: number;
	avgConf: number;
}

export interface ConfidenceHistogramRow {
	bucket: string;
	cnt: number;
}

function activeFactScope(orgId: string, tediId?: string) {
	return and(
		eq(memoryFacts.organizationId, orgId),
		isNull(memoryFacts.archivedAt),
		isNull(memoryFacts.validTo),
		tediId
			? or(eq(memoryFacts.tediId, tediId), isNull(memoryFacts.tediId))
			: undefined,
	);
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
	const tier = sql<string>`CASE
		WHEN ${memoryFacts.status} = 'probation' THEN 'probation'
		WHEN ${memoryFacts.confidence} >= 0.85 AND ${memoryFacts.accessCount} > 5 THEN 'gold'
		WHEN ${memoryFacts.confidence} >= 0.7 THEN 'active_high'
		WHEN ${memoryFacts.confidence} >= 0.5 THEN 'active_mid'
		ELSE 'active_low'
	END`.as("tier");
	return db
		.select({
			tier,
			cnt: sql<number>`count(*)`.as("cnt"),
			avgConf: sql<number>`avg(${memoryFacts.confidence})`.as("avgConf"),
		})
		.from(memoryFacts)
		.where(activeFactScope(orgId, tediId))
		.groupBy(tier)
		.orderBy(
			sql`CASE ${tier}
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
	const bucket = sql<string>`CASE
		WHEN ${memoryFacts.confidence} < 0.1 THEN '0-10%'
		WHEN ${memoryFacts.confidence} < 0.2 THEN '10-20%'
		WHEN ${memoryFacts.confidence} < 0.3 THEN '20-30%'
		WHEN ${memoryFacts.confidence} < 0.4 THEN '30-40%'
		WHEN ${memoryFacts.confidence} < 0.5 THEN '40-50%'
		WHEN ${memoryFacts.confidence} < 0.6 THEN '50-60%'
		WHEN ${memoryFacts.confidence} < 0.7 THEN '60-70%'
		WHEN ${memoryFacts.confidence} < 0.8 THEN '70-80%'
		WHEN ${memoryFacts.confidence} < 0.9 THEN '80-90%'
		ELSE '90-100%'
	END`.as("bucket");
	return db
		.select({ bucket, cnt: sql<number>`count(*)`.as("cnt") })
		.from(memoryFacts)
		.where(activeFactScope(orgId, tediId))
		.groupBy(bucket)
		.orderBy(memoryFacts.confidence);
}
