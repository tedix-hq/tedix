/** Canonical billing health queries. */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, eq, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type BillingProviderReconciliation,
	type BillingUsagePeriod,
	billingProviderReconciliations,
	billingUsageCharges,
	billingUsagePeriods,
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
	const rows = (await db.all(sql`
		SELECT
			(
				SELECT COUNT(*)
				FROM tedi_call_costs AS call
				LEFT JOIN billing_usage_charges AS charge
					ON charge.gateway_log_id = call.gateway_log_id
				LEFT JOIN billing_usage_quarantines AS quarantine
					ON quarantine.gateway_log_id = call.gateway_log_id
				WHERE call.success = 1
					AND call.org_id IS NOT NULL
					AND call.billing_reservation_id IS NOT NULL
					AND charge.id IS NULL
					AND quarantine.id IS NULL
			) AS unsettledReservedSuccessCount,
			(
				SELECT MIN(call.snapshot_at)
				FROM tedi_call_costs AS call
				LEFT JOIN billing_usage_charges AS charge
					ON charge.gateway_log_id = call.gateway_log_id
				LEFT JOIN billing_usage_quarantines AS quarantine
					ON quarantine.gateway_log_id = call.gateway_log_id
				WHERE call.success = 1
					AND call.org_id IS NOT NULL
					AND call.billing_reservation_id IS NOT NULL
					AND charge.id IS NULL
					AND quarantine.id IS NULL
			) AS oldestUnsettledAt,
			(SELECT MAX(created_at) FROM billing_usage_charges) AS latestSettledAt,
			(
				SELECT COUNT(*) FROM billing_usage_quarantines
				WHERE created_at >= ${since24h}
			) AS quarantined24h,
			(
				SELECT COUNT(*) FROM billing_usage_quarantines
				WHERE created_at >= ${since24h}
					AND reason <> 'missing_reservation'
			) AS nonLegacyQuarantined24h
	`)) as Array<Record<string, unknown>>;
	const row = rows[0] ?? {};
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
	const totals = (await db.all(sql`
		SELECT
			COALESCE(SUM(provider_cost_micros), 0) AS ledgerCostMicros,
			COUNT(*) AS usageRowCount
		FROM billing_usage_charges
		WHERE provider = ${input.provider}
			AND occurred_at >= ${input.periodStart}
			AND occurred_at < ${input.periodEnd}
			AND (
				${input.providerResource} = ''
				OR COALESCE(
					json_extract(metadata, '$.providerResource'),
					json_extract(metadata, '$.deployment'),
					''
				) = ${input.providerResource}
			)
	`)) as Array<Record<string, unknown>>;
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
	const groups = await db.all<{
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
	}>(sql`
		WITH observations AS (
			SELECT provider, model, gateway_id, provider_resource, provider_base_url, deployment,
				total_tokens, org_id, billing_reservation_id, snapshot_at,
				CASE
					WHEN cost_reason IN ('missing_rate', 'ambiguous_rate', 'ambiguous_scope', 'invalid_usage',
						'missing_execution', 'unverified_execution', 'rate_authority_unavailable', 'rate_lookup_failed', 'invalid_timestamp') THEN cost_reason
					WHEN cost_reason IS NOT NULL THEN 'unknown_reason'
					WHEN data_quality = 'quarantined_failed' THEN 'failed_usage_unknown'
					WHEN data_quality = 'quarantined_no_pricing' AND cost_basis = 'legacy_estimate' THEN 'legacy_unspecified_no_pricing'
					ELSE 'missing_cost_evidence'
				END AS reason
			FROM tedi_call_costs
			WHERE snapshot_at >= ${window.sinceInclusive} AND snapshot_at < ${window.untilExclusive}
				AND provider IN ('azure-openai', 'workers-ai')
				AND (source = 'ai-gateway-log' OR source LIKE 'ai-gateway-log:%')
				AND usage_kind IS NULL
				AND source NOT IN ('ai-gateway-log:voice-stt', 'ai-gateway-log:voice-tts')
				AND (data_quality = 'quarantined_no_pricing' OR cost_basis = 'unknown' OR estimated_cost_usd IS NULL)
		), grouped AS (
			SELECT provider, model, gateway_id, provider_resource, provider_base_url, deployment, reason,
				COUNT(*) AS row_count, COALESCE(SUM(total_tokens), 0) AS tokens,
				SUM(CASE WHEN org_id IS NULL THEN 1 ELSE 0 END) AS unattributed_count,
				SUM(CASE WHEN billing_reservation_id IS NULL THEN 1 ELSE 0 END) AS unreserved_count,
				MIN(snapshot_at) AS first_at, MAX(snapshot_at) AS last_at
			FROM observations
			GROUP BY provider, model, gateway_id, provider_resource, provider_base_url, deployment, reason
		)
		SELECT provider, model, gateway_id AS gatewayId, provider_resource AS providerResource,
			provider_base_url AS providerOrigin, deployment, reason, row_count AS rowCount, tokens,
			unattributed_count AS unattributedCount, unreserved_count AS unreservedCount,
			first_at AS firstObservedAt, last_at AS lastObservedAt,
			SUM(row_count) OVER () AS totalRows, SUM(tokens) OVER () AS totalTokens,
			SUM(unattributed_count) OVER () AS totalUnattributed, SUM(unreserved_count) OVER () AS totalUnreserved,
			SUM(CASE WHEN reason = 'missing_rate' THEN row_count ELSE 0 END) OVER () AS missingRateRows,
			COUNT(*) OVER () AS totalGroups, MIN(first_at) OVER () AS firstAt, MAX(last_at) OVER () AS lastAt
		FROM grouped
		ORDER BY row_count DESC, provider, model, gateway_id, provider_resource, provider_base_url, deployment, reason
		LIMIT 10
	`);
	const first = groups[0];
	return {
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
	const rows = await db.all<{
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
	}>(sql`
 WITH observations AS (
  SELECT call.*,
   CASE WHEN call.org_id IS NULL THEN 'unproven' ELSE 'attributed' END AS ownership,
   CASE WHEN call.data_quality = 'ok' AND call.cost_basis <> 'unknown' AND call.estimated_cost_usd >= 0 THEN 'priced' ELSE 'incomplete' END AS pricing,
   EXISTS (SELECT 1 FROM billing_usage_reservations r WHERE r.id = call.billing_reservation_id AND r.organization_id = call.org_id) AS reservation_match,
   EXISTS (SELECT 1 FROM billing_usage_reservations r WHERE r.id = call.billing_reservation_id AND r.organization_id = call.org_id AND r.status = 'expired') AS expired_match,
   EXISTS (SELECT 1 FROM billing_usage_charges c WHERE c.gateway_log_id = call.gateway_log_id AND c.reservation_id = call.billing_reservation_id AND c.organization_id = call.org_id) AS charge_match,
   EXISTS (SELECT 1 FROM billing_usage_charges c WHERE c.gateway_log_id = call.gateway_log_id AND (c.reservation_id IS NOT call.billing_reservation_id OR c.organization_id IS NOT call.org_id)) AS charge_conflict,
   EXISTS (SELECT 1 FROM billing_usage_quarantines q WHERE q.gateway_log_id = call.gateway_log_id AND q.organization_id = call.org_id AND q.source_snapshot_at = call.snapshot_at) AS hold_match,
   EXISTS (SELECT 1 FROM billing_usage_quarantines q WHERE q.gateway_log_id = call.gateway_log_id AND (q.organization_id IS NOT call.org_id OR q.organization_id IS NULL OR q.source_snapshot_at IS NOT call.snapshot_at)) AS hold_conflict
  FROM tedi_call_costs call
  WHERE call.snapshot_at >= ${sinceInclusive} AND call.snapshot_at < ${untilExclusive}
   AND call.provider IN ('azure-openai','workers-ai')
   AND (call.source = 'ai-gateway-log' OR call.source LIKE 'ai-gateway-log:%')
   AND call.usage_kind IS NULL
   AND call.source NOT IN ('ai-gateway-log:voice-stt','ai-gateway-log:voice-tts')
 ), classified AS (
  SELECT *, CASE WHEN expired_match AND success = 1 AND total_tokens > 0 THEN 1 ELSE 0 END AS expired_observed,
   CASE
    WHEN charge_match THEN 'settled'
    WHEN (billing_reservation_id IS NOT NULL AND NOT reservation_match) OR charge_conflict OR hold_conflict THEN 'relationship_unproven'
    WHEN hold_match THEN 'held'
    ELSE 'unresolved'
   END AS disposition
  FROM observations
 ), grouped AS (
  SELECT provider, ownership, pricing, disposition, COUNT(*) AS row_count, COALESCE(SUM(total_tokens),0) AS tokens
  FROM classified GROUP BY provider, ownership, pricing, disposition
 ), totals AS (
  SELECT COALESCE(SUM(typeof(total_tokens) <> 'integer' OR total_tokens < 0 OR total_tokens > 9007199254740991),0) AS invalidTokenRows, COUNT(*) AS totalRows, COALESCE(SUM(total_tokens),0) AS totalTokens,
   COALESCE(SUM(ownership = 'unproven'),0) AS unattributedRows,
   COALESCE(SUM(CASE WHEN ownership = 'unproven' THEN total_tokens ELSE 0 END),0) AS unattributedTokens,
   COALESCE(SUM(expired_observed),0) AS expiredObservedRows,
   COUNT(DISTINCT CASE WHEN expired_observed THEN billing_reservation_id END) AS expiredReservations,
   COALESCE(SUM(expired_observed AND disposition = 'unresolved'),0) AS expiredUnresolvedRows,
   COALESCE(SUM(expired_observed AND disposition = 'held'),0) AS expiredHeldRows,
   COALESCE(SUM(expired_observed AND disposition = 'settled'),0) AS expiredSettledRows,
   COALESCE(SUM(disposition = 'relationship_unproven'),0) AS relationshipUnprovenRows,
   COALESCE(SUM(charge_match AND hold_match),0) AS historicalHoldRows,
   COALESCE(SUM(charge_conflict OR hold_conflict),0) AS conflictingReceiptRows
  FROM classified
 ) SELECT totals.*, grouped.provider, grouped.ownership, grouped.pricing, grouped.disposition,
  grouped.row_count AS rowCount, grouped.tokens,
  (SELECT COUNT(*) FROM grouped) AS totalGroups
 FROM totals LEFT JOIN grouped ON 1=1
 ORDER BY grouped.row_count DESC, grouped.provider, grouped.ownership, grouped.pricing, grouped.disposition LIMIT 10
 `);
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
