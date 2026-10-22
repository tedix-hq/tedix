import { and, asc, eq, gte, lt, lte, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { billingCostRollups } from "../../schema/billing-cost-rollups";
import { tediCallCosts, tedis } from "../../schema/tedis";
import {
	effectiveCallCostsRelation,
	providerCostEvidenceProjection,
	reviewedCostMicros,
	sourceRetiredProjection,
} from "./provider-cost-evidence";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function requireDay(day: string, label: string): string {
	if (!DAY_PATTERN.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`)))
		throw new Error(`${label} must be a UTC day (YYYY-MM-DD)`);
	return day;
}

/** The UTC day after `day`, as `YYYY-MM-DD`. */
export function nextUtcDay(day: string): string {
	const next = new Date(`${requireDay(day, "day")}T00:00:00Z`);
	next.setUTCDate(next.getUTCDate() + 1);
	return next.toISOString().slice(0, 10);
}

/** The UTC day before `day`, as `YYYY-MM-DD`. */
export function previousUtcDay(day: string): string {
	const previous = new Date(`${requireDay(day, "day")}T00:00:00Z`);
	previous.setUTCDate(previous.getUTCDate() - 1);
	return previous.toISOString().slice(0, 10);
}

/**
 * Same attestation rule the ledger normalizer applies per row: a reviewed
 * provider estimate wins; otherwise only an `ok`, non-unknown, finite,
 * non-negative persisted estimate is a known cost. NULL means unpriced.
 */
const effectiveKnownCostUsd = sql<number | null>`CASE
	WHEN ${providerCostEvidenceProjection} IS NOT NULL THEN ${reviewedCostMicros} / 1000000.0
	WHEN ${tediCallCosts.dataQuality} = 'ok' AND ${tediCallCosts.costBasis} != 'unknown'
		AND ${tediCallCosts.estimatedCostUsd} >= 0
		AND ${tediCallCosts.estimatedCostUsd} <= 1.7976931348623157e308
		THEN ${tediCallCosts.estimatedCostUsd}
	END`;
const latestCallKey = sql`max(${tediCallCosts.snapshotAt} || char(31) || ${tediCallCosts.id})`;

/**
 * Replace one closed UTC day's rollup rows for an organization in a single D1
 * batch (delete, then insert-select from the effective call-cost relation).
 * Today and later days are refused: they are still receiving rows.
 */
export async function rebuildCostRollupDay(
	db: DbQueryClient,
	organizationId: string,
	day: string,
	options: { now?: Date } = {},
): Promise<void> {
	requireDay(day, "day");
	const now = options.now ?? new Date();
	const today = now.toISOString().slice(0, 10);
	if (day >= today) throw new Error(`Cost rollup day ${day} is not closed`);
	const nextDay = nextUtcDay(day);
	const computedAt = now.toISOString();
	const effective = effectiveCallCostsRelation();

	const replace = db.insert(billingCostRollups).select(
		db
			.select({
				organizationId: sql<string>`${organizationId}`.as("organization_id"),
				day: sql<string>`${day}`.as("day"),
				tediId: tediCallCosts.tediId,
				sessionType: tediCallCosts.sessionType,
				source: tediCallCosts.source,
				model: tediCallCosts.model,
				provider: tediCallCosts.provider,
				providerResource: tediCallCosts.providerResource,
				providerBaseUrl: tediCallCosts.providerBaseUrl,
				deployment: tediCallCosts.deployment,
				costBasis: tediCallCosts.costBasis,
				success: tediCallCosts.success,
				inputTokens: sql<number>`sum(${tediCallCosts.inputTokens})`.as(
					"input_tokens",
				),
				outputTokens: sql<number>`sum(${tediCallCosts.outputTokens})`.as(
					"output_tokens",
				),
				cacheReadTokens: sql<number>`sum(${tediCallCosts.cacheReadTokens})`.as(
					"cache_read_tokens",
				),
				cacheWriteTokens:
					sql<number>`sum(${tediCallCosts.cacheWriteTokens})`.as(
						"cache_write_tokens",
					),
				totalTokens: sql<number>`sum(${tediCallCosts.totalTokens})`.as(
					"total_tokens",
				),
				estimatedCostUsd:
					sql<number>`coalesce(sum(${effectiveKnownCostUsd}), 0.0)`.as(
						"estimated_cost_usd",
					),
				callCount: sql<number>`count(*)`.as("call_count"),
				pricedCallCount: sql<number>`count(${effectiveKnownCostUsd})`.as(
					"priced_call_count",
				),
				unpricedTokens:
					sql<number>`sum(iif(${effectiveKnownCostUsd} IS NULL, ${tediCallCosts.totalTokens}, 0))`.as(
						"unpriced_tokens",
					),
				reviewedCallCount:
					sql<number>`count(${providerCostEvidenceProjection})`.as(
						"reviewed_call_count",
					),
				reviewedTokens:
					sql<number>`sum(iif(${providerCostEvidenceProjection} IS NULL, 0, ${tediCallCosts.totalTokens}))`.as(
						"reviewed_tokens",
					),
				reviewedCostMicros:
					sql<number>`sum(iif(${providerCostEvidenceProjection} IS NULL, 0, ${reviewedCostMicros}))`.as(
						"reviewed_cost_micros",
					),
				retiredCallCount: sql<number>`sum(${sourceRetiredProjection})`.as(
					"retired_call_count",
				),
				latestSnapshotAt: sql<string>`max(${tediCallCosts.snapshotAt})`.as(
					"latest_snapshot_at",
				),
				latestCallId:
					sql<string>`substr(${latestCallKey}, length(max(${tediCallCosts.snapshotAt})) + 2)`.as(
						"latest_call_id",
					),
				stale: sql<boolean>`0`.as("stale"),
				computedAt: sql<string>`${computedAt}`.as("computed_at"),
			})
			.from(effective)
			.where(
				and(
					eq(tediCallCosts.orgId, organizationId),
					gte(tediCallCosts.snapshotAt, day),
					lt(tediCallCosts.snapshotAt, nextDay),
				),
			)
			.groupBy(
				tediCallCosts.tediId,
				tediCallCosts.sessionType,
				tediCallCosts.source,
				tediCallCosts.model,
				tediCallCosts.provider,
				tediCallCosts.providerResource,
				tediCallCosts.providerBaseUrl,
				tediCallCosts.deployment,
				tediCallCosts.costBasis,
				tediCallCosts.success,
			),
	);
	await db.batch([
		db
			.delete(billingCostRollups)
			.where(
				and(
					eq(billingCostRollups.organizationId, organizationId),
					eq(billingCostRollups.day, day),
				),
			),
		replace,
	]);
}

/** Fresh rollup rows for an inclusive UTC day range, with current tedi labels. */
export async function listCostRollups(
	db: DbQueryClient,
	organizationId: string,
	fromDay: string,
	toDay: string,
) {
	requireDay(fromDay, "fromDay");
	requireDay(toDay, "toDay");
	return db
		.select({
			day: billingCostRollups.day,
			tediId: billingCostRollups.tediId,
			tediName: tedis.name,
			tediSlug: tedis.slug,
			sessionType: billingCostRollups.sessionType,
			source: billingCostRollups.source,
			model: billingCostRollups.model,
			provider: billingCostRollups.provider,
			providerResource: billingCostRollups.providerResource,
			providerBaseUrl: billingCostRollups.providerBaseUrl,
			deployment: billingCostRollups.deployment,
			costBasis: billingCostRollups.costBasis,
			success: billingCostRollups.success,
			inputTokens: billingCostRollups.inputTokens,
			outputTokens: billingCostRollups.outputTokens,
			cacheReadTokens: billingCostRollups.cacheReadTokens,
			cacheWriteTokens: billingCostRollups.cacheWriteTokens,
			totalTokens: billingCostRollups.totalTokens,
			estimatedCostUsd: billingCostRollups.estimatedCostUsd,
			callCount: billingCostRollups.callCount,
			pricedCallCount: billingCostRollups.pricedCallCount,
			unpricedTokens: billingCostRollups.unpricedTokens,
			reviewedCallCount: billingCostRollups.reviewedCallCount,
			reviewedTokens: billingCostRollups.reviewedTokens,
			reviewedCostMicros: billingCostRollups.reviewedCostMicros,
			retiredCallCount: billingCostRollups.retiredCallCount,
			latestSnapshotAt: billingCostRollups.latestSnapshotAt,
			latestCallId: billingCostRollups.latestCallId,
		})
		.from(billingCostRollups)
		.leftJoin(tedis, eq(billingCostRollups.tediId, tedis.id))
		.where(
			and(
				eq(billingCostRollups.organizationId, organizationId),
				gte(billingCostRollups.day, fromDay),
				lte(billingCostRollups.day, toDay),
				eq(billingCostRollups.stale, false),
			),
		)
		.orderBy(asc(billingCostRollups.day), asc(billingCostRollups.id));
}

export type CostRollupResult = Awaited<
	ReturnType<typeof listCostRollups>
>[number];

/**
 * Closed organization-days in the lookback that have raw calls but no fresh
 * rollup, newest first. Each probe is one bounded index range read, so the
 * scan costs organizations x days, not raw rows.
 */
export async function listCostRollupDaysToBuild(
	db: DbQueryClient,
	limit: number,
	options: { now?: Date; lookbackDays?: number } = {},
): Promise<Array<{ organizationId: string; day: string }>> {
	const today = (options.now ?? new Date()).toISOString().slice(0, 10);
	const lookbackDays = Math.max(1, Math.floor(options.lookbackDays ?? 35));
	const boundedLimit = Math.max(0, Math.floor(limit));
	if (boundedLimit === 0) return [];
	return db.all<{ organizationId: string; day: string }>(sql`
		WITH RECURSIVE days(day) AS (
			SELECT date(${today}, '-1 day')
			UNION ALL SELECT date(day, '-1 day') FROM days
			WHERE day > date(${today}, ${`-${lookbackDays} days`})
		)
		SELECT o.id AS organizationId, days.day AS day
		FROM organizations o CROSS JOIN days
		WHERE EXISTS (
			SELECT 1 FROM tedi_call_costs c
			WHERE c.org_id = o.id AND c.snapshot_at >= days.day
				AND c.snapshot_at < date(days.day, '+1 day')
		)
		AND NOT EXISTS (
			SELECT 1 FROM billing_cost_rollups r
			WHERE r.organization_id = o.id AND r.day = days.day AND r.stale = 0
		)
		ORDER BY days.day DESC, o.id
		LIMIT ${boundedLimit}`);
}
