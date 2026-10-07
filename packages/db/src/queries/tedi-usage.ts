import { getColumns } from "drizzle-orm";
import {
	normalizeEffectiveCallCost,
	effectiveCallCostsRelation,
	effectiveCostKnown,
	effectiveCostUsd,
	providerCostEvidenceProjection,
	sourceRetiredProjection,
	reviewedCostMicros,
} from "./billing/provider-cost-evidence";
import {
	reviewedProviderCostSummary as costSummary,
	type ReviewedProviderCostSummary as CostSummary,
} from "@tedix/api-contract/schemas/cost-provenance";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import {
	type NewTediCallCost,
	type TediCallCost,
	tediCallCosts,
} from "../schema/tedis";
import { chunkForBoundParams } from "../utils/batch";

// Keep each insert below D1's 100-parameter limit, including provenance columns.
const D1_USAGE_WRITE_CHUNK_SIZE = 2;

/**
 * Insert per-call cost rows ingested from AI Gateway logs.
 *
 * Deduped on `gatewayLogId` (the source gateway log row's own id) so a retried
 * or overlapping ingestion page is a no-op rather than a duplicate row.
 */
export async function insertCallCosts(db: DbClient, costs: NewTediCallCost[]) {
	if (costs.length === 0) return [];
	const rows: TediCallCost[] = [];
	for (const chunk of chunkForBoundParams(costs, D1_USAGE_WRITE_CHUNK_SIZE)) {
		rows.push(
			...(await db
				.insert(tediCallCosts)
				.values(chunk)
				.onConflictDoNothing({ target: tediCallCosts.gatewayLogId })
				.returning()),
		);
	}
	return rows;
}

/**
 * Confirm a retried Gateway page is already durable before moving its cursor.
 * The gateway predicate prevents a colliding log id from another gateway from
 * being treated as this page's usage. One chunk binds 50 ids plus the gateway,
 * comfortably below D1's 100-parameter ceiling.
 */
export async function getExistingGatewayLogIds(
	db: DbClient,
	gatewayId: string,
	logIds: string[],
): Promise<string[]> {
	const existing: string[] = [];
	for (const ids of chunkForBoundParams([...new Set(logIds)], 50)) {
		const rows = await db
			.select({ gatewayLogId: tediCallCosts.gatewayLogId })
			.from(tediCallCosts)
			.where(
				and(
					eq(tediCallCosts.gatewayId, gatewayId),
					inArray(tediCallCosts.gatewayLogId, ids),
				),
			);
		existing.push(...rows.map((row) => row.gatewayLogId));
	}
	return existing;
}

export async function getCallCosts(
	db: DbClient,
	tediId: string,
	opts: {
		from?: string;
		to?: string;
		model?: string;
		limit?: number;
	} = {},
) {
	const conditions = [eq(tediCallCosts.tediId, tediId)];

	if (opts.from) {
		conditions.push(gte(tediCallCosts.snapshotAt, opts.from));
	}
	if (opts.to) {
		conditions.push(lte(tediCallCosts.snapshotAt, opts.to));
	}
	if (opts.model) {
		conditions.push(eq(tediCallCosts.model, opts.model));
	}

	const rows = await db
		.select({
			...getColumns(tediCallCosts),
			providerCostEvidence: providerCostEvidenceProjection,
			sourceRetired: sourceRetiredProjection,
		})
		.from(effectiveCallCostsRelation())
		.where(and(...conditions))
		.orderBy(desc(tediCallCosts.snapshotAt))
		.limit(opts.limit ?? 500);
	return (
		rows as unknown as Array<
			TediCallCost & {
				providerCostEvidence: string | null;
				sourceRetired: number;
			}
		>
	).map(normalizeEffectiveCallCost);
}

export interface CallCostTotals extends CostSummary {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	estimatedCostUsd: number | null;
	callCount: number;
}

/**
 * Sum token/cost totals for a tedi over an optional window.
 *
 * Rows with `dataQuality !== 'ok'` are excluded from `estimatedCostUsd` (their
 * cost is not trustworthy) but still counted in `callCount` for visibility.
 */
export async function getCallCostTotals(
	db: DbClient,
	tediId: string,
	opts: { from?: string; to?: string } = {},
): Promise<CallCostTotals> {
	const conditions = [eq(tediCallCosts.tediId, tediId)];
	if (opts.from) conditions.push(gte(tediCallCosts.snapshotAt, opts.from));
	if (opts.to) conditions.push(lte(tediCallCosts.snapshotAt, opts.to));

	const rows = await db
		.select({
			inputTokens: sql<number>`COALESCE(SUM(${tediCallCosts.inputTokens}), 0)`,
			outputTokens: sql<number>`COALESCE(SUM(${tediCallCosts.outputTokens}), 0)`,
			cacheReadTokens: sql<number>`COALESCE(SUM(${tediCallCosts.cacheReadTokens}), 0)`,
			cacheWriteTokens: sql<number>`COALESCE(SUM(${tediCallCosts.cacheWriteTokens}), 0)`,
			totalTokens: sql<number>`COALESCE(SUM(${tediCallCosts.totalTokens}), 0)`,
			reviewedEstimateRowCount: sql<number>`COALESCE(SUM(CASE WHEN ${reviewedCostMicros} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
			reviewedEstimateTokens: sql<number>`COALESCE(SUM(CASE WHEN ${reviewedCostMicros} IS NOT NULL THEN ${tediCallCosts.totalTokens} ELSE 0 END), 0)`,
			reviewedEstimateMicros: sql<number>`COALESCE(SUM(${reviewedCostMicros}), 0)`,
			sourceRetiredRowCount: sql<number>`COALESCE(SUM(${sourceRetiredProjection}), 0)`,
			knownSubtotalUsd: sql<number>`COALESCE(SUM(CASE WHEN ${effectiveCostKnown} THEN ${effectiveCostUsd} ELSE 0 END), 0)`,
			pricedRowCount: sql<number>`SUM(CASE WHEN ${effectiveCostKnown} THEN 1 ELSE 0 END)`,
			unpricedRowCount: sql<number>`SUM(CASE WHEN NOT ${effectiveCostKnown} THEN 1 ELSE 0 END)`,
			unpricedTokens: sql<number>`SUM(CASE WHEN NOT ${effectiveCostKnown} THEN ${tediCallCosts.totalTokens} ELSE 0 END)`,
			callCount: sql<number>`COUNT(*)`,
		})
		.from(effectiveCallCostsRelation())
		.where(and(...conditions));

	const row = rows[0];
	return {
		inputTokens: Number(row?.inputTokens ?? 0),
		outputTokens: Number(row?.outputTokens ?? 0),
		cacheReadTokens: Number(row?.cacheReadTokens ?? 0),
		cacheWriteTokens: Number(row?.cacheWriteTokens ?? 0),
		totalTokens: Number(row?.totalTokens ?? 0),
		...costSummary({
			knownSubtotalUsd: Number(row?.knownSubtotalUsd ?? 0),
			reviewedEstimateRowCount: Number(row?.reviewedEstimateRowCount ?? 0),
			reviewedEstimateTokens: Number(row?.reviewedEstimateTokens ?? 0),
			reviewedEstimateMicros: Number(row?.reviewedEstimateMicros ?? 0),
			sourceRetiredRowCount: Number(row?.sourceRetiredRowCount ?? 0),
			pricedRowCount: Number(row?.pricedRowCount ?? 0),
			unpricedRowCount: Number(row?.unpricedRowCount ?? 0),
			unpricedTokens: Number(row?.unpricedTokens ?? 0),
		}),
		estimatedCostUsd:
			Number(row?.pricedRowCount ?? 0) > 0 &&
			Number(row?.unpricedRowCount ?? 0) === 0
				? Number(row?.knownSubtotalUsd ?? 0)
				: null,
		callCount: Number(row?.callCount ?? 0),
	};
}

export interface CallCostHistoryBucket extends CostSummary {
	/** ISO date (YYYY-MM-DD) the bucket covers */
	date: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	estimatedCostUsd: number | null;
	callCount: number;
}

/**
 * Daily-bucketed token/cost history for a tedi over an optional window.
 * Only a `daily` bucket is currently supported (matches the read-side
 * OS usage series); the `bucket` param is reserved for future granularities.
 */
export async function getCallCostHistory(
	db: DbClient,
	tediId: string,
	opts: { from?: string; to?: string; bucket?: "daily" } = {},
): Promise<CallCostHistoryBucket[]> {
	const conditions = [eq(tediCallCosts.tediId, tediId)];
	if (opts.from) conditions.push(gte(tediCallCosts.snapshotAt, opts.from));
	if (opts.to) conditions.push(lte(tediCallCosts.snapshotAt, opts.to));

	const dateBucket = sql<string>`date(${tediCallCosts.snapshotAt})`;

	const rows = await db
		.select({
			date: dateBucket,
			inputTokens: sql<number>`COALESCE(SUM(${tediCallCosts.inputTokens}), 0)`,
			outputTokens: sql<number>`COALESCE(SUM(${tediCallCosts.outputTokens}), 0)`,
			totalTokens: sql<number>`COALESCE(SUM(${tediCallCosts.totalTokens}), 0)`,
			reviewedEstimateRowCount: sql<number>`COALESCE(SUM(CASE WHEN ${reviewedCostMicros} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
			reviewedEstimateTokens: sql<number>`COALESCE(SUM(CASE WHEN ${reviewedCostMicros} IS NOT NULL THEN ${tediCallCosts.totalTokens} ELSE 0 END), 0)`,
			reviewedEstimateMicros: sql<number>`COALESCE(SUM(${reviewedCostMicros}), 0)`,
			sourceRetiredRowCount: sql<number>`COALESCE(SUM(${sourceRetiredProjection}), 0)`,
			knownSubtotalUsd: sql<number>`COALESCE(SUM(CASE WHEN ${effectiveCostKnown} THEN ${effectiveCostUsd} ELSE 0 END), 0)`,
			pricedRowCount: sql<number>`SUM(CASE WHEN ${effectiveCostKnown} THEN 1 ELSE 0 END)`,
			unpricedRowCount: sql<number>`SUM(CASE WHEN NOT ${effectiveCostKnown} THEN 1 ELSE 0 END)`,
			unpricedTokens: sql<number>`SUM(CASE WHEN NOT ${effectiveCostKnown} THEN ${tediCallCosts.totalTokens} ELSE 0 END)`,
			callCount: sql<number>`COUNT(*)`,
		})
		.from(effectiveCallCostsRelation())
		.where(and(...conditions))
		.groupBy(dateBucket)
		.orderBy(dateBucket);

	return rows.map((row) => ({
		date: row.date,
		inputTokens: Number(row.inputTokens ?? 0),
		outputTokens: Number(row.outputTokens ?? 0),
		totalTokens: Number(row.totalTokens ?? 0),
		...costSummary({
			knownSubtotalUsd: Number(row.knownSubtotalUsd ?? 0),
			reviewedEstimateRowCount: Number(row.reviewedEstimateRowCount ?? 0),
			reviewedEstimateTokens: Number(row.reviewedEstimateTokens ?? 0),
			reviewedEstimateMicros: Number(row.reviewedEstimateMicros ?? 0),
			sourceRetiredRowCount: Number(row.sourceRetiredRowCount ?? 0),
			pricedRowCount: Number(row.pricedRowCount ?? 0),
			unpricedRowCount: Number(row.unpricedRowCount ?? 0),
			unpricedTokens: Number(row.unpricedTokens ?? 0),
		}),
		estimatedCostUsd:
			Number(row.pricedRowCount ?? 0) > 0 &&
			Number(row.unpricedRowCount ?? 0) === 0
				? Number(row.knownSubtotalUsd ?? 0)
				: null,
		callCount: Number(row.callCount ?? 0),
	}));
}

// =============================================================================
// Ingestion-freshness probe (foundation for cost-ledger-dark alerting)
// =============================================================================

export interface CostLedgerFreshness {
	/** Newest gateway-log snapshot timestamp in the last 30d (ISO), or null. */
	maxSnapshotAt: string | null;
	/** Rows recorded in the last 24h — 0 while count30d>0 is the poison-pill. */
	count24h: number;
	/** Rows recorded in the last 30d — the "has this pipeline data at all" gate. */
	count30d: number;
}

/**
 * Ingestion-freshness probe for the cost ledger — NOT a spend query. The
 * gateway-cost ingestion job writes tedi_call_costs rows continuously (the
 * `default` gateway always carries managed AI-Search/embedding traffic), so a
 * stale MAX(snapshot_at) means the ingestion pipeline stalled — the failure
 * mode behind the 7-day cost blackout. Freshness is measured in ROW arrival,
 * never dollars: a quiet weekend and a dead ingester are indistinguishable on
 * spend but obvious on row age. Consumed by the platform-health digest.
 */
export async function getCostLedgerFreshness(
	db: DbClient,
	nowMs: number,
): Promise<CostLedgerFreshness> {
	const iso24h = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
	const iso30d = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
	const rows = await db
		.select({
			maxSnapshotAt: sql<string | null>`MAX(${tediCallCosts.snapshotAt})`,
			count24h: sql<number>`SUM(CASE WHEN ${tediCallCosts.snapshotAt} >= ${iso24h} THEN 1 ELSE 0 END)`,
			count30d: sql<number>`COUNT(*)`,
		})
		.from(effectiveCallCostsRelation())
		.where(gte(tediCallCosts.snapshotAt, iso30d));
	const row = rows[0];
	return {
		maxSnapshotAt: row?.maxSnapshotAt ?? null,
		count24h: Number(row?.count24h ?? 0),
		count30d: Number(row?.count30d ?? 0),
	};
}

export interface RuntimeLedgerFreshness {
	/** Newest event created_at in the last 7d (ISO), or null if none. */
	maxCreatedAt: string | null;
	count1h: number;
	count24h: number;
	/** Rows in the last 7d — the "is this plane normally busy" gate. */
	count7d: number;
}

/**
 * Ingestion-freshness probe for `tedi_runtime_events` — the canonical, busiest
 * runtime/cognition write plane (every tedi turn, tool call, run, and skill
 * emits rows). If it goes fleet-wide dark, the entire observability + learning
 * stack silently vanishes and neither cost-ledger-dark nor cron-darkness would
 * catch it (different tables). Measured in ROW arrival, never dollars. The 7d
 * window (vs the cost ledger's 30d) matches this table's much higher volume and
 * rides idx_tedi_runtime_events_created. Consumed by the platform-health digest.
 */
export async function getRuntimeLedgerFreshness(
	db: DbClient,
	nowMs: number,
): Promise<RuntimeLedgerFreshness> {
	const iso1h = new Date(nowMs - 60 * 60 * 1000).toISOString();
	const iso24h = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
	const iso7d = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();
	const rows = await db
		.select({
			maxCreatedAt: sql<string | null>`MAX(${tediRuntimeEvents.createdAt})`,
			count1h: sql<number>`SUM(CASE WHEN ${tediRuntimeEvents.createdAt} >= ${iso1h} THEN 1 ELSE 0 END)`,
			count24h: sql<number>`SUM(CASE WHEN ${tediRuntimeEvents.createdAt} >= ${iso24h} THEN 1 ELSE 0 END)`,
			count7d: sql<number>`COUNT(*)`,
		})
		.from(tediRuntimeEvents)
		.where(gte(tediRuntimeEvents.createdAt, iso7d));
	const row = rows[0];
	return {
		maxCreatedAt: row?.maxCreatedAt ?? null,
		count1h: Number(row?.count1h ?? 0),
		count24h: Number(row?.count24h ?? 0),
		count7d: Number(row?.count7d ?? 0),
	};
}

// =============================================================================
// Spend-rate analytics (foundation for cost anomaly alerting)
// =============================================================================

export interface DailySpendModelBreakdown {
	reviewedEstimateRowCount: number;
	reviewedEstimateTokens: number;
	reviewedEstimateMicros: number;
	sourceRetiredRowCount: number;
	model: string;
	cost_usd: number | null;
	knownSubtotalUsd: number;
	unpricedCalls: number;
	calls: number;
}

export interface DailySpendRate {
	reviewedEstimateRowCount: number;
	reviewedEstimateTokens: number;
	reviewedEstimateMicros: number;
	sourceRetiredRowCount: number;
	/** ISO date (YYYY-MM-DD) the most recent lookback window covers */
	asOf: string;
	/** Sum of estimated_cost_usd over the last `lookbackDays` days */
	daily_usd: number | null;
	knownSubtotalUsd: number;
	unpricedCalls: number;
	baselineUnpricedCalls: number;
	/** Row count over the same window (proxy for "calls"; one row per snapshot delta) */
	daily_calls: number;
	/** Per-model breakdown over the same window */
	models: DailySpendModelBreakdown[];
	/** Trailing 7-day average daily cost (USD), excluding the lookback window */
	sevenDayAvgDailyUsd: number | null;
	/**
	 * Held-out value in the same window, reported BESIDE spend and never inside
	 * it. Excluding quarantined rows from the score is correct, but dropping
	 * them silently would hide the opposite failure: a spike in quarantine means
	 * ingestion or pricing broke, and a detector that just went quiet is the
	 * same blind spot in a new place. `daily_calls` still counts every row, so
	 * `quarantined_calls` is the share of it that could not be priced.
	 */
	quarantined_usd: number;
	quarantined_calls: number;
	/**
	 * Anomaly score:
	 *   - 1.0 if daily_usd > 3x trailing 7-day avg
	 *   - 0.5 if daily_usd > 2x trailing 7-day avg
	 *   - 0.0 otherwise
	 * 7-day average must be > 0 for the score to fire.
	 */
	anomaly_score: 0 | 0.5 | 1 | null;
}

/**
 * Compute daily spend rate + cheap anomaly score for a single tedi (or the
 * platform aggregate when `tediId` is null).
 *
 * NOT a full alerting pipeline — surfaces the data so cron can log
 * structured warnings (`tedi.cost.anomaly`) that can be grepped from
 * Worker logs.
 */
export async function getDailySpendRate(
	db: DbClient,
	tediId: string | null,
	lookbackDays = 1,
): Promise<DailySpendRate> {
	const now = new Date();
	const windowStart = new Date(
		now.getTime() - lookbackDays * 24 * 60 * 60 * 1000,
	);
	const baselineStart = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);

	const tediFilter = tediId ? [eq(tediCallCosts.tediId, tediId)] : [];

	// 1. Current window aggregate + per-model breakdown
	const windowRows = await db
		.select({
			reviewedEstimateRowCount: sql<number>`COALESCE(SUM(${reviewedCostMicros} IS NOT NULL),0)`,
			reviewedEstimateTokens: sql<number>`COALESCE(SUM(CASE WHEN ${reviewedCostMicros} IS NOT NULL THEN ${tediCallCosts.totalTokens} ELSE 0 END),0)`,
			reviewedEstimateMicros: sql<number>`COALESCE(SUM(${reviewedCostMicros}),0)`,
			sourceRetiredRowCount: sql<number>`COALESCE(SUM(${sourceRetiredProjection}),0)`,
			model: tediCallCosts.model,
			// Quarantined rows are NOT spend. The sibling reads in this same module
			// (`getCallCostTotals`, `getTediCallCostTotals`) already sum with this
			// exact filter; the anomaly detector summed unfiltered, so one module
			// disagreed with itself and alerting was the side that was wrong.
			unpricedCalls: sql<number>`SUM(CASE WHEN NOT ${effectiveCostKnown} THEN 1 ELSE 0 END)`,
			cost: sql<number>`COALESCE(SUM(CASE WHEN ${effectiveCostKnown} THEN ${effectiveCostUsd} ELSE 0 END), 0)`,
			quarantinedCost: sql<number>`COALESCE(SUM(CASE WHEN ${tediCallCosts.dataQuality} != 'ok' THEN ${tediCallCosts.estimatedCostUsd} ELSE 0 END), 0)`,
			calls: sql<number>`COUNT(*)`,
			quarantinedCalls: sql<number>`COALESCE(SUM(CASE WHEN ${tediCallCosts.dataQuality} != 'ok' THEN 1 ELSE 0 END), 0)`,
		})
		.from(effectiveCallCostsRelation())
		.where(
			and(
				...tediFilter,
				gte(tediCallCosts.snapshotAt, windowStart.toISOString()),
			),
		)
		.groupBy(tediCallCosts.model);

	let dailyUsd = 0;
	let unpricedCalls = 0;
	let dailyCalls = 0;
	let quarantinedUsd = 0;
	let quarantinedCalls = 0;
	const reviewed = {
		reviewedEstimateRowCount: 0,
		reviewedEstimateTokens: 0,
		reviewedEstimateMicros: 0,
		sourceRetiredRowCount: 0,
	};
	const models: DailySpendModelBreakdown[] = [];
	for (const row of windowRows) {
		for (const key of Object.keys(reviewed) as Array<keyof typeof reviewed>)
			reviewed[key] += Number(row[key]);
		const cost = Number(row.cost ?? 0);
		const calls = Number(row.calls ?? 0);
		dailyUsd += cost;
		dailyCalls += calls;
		unpricedCalls += Number(row.unpricedCalls ?? 0);
		quarantinedUsd += Number(row.quarantinedCost ?? 0);
		quarantinedCalls += Number(row.quarantinedCalls ?? 0);
		models.push({
			reviewedEstimateRowCount: Number(row.reviewedEstimateRowCount),
			reviewedEstimateTokens: Number(row.reviewedEstimateTokens),
			reviewedEstimateMicros: Number(row.reviewedEstimateMicros),
			sourceRetiredRowCount: Number(row.sourceRetiredRowCount),
			model: row.model,
			cost_usd: Number(row.unpricedCalls ?? 0) > 0 ? null : cost,
			knownSubtotalUsd: cost,
			unpricedCalls: Number(row.unpricedCalls ?? 0),
			calls,
		});
	}
	models.sort((a, b) => b.knownSubtotalUsd - a.knownSubtotalUsd);

	// 2. Baseline (last 7 days BEFORE the current window) for anomaly comparison
	const baselineRows = await db
		.select({
			// Same filter as the window above. A baseline that includes held-out
			// value is not comparable to a window that excludes it — the ratio
			// would move whenever the QUARANTINE RATE changed, with no change in
			// real spend, which is precisely a false anomaly.
			unpricedCalls: sql<number>`SUM(CASE WHEN NOT ${effectiveCostKnown} THEN 1 ELSE 0 END)`,
			cost: sql<number>`COALESCE(SUM(CASE WHEN ${effectiveCostKnown} THEN ${effectiveCostUsd} ELSE 0 END), 0)`,
		})
		.from(effectiveCallCostsRelation())
		.where(
			and(
				...tediFilter,
				gte(tediCallCosts.snapshotAt, baselineStart.toISOString()),
				lte(tediCallCosts.snapshotAt, windowStart.toISOString()),
			),
		);

	const baselineTotal = Number(baselineRows[0]?.cost ?? 0);
	const baselineUnpricedCalls = Number(baselineRows[0]?.unpricedCalls ?? 0);
	const sevenDayAvgDailyUsd =
		baselineUnpricedCalls > 0 ? null : baselineTotal / 7;

	// 3. Anomaly score — fire only if there is a meaningful baseline
	let anomaly_score: 0 | 0.5 | 1 | null =
		unpricedCalls > 0 || baselineUnpricedCalls > 0 ? null : 0;
	if (
		anomaly_score !== null &&
		sevenDayAvgDailyUsd !== null &&
		sevenDayAvgDailyUsd > 0.001
	) {
		if (dailyUsd > 3 * sevenDayAvgDailyUsd) anomaly_score = 1;
		else if (dailyUsd > 2 * sevenDayAvgDailyUsd) anomaly_score = 0.5;
	}

	return {
		asOf: now.toISOString().slice(0, 10),
		...reviewed,
		daily_usd: unpricedCalls > 0 ? null : dailyUsd,
		knownSubtotalUsd: dailyUsd,
		unpricedCalls,
		baselineUnpricedCalls,
		daily_calls: dailyCalls,
		models,
		sevenDayAvgDailyUsd,
		quarantined_usd: quarantinedUsd,
		quarantined_calls: quarantinedCalls,
		anomaly_score,
	};
}

// =============================================================================
// Organization-scoped compute posture (Tedix OS "Compute and Models" surface)
// =============================================================================

/**
 * Org-scoped ingestion freshness.
 *
 * Deliberately NOT `getCostLedgerFreshness`, which is platform-wide: a tenant
 * surface must not report another organization's ingestion as its own, and a
 * busy platform would mask a tenant whose rows stopped arriving. The org
 * predicate is the point of this function, not an optimization.
 */
export async function getOrgCostLedgerFreshness(
	db: DbClient,
	organizationId: string,
	nowMs: number,
): Promise<CostLedgerFreshness> {
	const iso24h = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
	const iso30d = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
	const rows = await db
		.select({
			maxSnapshotAt: sql<string | null>`MAX(${tediCallCosts.snapshotAt})`,
			count24h: sql<number>`SUM(CASE WHEN ${tediCallCosts.snapshotAt} >= ${iso24h} THEN 1 ELSE 0 END)`,
			count30d: sql<number>`COUNT(*)`,
		})
		.from(effectiveCallCostsRelation())
		.where(
			and(
				eq(tediCallCosts.orgId, organizationId),
				gte(tediCallCosts.snapshotAt, iso30d),
			),
		);
	const row = rows[0];
	return {
		maxSnapshotAt: row?.maxSnapshotAt ?? null,
		count24h: Number(row?.count24h ?? 0),
		count30d: Number(row?.count30d ?? 0),
	};
}

/**
 * One raw provenance-discriminating group of the org's call-cost ledger.
 *
 * The classification itself deliberately does NOT happen in SQL. The contract
 * owns exactly one classifier (`ledgerRowProvenance` in
 * `@tedix/api-contract/schemas/cost-provenance`), and a second copy expressed
 * as a CASE expression would drift from it silently. So this returns the four
 * columns that discriminate — provider, data quality, whether a price landed,
 * whether tokens were spent — and the caller runs the one classifier over them.
 */
export interface OrgCallCostProvenanceGroup {
	provider: string | null;
	costBasis: TediCallCost["costBasis"];
	dataQuality: "ok" | "quarantined_no_pricing" | "quarantined_failed";
	sessionType: "tedi" | "tedi_observer" | "kernel" | "unattributed";
	/** 1 when an explicit stored amount exists, including zero. */
	hasCost: number;
	/** 1 when the row recorded any tokens. */
	hasTokens: number;
	rowCount: number;
	totalTokens: number;
	costUsd: number;
}

/**
 * Group the org's ledger over a window by everything provenance depends on.
 *
 * Cardinality is bounded by providers x 3 quality values x 4 session types x 4
 * boolean pairs, so this stays a small aggregate read rather than a row scan.
 * `org_id` is required: rows with a NULL organization (the only rows the
 * `require_org_id_for_attributed_calls` trigger lets through unattached) are
 * structurally invisible to this read, which is why the contract reports
 * unattributed cost as a floor and never as a total.
 */
export async function getOrgCallCostProvenanceGroups(
	db: DbClient,
	organizationId: string,
	fromIso: string,
): Promise<OrgCallCostProvenanceGroup[]> {
	const hasCost = sql<number>`CASE WHEN ${tediCallCosts.estimatedCostUsd} IS NOT NULL AND ${tediCallCosts.estimatedCostUsd} >= 0 AND ${tediCallCosts.costBasis} != 'unknown' AND NOT (${tediCallCosts.costBasis} = 'legacy_estimate' AND ${tediCallCosts.dataQuality} = 'quarantined_no_pricing') THEN 1 ELSE 0 END`;
	const hasTokens = sql<number>`CASE WHEN ${tediCallCosts.totalTokens} > 0 THEN 1 ELSE 0 END`;
	const rows = await db
		.select({
			provider: tediCallCosts.provider,
			costBasis: tediCallCosts.costBasis,
			dataQuality: tediCallCosts.dataQuality,
			sessionType: tediCallCosts.sessionType,
			hasCost,
			hasTokens,
			rowCount: sql<number>`COUNT(*)`,
			totalTokens: sql<number>`COALESCE(SUM(${tediCallCosts.totalTokens}), 0)`,
			costUsd: sql<number>`COALESCE(SUM(CASE WHEN ${hasCost} = 1 THEN ${tediCallCosts.estimatedCostUsd} ELSE 0 END), 0)`,
		})
		.from(effectiveCallCostsRelation())
		.where(
			and(
				eq(tediCallCosts.orgId, organizationId),
				gte(tediCallCosts.snapshotAt, fromIso),
			),
		)
		.groupBy(
			tediCallCosts.provider,
			tediCallCosts.costBasis,
			tediCallCosts.dataQuality,
			tediCallCosts.sessionType,
			hasCost,
			hasTokens,
		);
	return rows.map((row) => ({
		provider: row.provider ?? null,
		costBasis: row.costBasis,
		dataQuality: row.dataQuality,
		sessionType: row.sessionType,
		hasCost: Number(row.hasCost ?? 0),
		hasTokens: Number(row.hasTokens ?? 0),
		rowCount: Number(row.rowCount ?? 0),
		totalTokens: Number(row.totalTokens ?? 0),
		costUsd: Number(row.costUsd ?? 0),
	}));
}
