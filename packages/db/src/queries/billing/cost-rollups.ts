import {
	and,
	asc,
	eq,
	gte,
	lt,
	lte,
	sql,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { coreStore } from "../../core-store/dialect";
import { billingCostRollups as schemaBillingCostRollups } from "../../schema/billing-cost-rollups";
import { tediCallCosts, tedis as schemaTedis } from "../../schema/tedis";
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
/** SQLite `iif`; Postgres spells it CASE WHEN. */
function iff(
	db: DbQueryClient,
	condition: SQLWrapper,
	yes: SQLWrapper,
	no: SQLWrapper,
): SQL {
	return coreStore(db) === "postgres"
		? sql`CASE WHEN ${condition} THEN ${yes} ELSE ${no} END`
		: sql`iif(${condition}, ${yes}, ${no})`;
}
function latestCallKey(db: DbQueryClient) {
	return sql`max(${tediCallCosts.snapshotAt} || ${coreStore(db) === "postgres" ? sql`chr(31)` : sql`char(31)`} || ${tediCallCosts.id})`;
}

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
	const postgres = coreStore(db) === "postgres";
	const rollups = coreTable(db, schemaBillingCostRollups);
	const effective = effectiveCallCostsRelation(undefined, db);

	const replace = db.insert(rollups).select(
		db
			.select({
				// Postgres billing_cost_rollups.id has no default; D1 rowids autoincrement.
				...(postgres
					? {
							id: sql<number>`nextval('billing_cost_rollups_id_seq')`.as("id"),
						}
					: {}),
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
					sql<number>`sum(${iff(db, sql`${effectiveKnownCostUsd} IS NULL`, tediCallCosts.totalTokens, sql`0`)})`.as(
						"unpriced_tokens",
					),
				reviewedCallCount:
					sql<number>`count(${providerCostEvidenceProjection})`.as(
						"reviewed_call_count",
					),
				reviewedTokens:
					sql<number>`sum(${iff(db, sql`${providerCostEvidenceProjection} IS NULL`, sql`0`, tediCallCosts.totalTokens)})`.as(
						"reviewed_tokens",
					),
				reviewedCostMicros:
					sql<number>`sum(${iff(db, sql`${providerCostEvidenceProjection} IS NULL`, sql`0`, reviewedCostMicros)})`.as(
						"reviewed_cost_micros",
					),
				retiredCallCount: sql<number>`sum(${sourceRetiredProjection})`.as(
					"retired_call_count",
				),
				latestSnapshotAt: sql<string>`max(${tediCallCosts.snapshotAt})`.as(
					"latest_snapshot_at",
				),
				latestCallId:
					sql<string>`substr(${latestCallKey(db)}, length(max(${tediCallCosts.snapshotAt})) + 2)`.as(
						"latest_call_id",
					),
				stale: (postgres ? sql<boolean>`false` : sql<number>`0`).as("stale"),
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
			.delete(rollups)
			.where(
				and(eq(rollups.organizationId, organizationId), eq(rollups.day, day)),
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
	const rollups = coreTable(db, schemaBillingCostRollups);
	const tedis = coreTable(db, schemaTedis);
	return db
		.select({
			day: rollups.day,
			tediId: rollups.tediId,
			tediName: tedis.name,
			tediSlug: tedis.slug,
			sessionType: rollups.sessionType,
			source: rollups.source,
			model: rollups.model,
			provider: rollups.provider,
			providerResource: rollups.providerResource,
			providerBaseUrl: rollups.providerBaseUrl,
			deployment: rollups.deployment,
			costBasis: rollups.costBasis,
			success: rollups.success,
			inputTokens: rollups.inputTokens,
			outputTokens: rollups.outputTokens,
			cacheReadTokens: rollups.cacheReadTokens,
			cacheWriteTokens: rollups.cacheWriteTokens,
			totalTokens: rollups.totalTokens,
			estimatedCostUsd: rollups.estimatedCostUsd,
			callCount: rollups.callCount,
			pricedCallCount: rollups.pricedCallCount,
			unpricedTokens: rollups.unpricedTokens,
			reviewedCallCount: rollups.reviewedCallCount,
			reviewedTokens: rollups.reviewedTokens,
			reviewedCostMicros: rollups.reviewedCostMicros,
			retiredCallCount: rollups.retiredCallCount,
			latestSnapshotAt: rollups.latestSnapshotAt,
			latestCallId: rollups.latestCallId,
		})
		.from(rollups)
		.leftJoin(tedis, eq(rollups.tediId, tedis.id))
		.where(
			and(
				eq(rollups.organizationId, organizationId),
				gte(rollups.day, fromDay),
				lte(rollups.day, toDay),
				eq(rollups.stale, false),
			),
		)
		.orderBy(asc(rollups.day), asc(rollups.id));
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
	const postgres = coreStore(db) === "postgres";
	// Raw: the day series is a recursive CTE, which Drizzle builders cannot express.
	return db.all<{ organizationId: string; day: string }>(
		postgres
			? sql`
		WITH RECURSIVE days(day) AS (
			SELECT ((${today})::date - 1)::text
			UNION ALL SELECT (day::date - 1)::text FROM days
			WHERE day > ((${today})::date - ${lookbackDays}::int)::text
		)
		SELECT o.id AS "organizationId", days.day AS day
		FROM organizations o CROSS JOIN days
		WHERE EXISTS (
			SELECT 1 FROM tedi_call_costs c
			WHERE c.org_id = o.id AND c.snapshot_at >= days.day
				AND c.snapshot_at < (days.day::date + 1)::text
		)
		AND NOT EXISTS (
			SELECT 1 FROM billing_cost_rollups r
			WHERE r.organization_id = o.id AND r.day = days.day AND r.stale = false
		)
		ORDER BY days.day DESC, o.id
		LIMIT ${boundedLimit}`
			: sql`
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
		LIMIT ${boundedLimit}`,
	);
}
