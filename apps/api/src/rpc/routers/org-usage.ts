import { costSummary } from "@tedix/api-contract/schemas/cost-provenance";
/**
 * Organization Usage Router
 * Aggregates token usage across all tedis in an org.
 * Aligns with Stripe pricing plan token limits.
 */

import { implement } from "@orpc/server";
import { orgUsageContract } from "@tedix/api-contract/contracts/org-usage";
import { getBillingBalanceSnapshot } from "@tedix/db/queries/billing/credits";
import { getRuntimeEntitlement } from "@tedix/db/queries/runtime-entitlements";
import { getOrganizationById } from "@tedix/db/queries/organizations";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import { listOrgCallCostLedger } from "@tedix/db/queries/usage-ledger";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";
import { requireOrgId } from "../org-scope";
import {
	buildCostDrilldown,
	type CostPeriod,
	mergeCostDrilldowns,
	normalizeLedgerRows,
} from "./usage-ledger";

const orgUsageOs = implement(orgUsageContract).$context<BaseContext>();
const authedOs = orgUsageOs.use(withAuth);

const USAGE_PERIOD_DAYS = { "24h": 1, "7d": 7, "30d": 30 } as const;
const BILLING_LEDGER_AGGREGATION_PAGE_SIZE = 5_000;

function usageWindow(
	period: CostPeriod,
	requested?: { from: string; to: string },
) {
	if (requested) {
		return {
			days: Math.max(
				1,
				Math.ceil(
					(Date.parse(requested.to) - Date.parse(requested.from)) /
						(24 * 60 * 60 * 1000),
				),
			),
			from: requested.from,
			to: requested.to,
		};
	}
	const now = new Date();
	const days = USAGE_PERIOD_DAYS[period];
	const from = new Date(
		now.getTime() - days * 24 * 60 * 60 * 1000,
	).toISOString();
	return { days, from, to: now.toISOString() };
}

/** OS billing remains bound to the host-resolved organization, even for owners. */
export function requireBillingOrganization(
	context: BaseContext,
	requestedOrganizationId: string,
	detail: string,
) {
	const scopedOrganizationId = requireOrgId(context, detail);
	if (scopedOrganizationId !== requestedOrganizationId) {
		throw createError(ErrorCodes.FORBIDDEN, "Organization access denied");
	}
	return scopedOrganizationId;
}

const getOrgUsageProcedure = authedOs.getOrgUsage
	.use(AUTHZ.billingRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { organizationId, period, window: requestedWindow } = input;
		requireBillingOrganization(context, organizationId, "billing usage");

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const tedis = await getTedisByOrganization(db, organizationId);
		const now = new Date();
		const window = usageWindow(period, requestedWindow);
		const parts = [];
		let cursor: { snapshotAt: string; id: string } | undefined;
		for (;;) {
			const rows = await listOrgCallCostLedger(db, {
				organizationId,
				from: window.from,
				to: window.to,
				limit: BILLING_LEDGER_AGGREGATION_PAGE_SIZE,
				cursor,
			});
			parts.push(
				buildCostDrilldown({
					rows: normalizeLedgerRows(rows),
					period,
					days: window.days,
				}),
			);
			if (rows.length < BILLING_LEDGER_AGGREGATION_PAGE_SIZE) break;
			const last = rows.at(-1);
			if (!last) break;
			cursor = { snapshotAt: last.snapshotAt, id: last.id };
		}
		const usage = mergeCostDrilldowns({ parts, period, days: window.days });
		const tediBreakdown = usage.byTedi.map((row) => {
			const denominator = row.totalInputTokens + row.totalCacheReadTokens;
			return {
				tediId: row.tediId,
				tediName: row.tediName,
				tediSlug: row.tediSlug,
				totalTokens: row.totalTokens,
				estimatedCostUsd: row.totalCostUsd,
				...costSummary(row),
				cacheHitRate:
					denominator > 0 ? row.totalCacheReadTokens / denominator : null,
			};
		});

		// Financial usage remains billing-owned; runtime capacity comes from the
		// provider-neutral entitlement projection.
		const billing = await getBillingBalanceSnapshot(
			db,
			organizationId,
			now.toISOString(),
		);
		if (!billing) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Billing account is not configured",
			);
		}
		const maxTokensPerMonth = billing.includedTokens;
		const maxTedis =
			(await getRuntimeEntitlement(db, organizationId))?.limits.maxTedis ?? 1;
		const usagePct =
			maxTokensPerMonth > 0 ? billing.usedTokens / maxTokensPerMonth : null;

		return {
			organization: {
				id: org.id,
				name: org.name,
				tier: billing.planKey,
				status: billing.status,
			},
			period,
			window: { from: window.from, to: window.to },
			totals: {
				totalTokens: usage.totals.totalTokens,
				inputTokens: usage.totals.inputTokens,
				outputTokens: usage.totals.outputTokens,
				cacheReadTokens: usage.totals.cacheReadTokens,
				cacheWriteTokens: usage.totals.cacheWriteTokens,
				estimatedCostUsd: usage.totals.estimatedCostUsd,
				...costSummary(usage.totals),
				activeTedis: tediBreakdown.filter(
					(row) => row.tediId !== "unattributed" && row.totalTokens > 0,
				).length,
			},
			planLimits: {
				maxTokensPerMonth,
				currentMonthTokens: billing.usedTokens,
				usagePct,
				maxTedis,
				currentTedis: tedis.length,
			},
			daily: usage.daily.map((row) => ({
				date: row.date,
				totalTokens: row.totalTokens,
				estimatedCostUsd: row.totalCostUsd,
				...costSummary(row),
				inputTokens: row.totalInputTokens,
				outputTokens: row.totalOutputTokens,
			})),
			tediBreakdown,
			modelBreakdown: usage.byModel.map((row) => ({
				model: row.model,
				provider: row.provider,
				providerResource: row.providerResource,
				deployment: row.deployment,
				totalInputTokens: row.totalInputTokens,
				totalOutputTokens: row.totalOutputTokens,
				totalCacheReadTokens: row.totalCacheReadTokens,
				totalCacheWriteTokens: row.totalCacheWriteTokens,
				totalTokens: row.totalTokens,
				totalCostUsd: row.totalCostUsd,
				...costSummary(row),
				snapshotCount: row.rowCount,
			})),
			sourceBreakdown: usage.bySource.map((row) => ({
				source: row.source,
				sessionType: row.sessionType,
				totalInputTokens: row.totalInputTokens,
				totalOutputTokens: row.totalOutputTokens,
				totalCacheReadTokens: row.totalCacheReadTokens,
				totalCacheWriteTokens: row.totalCacheWriteTokens,
				totalTokens: row.totalTokens,
				totalCostUsd: row.totalCostUsd,
				...costSummary(row),
				rowCount: row.rowCount,
			})),
		};
	});

const getCostDrilldownProcedure = authedOs.getCostDrilldown
	.use(AUTHZ.billingRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const {
			organizationId,
			period,
			tediId,
			source,
			model,
			includeUnattributed,
			sessionLimit,
		} = input;
		requireBillingOrganization(context, organizationId, "cost drilldown");

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const billing = await getBillingBalanceSnapshot(
			db,
			organizationId,
			new Date().toISOString(),
		);
		if (!billing) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Billing account is not configured",
			);
		}

		const window = usageWindow(period);
		const drilldownParts = [];
		let cursor: { snapshotAt: string; id: string } | undefined;

		for (;;) {
			const ledgerRows = await listOrgCallCostLedger(db, {
				organizationId,
				from: window.from,
				to: window.to,
				tediId,
				source,
				model,
				includeUnattributed,
				limit: BILLING_LEDGER_AGGREGATION_PAGE_SIZE,
				cursor,
			});
			drilldownParts.push(
				buildCostDrilldown({
					rows: normalizeLedgerRows(ledgerRows),
					period,
					days: window.days,
					sessionLimit,
				}),
			);
			if (ledgerRows.length < BILLING_LEDGER_AGGREGATION_PAGE_SIZE) break;

			const last = ledgerRows.at(-1);
			if (!last) break;
			cursor = { snapshotAt: last.snapshotAt, id: last.id };
		}

		const drilldown = mergeCostDrilldowns({
			parts: drilldownParts,
			period,
			days: window.days,
		});

		return {
			organization: {
				id: org.id,
				name: org.name,
				tier: billing.planKey,
				status: billing.status,
			},
			period,
			window: {
				from: window.from,
				to: window.to,
			},
			...drilldown,
		};
	});

const getBillingLedgerProcedure = authedOs.getBillingLedger
	.use(AUTHZ.billingRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const {
			organizationId,
			period,
			tediId,
			source,
			model,
			includeUnattributed,
			limit,
		} = input;
		requireBillingOrganization(context, organizationId, "billing ledger");

		const org = await getOrganizationById(db, organizationId);
		if (!org) {
			throw createError(ErrorCodes.NOT_FOUND, "Organization not found");
		}

		const billing = await getBillingBalanceSnapshot(
			db,
			organizationId,
			new Date().toISOString(),
		);
		if (!billing) {
			throw createError(
				ErrorCodes.NOT_FOUND,
				"Billing account is not configured",
			);
		}

		const window = usageWindow(period);
		const drilldownParts = [];
		const rows = [];
		let cursor: { snapshotAt: string; id: string } | undefined;

		for (;;) {
			const ledgerRows = await listOrgCallCostLedger(db, {
				organizationId,
				from: window.from,
				to: window.to,
				tediId,
				source,
				model,
				includeUnattributed,
				limit: BILLING_LEDGER_AGGREGATION_PAGE_SIZE,
				cursor,
			});
			const normalized = normalizeLedgerRows(ledgerRows);
			drilldownParts.push(
				buildCostDrilldown({
					rows: normalized,
					period,
					days: window.days,
				}),
			);
			if (rows.length < limit) {
				rows.push(...normalized.slice(0, limit - rows.length));
			}
			if (ledgerRows.length < BILLING_LEDGER_AGGREGATION_PAGE_SIZE) break;

			const last = ledgerRows.at(-1);
			if (!last) break;
			cursor = { snapshotAt: last.snapshotAt, id: last.id };
		}

		const drilldown = mergeCostDrilldowns({
			parts: drilldownParts,
			period,
			days: window.days,
		});

		return {
			organization: {
				id: org.id,
				name: org.name,
				tier: billing.planKey,
				status: billing.status,
			},
			period,
			window: {
				from: window.from,
				to: window.to,
			},
			totals: drilldown.totals,
			billing: drilldown.billing,
			dataQuality: drilldown.dataQuality,
			pagination: {
				limit,
				returnedRows: rows.length,
				totalRows: drilldown.dataQuality.rowCount,
				hasMore: drilldown.dataQuality.rowCount > rows.length,
			},
			rows,
		};
	});

export const orgUsageContractRouter = orgUsageOs.router({
	getOrgUsage: getOrgUsageProcedure,
	getCostDrilldown: getCostDrilldownProcedure,
	getBillingLedger: getBillingLedgerProcedure,
});
