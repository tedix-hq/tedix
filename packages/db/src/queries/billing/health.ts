/** Canonical billing health queries. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	and,
	desc,
	eq,
	exists,
	gte,
	isNotNull,
	isNull,
	lt,
	sql,
} from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	effectiveCallCostsRelation,
	reviewedCostMicros,
	sourceRetiredProjection,
} from "./provider-cost-evidence";
import { tediCallCosts } from "../../schema/tedis";
import {
	type BillingProviderReconciliation,
	type BillingUsagePeriod,
	billingProviderReconciliations,
	billingUsageCharges,
	billingUsagePeriods,
	billingUsageQuarantines,
	billingUsageReservations,
} from "../../schema/billing";

export interface BillingSettlementHealth {
	unsettledReservedSuccessCount: number;
	oldestUnsettledAt: string | null;
	latestSettledAt: string | null;
	quarantined24h: number;
	nonLegacyQuarantined24h: number;
}

export async function getBillingSettlementHealth(
	db: DbClient,
	since24h: string,
): Promise<BillingSettlementHealth> {
	// One D1 batch reads every figure from the same snapshot.
	const [calls, charges, quarantines] = await db.batch([
		db
			.select({
				unsettledReservedSuccessCount: sql<number>`COUNT(*)`.as(
					"unsettledReservedSuccessCount",
				),
				oldestUnsettledAt: sql<
					string | null
				>`MIN(${tediCallCosts.snapshotAt})`.as("oldestUnsettledAt"),
			})
			.from(tediCallCosts)
			.leftJoin(
				billingUsageCharges,
				eq(billingUsageCharges.gatewayLogId, tediCallCosts.gatewayLogId),
			)
			.leftJoin(
				billingUsageQuarantines,
				eq(billingUsageQuarantines.gatewayLogId, tediCallCosts.gatewayLogId),
			)
			.where(
				and(
					eq(tediCallCosts.success, true),
					isNotNull(tediCallCosts.orgId),
					isNotNull(tediCallCosts.billingReservationId),
					isNull(billingUsageCharges.id),
					isNull(billingUsageQuarantines.id),
				),
			),
		db
			.select({
				latestSettledAt: sql<
					string | null
				>`MAX(${billingUsageCharges.createdAt})`.as("latestSettledAt"),
			})
			.from(billingUsageCharges),
		db
			.select({
				quarantined24h: sql<number>`COUNT(*)`.as("quarantined24h"),
				nonLegacyQuarantined24h:
					sql<number>`COUNT(CASE WHEN ${billingUsageQuarantines.reason} <> 'missing_reservation' THEN 1 END)`.as(
						"nonLegacyQuarantined24h",
					),
			})
			.from(billingUsageQuarantines)
			.where(gte(billingUsageQuarantines.createdAt, since24h)),
	]);
	const row: Record<string, unknown> = {
		...calls[0],
		...charges[0],
		...quarantines[0],
	};
	return {
		unsettledReservedSuccessCount: Number(
			row.unsettledReservedSuccessCount ?? 0,
		),
		oldestUnsettledAt:
			typeof row.oldestUnsettledAt === "string" ? row.oldestUnsettledAt : null,
		latestSettledAt:
			typeof row.latestSettledAt === "string" ? row.latestSettledAt : null,
		quarantined24h: Number(row.quarantined24h ?? 0),
		nonLegacyQuarantined24h: Number(row.nonLegacyQuarantined24h ?? 0),
	};
}

export async function getBillingUsagePeriod(
	db: DbClient,
	organizationId: string,
	periodStart: string,
): Promise<BillingUsagePeriod | null> {
	const [row] = await db
		.select()
		.from(billingUsagePeriods)
		.where(
			and(
				eq(billingUsagePeriods.organizationId, organizationId),
				eq(billingUsagePeriods.periodStart, periodStart),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function recordBillingProviderReconciliation(
	db: DbClient,
	input: {
		id: string;
		provider: string;
		providerResource: string;
		periodStart: string;
		periodEnd: string;
		providerCostMicros: number;
		evidenceRef: string;
		reconciledBy: string;
		approved?: boolean;
		/**
		 * Ledger total to compare against, when this provider's usage does NOT
		 * live in `billing_usage_charges`.
		 *
		 * Charges hold customer-metered model usage. Provider units that are cost
		 * evidence only — workstation containers, voice — are recorded in
		 * `billing_provider_usage` instead, so the default anti-join finds nothing
		 * and every period would report the provider's full cost as variance.
		 * Callers that own such a ledger pass its total explicitly.
		 */
		ledgerCostMicrosOverride?: number;
		/** Row count behind an overridden ledger total, for the same reason. */
		usageRowCountOverride?: number;
		metadata?: Record<string, JsonValue>;
		now: string;
	},
): Promise<BillingProviderReconciliation> {
	if (
		!Number.isSafeInteger(input.providerCostMicros) ||
		input.providerCostMicros < 0
	) {
		throw new Error("Provider reconciliation cost must be non-negative micros");
	}
	const totals = await db
		.select({
			ledgerCostMicros: sql<number>`COALESCE(SUM(${billingUsageCharges.providerCostMicros}), 0)`,
			usageRowCount: sql<number>`COUNT(*)`,
		})
		.from(billingUsageCharges)
		.where(
			and(
				eq(billingUsageCharges.provider, input.provider),
				gte(billingUsageCharges.occurredAt, input.periodStart),
				lt(billingUsageCharges.occurredAt, input.periodEnd),
				sql`(${input.providerResource} = '' OR COALESCE(
					json_extract(${billingUsageCharges.metadata}, '$.providerResource'),
					json_extract(${billingUsageCharges.metadata}, '$.deployment'),
					''
				) = ${input.providerResource})`,
			),
		);
	const ledgerCostMicros =
		input.ledgerCostMicrosOverride ?? Number(totals[0]?.ledgerCostMicros ?? 0);
	const usageRowCount =
		input.usageRowCountOverride ?? Number(totals[0]?.usageRowCount ?? 0);
	const varianceMicros = input.providerCostMicros - ledgerCostMicros;
	const toleranceMicros = Math.max(
		1_000,
		Math.round(input.providerCostMicros * 0.01),
	);
	const status: BillingProviderReconciliation["status"] = input.approved
		? "approved"
		: Math.abs(varianceMicros) <= toleranceMicros
			? "matched"
			: "variance";
	const [row] = await db
		.insert(billingProviderReconciliations)
		.values({
			id: input.id,
			provider: input.provider,
			providerResource: input.providerResource,
			periodStart: input.periodStart,
			periodEnd: input.periodEnd,
			ledgerCostMicros,
			providerCostMicros: input.providerCostMicros,
			varianceMicros,
			usageRowCount,
			status,
			evidenceRef: input.evidenceRef,
			reconciledBy: input.reconciledBy,
			reconciledAt: input.now,
			metadata: input.metadata ?? {},
			createdAt: input.now,
			updatedAt: input.now,
		})
		.onConflictDoUpdate({
			target: [
				billingProviderReconciliations.provider,
				billingProviderReconciliations.providerResource,
				billingProviderReconciliations.periodStart,
				billingProviderReconciliations.periodEnd,
			],
			set: {
				ledgerCostMicros,
				providerCostMicros: input.providerCostMicros,
				varianceMicros,
				usageRowCount,
				status,
				evidenceRef: input.evidenceRef,
				reconciledBy: input.reconciledBy,
				reconciledAt: input.now,
				metadata: input.metadata ?? {},
				updatedAt: input.now,
			},
		})
		.returning();
	if (!row) throw new Error("Failed to record provider reconciliation");

	await db
		.update(billingUsageCharges)
		.set({ providerReconciledAt: input.now })
		.where(
			and(
				eq(billingUsageCharges.provider, input.provider),
				sql`${billingUsageCharges.occurredAt} >= ${input.periodStart}`,
				sql`${billingUsageCharges.occurredAt} < ${input.periodEnd}`,
				input.providerResource
					? sql`COALESCE(
							json_extract(${billingUsageCharges.metadata}, '$.providerResource'),
							json_extract(${billingUsageCharges.metadata}, '$.deployment'),
							''
						) = ${input.providerResource}`
					: sql`1 = 1`,
			),
		);
	return row;
}

/** Recent source observations, independent of tenant attribution or settlement. */
export async function getRecentProviderPricingHealth(
	db: DbClient,
	window: { sinceInclusive: string; untilExclusive: string },
) {
	if (
		!Number.isFinite(Date.parse(window.sinceInclusive)) ||
		!Number.isFinite(Date.parse(window.untilExclusive)) ||
		window.sinceInclusive >= window.untilExclusive
	)
		throw new Error("Invalid provider pricing health window");
	// One statement gives totals and bounded examples from the same snapshot.
	// Window aggregates run over every group BEFORE LIMIT, not only examples.
	const observations = db.$with("observations").as(
		db
			.select({
				provider: tediCallCosts.provider,
				model: tediCallCosts.model,
				gatewayId: tediCallCosts.gatewayId,
				providerResource: tediCallCosts.providerResource,
				providerBaseUrl: tediCallCosts.providerBaseUrl,
				deployment: tediCallCosts.deployment,
				totalTokens: tediCallCosts.totalTokens,
				orgId: tediCallCosts.orgId,
				billingReservationId: tediCallCosts.billingReservationId,
				snapshotAt: tediCallCosts.snapshotAt,
				reason: sql<string>`CASE
					WHEN ${tediCallCosts.costReason} IN ('missing_rate', 'ambiguous_rate', 'ambiguous_scope', 'invalid_usage',
						'missing_execution', 'unverified_execution', 'rate_authority_unavailable', 'rate_lookup_failed', 'invalid_timestamp') THEN ${tediCallCosts.costReason}
					WHEN ${tediCallCosts.costReason} IS NOT NULL THEN 'unknown_reason'
					WHEN ${tediCallCosts.dataQuality} = 'quarantined_failed' THEN 'failed_usage_unknown'
					WHEN ${tediCallCosts.dataQuality} = 'quarantined_no_pricing' AND ${tediCallCosts.costBasis} = 'legacy_estimate' THEN 'legacy_unspecified_no_pricing'
					ELSE 'missing_cost_evidence'
				END`.as("reason"),
			})
			.from(tediCallCosts)
			.where(
				and(
					gte(tediCallCosts.snapshotAt, window.sinceInclusive),
					lt(tediCallCosts.snapshotAt, window.untilExclusive),
					sql`${tediCallCosts.provider} IN ('azure-openai', 'workers-ai')`,
					sql`(${tediCallCosts.source} = 'ai-gateway-log' OR ${tediCallCosts.source} LIKE 'ai-gateway-log:%')`,
					isNull(tediCallCosts.usageKind),
					sql`${tediCallCosts.source} NOT IN ('ai-gateway-log:voice-stt', 'ai-gateway-log:voice-tts')`,
					sql`(${tediCallCosts.dataQuality} = 'quarantined_no_pricing' OR ${tediCallCosts.costBasis} = 'unknown' OR ${tediCallCosts.estimatedCostUsd} IS NULL)`,
				),
			),
	);
	const grouped = db.$with("grouped").as(
		db
			.select({
				provider: observations.provider,
				model: observations.model,
				gatewayId: observations.gatewayId,
				providerResource: observations.providerResource,
				providerBaseUrl: observations.providerBaseUrl,
				deployment: observations.deployment,
				reason: observations.reason,
				rowCount: sql<number>`COUNT(*)`.as("row_count"),
				tokens: sql<number>`COALESCE(SUM(${observations.totalTokens}), 0)`.as(
					"tokens",
				),
				unattributedCount:
					sql<number>`SUM(CASE WHEN ${observations.orgId} IS NULL THEN 1 ELSE 0 END)`.as(
						"unattributed_count",
					),
				unreservedCount:
					sql<number>`SUM(CASE WHEN ${observations.billingReservationId} IS NULL THEN 1 ELSE 0 END)`.as(
						"unreserved_count",
					),
				firstAt: sql<string>`MIN(${observations.snapshotAt})`.as("first_at"),
				lastAt: sql<string>`MAX(${observations.snapshotAt})`.as("last_at"),
			})
			.from(observations)
			.groupBy(
				observations.provider,
				observations.model,
				observations.gatewayId,
				observations.providerResource,
				observations.providerBaseUrl,
				observations.deployment,
				observations.reason,
			),
	);
	const groups = (await db
		.with(observations, grouped)
		.select({
			provider: grouped.provider,
			model: grouped.model,
			gatewayId: grouped.gatewayId,
			providerResource: grouped.providerResource,
			providerOrigin: grouped.providerBaseUrl,
			deployment: grouped.deployment,
			reason: grouped.reason,
			rowCount: grouped.rowCount,
			tokens: grouped.tokens,
			unattributedCount: grouped.unattributedCount,
			unreservedCount: grouped.unreservedCount,
			firstObservedAt: grouped.firstAt,
			lastObservedAt: grouped.lastAt,
			totalRows: sql<number>`SUM(${grouped.rowCount}) OVER ()`,
			totalTokens: sql<number>`SUM(${grouped.tokens}) OVER ()`,
			totalUnattributed: sql<number>`SUM(${grouped.unattributedCount}) OVER ()`,
			totalUnreserved: sql<number>`SUM(${grouped.unreservedCount}) OVER ()`,
			missingRateRows: sql<number>`SUM(CASE WHEN ${grouped.reason} = 'missing_rate' THEN ${grouped.rowCount} ELSE 0 END) OVER ()`,
			totalGroups: sql<number>`COUNT(*) OVER ()`,
			firstAt: sql<string>`MIN(${grouped.firstAt}) OVER ()`,
			lastAt: sql<string>`MAX(${grouped.lastAt}) OVER ()`,
		})
		.from(grouped)
		.orderBy(
			desc(grouped.rowCount),
			grouped.provider,
			grouped.model,
			grouped.gatewayId,
			grouped.providerResource,
			grouped.providerBaseUrl,
			grouped.deployment,
			grouped.reason,
		)
		.limit(10)) as Array<{
		provider: string;
		model: string;
		gatewayId: string | null;
		providerResource: string | null;
		providerOrigin: string | null;
		deployment: string | null;
		reason: string;
		rowCount: number;
		tokens: number;
		unattributedCount: number;
		unreservedCount: number;
		firstObservedAt: string;
		lastObservedAt: string;
		totalRows: number;
		totalTokens: number;
		totalUnattributed: number;
		totalUnreserved: number;
		missingRateRows: number;
		totalGroups: number;
		firstAt: string;
		lastAt: string;
	}>;
	const first = groups[0];
	const reviewed = await db
		.select({
			reviewedEstimateRowCount: sql<number>`COUNT(${reviewedCostMicros})`,
			reviewedEstimateTokens: sql<number>`COALESCE(SUM(CASE WHEN ${reviewedCostMicros} IS NOT NULL THEN ${tediCallCosts.totalTokens} ELSE 0 END),0)`,
			reviewedEstimateMicros: sql<number>`COALESCE(SUM(${reviewedCostMicros}),0)`,
			sourceRetiredRowCount: sql<number>`COALESCE(SUM(${sourceRetiredProjection}),0)`,
		})
		.from(effectiveCallCostsRelation())
		.where(
			and(
				gte(tediCallCosts.snapshotAt, window.sinceInclusive),
				lt(tediCallCosts.snapshotAt, window.untilExclusive),
				sql`${tediCallCosts.provider} IN ('azure-openai','workers-ai')`,
				isNull(tediCallCosts.usageKind),
			),
		);
	return {
		...reviewed[0]!,
		affectedRows: first?.totalRows ?? 0,
		affectedTokens: first?.totalTokens ?? 0,
		unattributedRows: first?.totalUnattributed ?? 0,
		unreservedRows: first?.totalUnreserved ?? 0,
		missingRateRows: first?.missingRateRows ?? 0,
		firstObservedAt: first?.firstAt ?? null,
		lastObservedAt: first?.lastAt ?? null,
		omittedGroupCount: Math.max(0, (first?.totalGroups ?? 0) - groups.length),
		groups: groups.map(
			({
				provider,
				model,
				gatewayId,
				providerResource,
				providerOrigin,
				deployment,
				reason,
				rowCount,
				tokens,
				unattributedCount,
				unreservedCount,
				firstObservedAt,
				lastObservedAt,
			}) => ({
				provider,
				model,
				gatewayId,
				providerResource,
				providerOrigin,
				deployment,
				reason,
				rowCount,
				tokens,
				unattributedCount,
				unreservedCount,
				firstObservedAt,
				lastObservedAt,
			}),
		),
	};
}

/** Platform-only token observations: ownership, pricing and receipt coverage are separate. */
export async function getRecentProviderAttributionHealth(
	db: DbClient,
	window: { sinceInclusive: string; untilExclusive: string },
) {
	const sinceMs = Date.parse(window.sinceInclusive);
	const untilMs = Date.parse(window.untilExclusive);
	if (
		!Number.isFinite(sinceMs) ||
		!Number.isFinite(untilMs) ||
		sinceMs >= untilMs
	)
		throw new Error("Invalid provider attribution health window");
	const sinceInclusive = new Date(sinceMs).toISOString();
	const untilExclusive = new Date(untilMs).toISOString();
	const call = tediCallCosts;
	const observations = db.$with("observations").as(
		db
			.select({
				provider: call.provider,
				success: call.success,
				totalTokens: call.totalTokens,
				billingReservationId: call.billingReservationId,
				ownership:
					sql<string>`CASE WHEN ${call.orgId} IS NULL THEN 'unproven' ELSE 'attributed' END`.as(
						"ownership",
					),
				pricing:
					sql<string>`CASE WHEN ${call.dataQuality} = 'ok' AND ${call.costBasis} <> 'unknown' AND ${call.estimatedCostUsd} >= 0 THEN 'priced' ELSE 'incomplete' END`.as(
						"pricing",
					),
				reservationMatch: exists(
					db
						.select({ one: sql`1` })
						.from(billingUsageReservations)
						.where(
							and(
								eq(billingUsageReservations.id, call.billingReservationId),
								eq(billingUsageReservations.organizationId, call.orgId),
							),
						),
				).as("reservation_match"),
				expiredMatch: exists(
					db
						.select({ one: sql`1` })
						.from(billingUsageReservations)
						.where(
							and(
								eq(billingUsageReservations.id, call.billingReservationId),
								eq(billingUsageReservations.organizationId, call.orgId),
								eq(billingUsageReservations.status, "expired"),
							),
						),
				).as("expired_match"),
				chargeMatch: exists(
					db
						.select({ one: sql`1` })
						.from(billingUsageCharges)
						.where(
							and(
								eq(billingUsageCharges.gatewayLogId, call.gatewayLogId),
								eq(
									billingUsageCharges.reservationId,
									call.billingReservationId,
								),
								eq(billingUsageCharges.organizationId, call.orgId),
							),
						),
				).as("charge_match"),
				chargeConflict: exists(
					db
						.select({ one: sql`1` })
						.from(billingUsageCharges)
						.where(
							and(
								eq(billingUsageCharges.gatewayLogId, call.gatewayLogId),
								sql`(${billingUsageCharges.reservationId} IS NOT ${call.billingReservationId} OR ${billingUsageCharges.organizationId} IS NOT ${call.orgId})`,
							),
						),
				).as("charge_conflict"),
				holdMatch: exists(
					db
						.select({ one: sql`1` })
						.from(billingUsageQuarantines)
						.where(
							and(
								eq(billingUsageQuarantines.gatewayLogId, call.gatewayLogId),
								eq(billingUsageQuarantines.organizationId, call.orgId),
								eq(billingUsageQuarantines.sourceSnapshotAt, call.snapshotAt),
							),
						),
				).as("hold_match"),
				holdConflict: exists(
					db
						.select({ one: sql`1` })
						.from(billingUsageQuarantines)
						.where(
							and(
								eq(billingUsageQuarantines.gatewayLogId, call.gatewayLogId),
								sql`(${billingUsageQuarantines.organizationId} IS NOT ${call.orgId} OR ${billingUsageQuarantines.organizationId} IS NULL OR ${billingUsageQuarantines.sourceSnapshotAt} IS NOT ${call.snapshotAt})`,
							),
						),
				).as("hold_conflict"),
			})
			.from(call)
			.where(
				and(
					gte(call.snapshotAt, sinceInclusive),
					lt(call.snapshotAt, untilExclusive),
					sql`${call.provider} IN ('azure-openai','workers-ai')`,
					sql`(${call.source} = 'ai-gateway-log' OR ${call.source} LIKE 'ai-gateway-log:%')`,
					isNull(call.usageKind),
					sql`${call.source} NOT IN ('ai-gateway-log:voice-stt','ai-gateway-log:voice-tts')`,
				),
			),
	);
	const o = observations;
	const classified = db.$with("classified").as(
		db
			.select({
				provider: o.provider,
				totalTokens: o.totalTokens,
				billingReservationId: o.billingReservationId,
				ownership: o.ownership,
				pricing: o.pricing,
				chargeMatch: o.chargeMatch,
				chargeConflict: o.chargeConflict,
				holdMatch: o.holdMatch,
				holdConflict: o.holdConflict,
				expiredObserved:
					sql<number>`CASE WHEN ${o.expiredMatch} AND ${o.success} = 1 AND ${o.totalTokens} > 0 THEN 1 ELSE 0 END`.as(
						"expired_observed",
					),
				disposition: sql<string>`CASE
					WHEN ${o.chargeMatch} THEN 'settled'
					WHEN (${o.billingReservationId} IS NOT NULL AND NOT ${o.reservationMatch}) OR ${o.chargeConflict} OR ${o.holdConflict} THEN 'relationship_unproven'
					WHEN ${o.holdMatch} THEN 'held'
					ELSE 'unresolved'
				END`.as("disposition"),
			})
			.from(o),
	);
	const c = classified;
	const grouped = db.$with("grouped").as(
		db
			.select({
				provider: c.provider,
				ownership: c.ownership,
				pricing: c.pricing,
				disposition: c.disposition,
				rowCount: sql<number>`COUNT(*)`.as("row_count"),
				tokens: sql<number>`COALESCE(SUM(${c.totalTokens}),0)`.as("tokens"),
			})
			.from(c)
			.groupBy(c.provider, c.ownership, c.pricing, c.disposition),
	);
	const totals = db.$with("totals").as(
		db
			.select({
				invalidTokenRows:
					sql<number>`COALESCE(SUM(typeof(${c.totalTokens}) <> 'integer' OR ${c.totalTokens} < 0 OR ${c.totalTokens} > 9007199254740991),0)`.as(
						"invalidTokenRows",
					),
				totalRows: sql<number>`COUNT(*)`.as("totalRows"),
				totalTokens: sql<number>`COALESCE(SUM(${c.totalTokens}),0)`.as(
					"totalTokens",
				),
				unattributedRows:
					sql<number>`COALESCE(SUM(${c.ownership} = 'unproven'),0)`.as(
						"unattributedRows",
					),
				unattributedTokens:
					sql<number>`COALESCE(SUM(CASE WHEN ${c.ownership} = 'unproven' THEN ${c.totalTokens} ELSE 0 END),0)`.as(
						"unattributedTokens",
					),
				expiredObservedRows:
					sql<number>`COALESCE(SUM(${c.expiredObserved}),0)`.as(
						"expiredObservedRows",
					),
				expiredReservations:
					sql<number>`COUNT(DISTINCT CASE WHEN ${c.expiredObserved} THEN ${c.billingReservationId} END)`.as(
						"expiredReservations",
					),
				expiredUnresolvedRows:
					sql<number>`COALESCE(SUM(${c.expiredObserved} AND ${c.disposition} = 'unresolved'),0)`.as(
						"expiredUnresolvedRows",
					),
				expiredHeldRows:
					sql<number>`COALESCE(SUM(${c.expiredObserved} AND ${c.disposition} = 'held'),0)`.as(
						"expiredHeldRows",
					),
				expiredSettledRows:
					sql<number>`COALESCE(SUM(${c.expiredObserved} AND ${c.disposition} = 'settled'),0)`.as(
						"expiredSettledRows",
					),
				relationshipUnprovenRows:
					sql<number>`COALESCE(SUM(${c.disposition} = 'relationship_unproven'),0)`.as(
						"relationshipUnprovenRows",
					),
				historicalHoldRows:
					sql<number>`COALESCE(SUM(${c.chargeMatch} AND ${c.holdMatch}),0)`.as(
						"historicalHoldRows",
					),
				conflictingReceiptRows:
					sql<number>`COALESCE(SUM(${c.chargeConflict} OR ${c.holdConflict}),0)`.as(
						"conflictingReceiptRows",
					),
			})
			.from(c),
	);
	const rows = (await db
		.with(observations, classified, grouped, totals)
		.select({
			invalidTokenRows: totals.invalidTokenRows,
			totalRows: totals.totalRows,
			totalTokens: totals.totalTokens,
			unattributedRows: totals.unattributedRows,
			unattributedTokens: totals.unattributedTokens,
			expiredObservedRows: totals.expiredObservedRows,
			expiredReservations: totals.expiredReservations,
			expiredUnresolvedRows: totals.expiredUnresolvedRows,
			expiredHeldRows: totals.expiredHeldRows,
			expiredSettledRows: totals.expiredSettledRows,
			relationshipUnprovenRows: totals.relationshipUnprovenRows,
			historicalHoldRows: totals.historicalHoldRows,
			conflictingReceiptRows: totals.conflictingReceiptRows,
			provider: grouped.provider,
			ownership: grouped.ownership,
			pricing: grouped.pricing,
			disposition: grouped.disposition,
			rowCount: grouped.rowCount,
			tokens: grouped.tokens,
			totalGroups: sql<number>`${db.select({ count: sql`COUNT(*)` }).from(grouped)}`,
		})
		.from(totals)
		.leftJoin(grouped, sql`1=1`)
		.orderBy(
			desc(grouped.rowCount),
			grouped.provider,
			grouped.ownership,
			grouped.pricing,
			grouped.disposition,
		)
		.limit(10)) as Array<{
		provider: string | null;
		ownership: string | null;
		pricing: string | null;
		disposition: string | null;
		rowCount: number | null;
		tokens: number | null;
		totalRows: number;
		totalTokens: number;
		unattributedRows: number;
		unattributedTokens: number;
		expiredObservedRows: number;
		expiredReservations: number;
		expiredUnresolvedRows: number;
		expiredHeldRows: number;
		expiredSettledRows: number;
		relationshipUnprovenRows: number;
		historicalHoldRows: number;
		conflictingReceiptRows: number;
		totalGroups: number;
		invalidTokenRows: number;
	}>;
	const row = rows[0]!;
	if (row.invalidTokenRows !== 0)
		throw new Error("Invalid provider attribution health source tokens");
	const count = (value: number) => {
		if (!Number.isSafeInteger(value) || value < 0)
			throw new Error("Invalid provider attribution health aggregate");
		return value;
	};
	return {
		totalRows: count(row.totalRows),
		totalTokens: count(row.totalTokens),
		unattributedRows: count(row.unattributedRows),
		unattributedTokens: count(row.unattributedTokens),
		expiredObservedRows: count(row.expiredObservedRows),
		expiredReservations: count(row.expiredReservations),
		expiredUnresolvedRows: count(row.expiredUnresolvedRows),
		expiredHeldRows: count(row.expiredHeldRows),
		expiredSettledRows: count(row.expiredSettledRows),
		relationshipUnprovenRows: count(row.relationshipUnprovenRows),
		historicalHoldRows: count(row.historicalHoldRows),
		conflictingReceiptRows: count(row.conflictingReceiptRows),
		omittedGroupCount: Math.max(
			0,
			count(row.totalGroups) - rows.filter((r) => r.ownership !== null).length,
		),
		groups: rows
			.filter((r) => r.ownership !== null)
			.map((r) => ({
				provider: r.provider!,
				ownership: r.ownership!,
				pricing: r.pricing!,
				disposition: r.disposition!,
				rowCount: count(r.rowCount!),
				tokens: count(r.tokens!),
			})),
	};
}
