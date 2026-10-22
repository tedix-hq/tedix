import { reviewedProviderCostSummary } from "@tedix/api-contract/schemas/cost-provenance";
/**
 * Organization Usage Router
 * Aggregates token usage across all tedis in an org.
 * Aligns with Stripe pricing plan token limits.
 */

import { implement } from "@orpc/server";
import { orgUsageContract } from "@tedix/api-contract/contracts/org-usage";
import {
	type CostRollupResult,
	listCostRollups,
	nextUtcDay,
	previousUtcDay,
} from "@tedix/db/queries/billing/cost-rollups";
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
	type NormalizedLedgerRow,
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

interface UsageCounters {
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalTokens: number;
	knownSubtotalUsd: number;
	rowCount: number;
	pricedRowCount: number;
	unpricedRowCount: number;
	unpricedTokens: number;
	reviewedEstimateRowCount: number;
	reviewedEstimateTokens: number;
	reviewedEstimateMicros: number;
	sourceRetiredRowCount: number;
}

/**
 * Calls that share every attribute organization usage reports by, already
 * normalized exactly like ledger rows. `latest*` is the newest call in ledger
 * order, so folding contributions newest-first preserves the row-by-row
 * first-seen order that breaks cost ties.
 */
interface UsageContribution extends UsageCounters {
	latestSnapshotAt: string;
	latestCallId: string;
	day: string;
	tediId: string;
	tediName: string;
	tediSlug: string;
	sessionType: string;
	source: string;
	model: string;
	provider: string | null;
	providerResource: string | null;
	providerBaseUrl: string | null;
	deployment: string | null;
}

type UsageAggregate = UsageCounters & {
	totalCostUsd: number | null;
	costCompleteness: "complete" | "partial" | "unknown";
};

/** The aggregate subset organization usage renders; a CostDrilldown fits it. */
interface OrgUsageFold {
	totals: Omit<
		UsageCounters,
		| "totalInputTokens"
		| "totalOutputTokens"
		| "totalCacheReadTokens"
		| "totalCacheWriteTokens"
		| "rowCount"
	> & {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		estimatedCostUsd: number | null;
	};
	byTedi: Array<
		UsageAggregate & { tediId: string; tediName: string; tediSlug: string }
	>;
	bySource: Array<UsageAggregate & { source: string; sessionType: string }>;
	byModel: Array<
		UsageAggregate & {
			model: string;
			provider: string | null;
			providerResource: string | null;
			deployment: string | null;
		}
	>;
	daily: Array<UsageAggregate & { date: string }>;
}

function emptyCounters(): UsageCounters {
	return {
		totalInputTokens: 0,
		totalOutputTokens: 0,
		totalCacheReadTokens: 0,
		totalCacheWriteTokens: 0,
		totalTokens: 0,
		knownSubtotalUsd: 0,
		rowCount: 0,
		pricedRowCount: 0,
		unpricedRowCount: 0,
		unpricedTokens: 0,
		reviewedEstimateRowCount: 0,
		reviewedEstimateTokens: 0,
		reviewedEstimateMicros: 0,
		sourceRetiredRowCount: 0,
	};
}

function addCounters(target: UsageCounters, add: UsageCounters) {
	target.totalInputTokens += add.totalInputTokens;
	target.totalOutputTokens += add.totalOutputTokens;
	target.totalCacheReadTokens += add.totalCacheReadTokens;
	target.totalCacheWriteTokens += add.totalCacheWriteTokens;
	target.totalTokens += add.totalTokens;
	target.knownSubtotalUsd += add.knownSubtotalUsd;
	target.rowCount += add.rowCount;
	target.pricedRowCount += add.pricedRowCount;
	target.unpricedRowCount += add.unpricedRowCount;
	target.unpricedTokens += add.unpricedTokens;
	target.reviewedEstimateRowCount += add.reviewedEstimateRowCount;
	target.reviewedEstimateTokens += add.reviewedEstimateTokens;
	target.reviewedEstimateMicros += add.reviewedEstimateMicros;
	target.sourceRetiredRowCount += add.sourceRetiredRowCount;
}

function ledgerContribution(row: NormalizedLedgerRow): UsageContribution {
	const priced = row.estimatedCostUsd !== null;
	return {
		latestSnapshotAt: row.snapshotAt,
		latestCallId: row.id,
		day: row.snapshotAt.slice(0, 10),
		tediId: row.tediId,
		tediName: row.tediName,
		tediSlug: row.tediSlug,
		sessionType: row.sessionType,
		source: row.source,
		model: row.model,
		provider: row.provider,
		providerResource: row.providerResource,
		providerBaseUrl: row.providerBaseUrl,
		deployment: row.deployment,
		totalInputTokens: row.inputTokens,
		totalOutputTokens: row.outputTokens,
		totalCacheReadTokens: row.cacheReadTokens,
		totalCacheWriteTokens: row.cacheWriteTokens,
		totalTokens: row.totalTokens,
		knownSubtotalUsd: row.estimatedCostUsd ?? 0,
		rowCount: 1,
		pricedRowCount: priced ? 1 : 0,
		unpricedRowCount: priced ? 0 : 1,
		unpricedTokens: priced ? 0 : row.totalTokens,
		reviewedEstimateRowCount: row.providerCostEvidence ? 1 : 0,
		reviewedEstimateTokens: row.providerCostEvidence ? row.totalTokens : 0,
		reviewedEstimateMicros:
			row.providerCostEvidence?.providerEstimatedCostMicros ?? 0,
		sourceRetiredRowCount: row.sourceRetired ? 1 : 0,
	};
}

/** Same attribution normalization `normalizeLedgerRows` applies to raw rows. */
function rollupContribution(row: CostRollupResult): UsageContribution {
	const model = row.model?.trim() ? row.model : "unknown";
	return {
		latestSnapshotAt: row.latestSnapshotAt,
		latestCallId: row.latestCallId,
		day: row.day,
		tediId: row.tediId ?? "unattributed",
		tediName: row.tediName ?? (row.tediId ? "Unknown tedi" : "Unattributed"),
		tediSlug: row.tediSlug ?? (row.tediId ? "unknown" : "unattributed"),
		sessionType: row.sessionType || "unattributed",
		source: row.source,
		model,
		provider: row.provider ?? null,
		providerResource: row.providerResource ?? null,
		providerBaseUrl: row.providerBaseUrl ?? null,
		deployment: row.deployment ?? (model !== "unknown" ? model : null),
		totalInputTokens: row.inputTokens,
		totalOutputTokens: row.outputTokens,
		totalCacheReadTokens: row.cacheReadTokens,
		totalCacheWriteTokens: row.cacheWriteTokens,
		totalTokens: row.totalTokens,
		knownSubtotalUsd: row.estimatedCostUsd,
		rowCount: row.callCount,
		pricedRowCount: row.pricedCallCount,
		unpricedRowCount: row.callCount - row.pricedCallCount,
		unpricedTokens: row.unpricedTokens,
		reviewedEstimateRowCount: row.reviewedCallCount,
		reviewedEstimateTokens: row.reviewedTokens,
		reviewedEstimateMicros: row.reviewedCostMicros,
		sourceRetiredRowCount: row.retiredCallCount,
	};
}

/**
 * Closed UTC days strictly inside the window come from fresh daily rollups;
 * the window's first and last day, today, and any day without a fresh rollup
 * come from raw ledger rows. Every raw row in the window lands in exactly one
 * of the two sources.
 */
async function loadUsageContributions(
	db: BaseContext["db"],
	organizationId: string,
	window: { from: string; to: string },
	now: Date,
): Promise<UsageContribution[]> {
	const lastClosedDay = [
		previousUtcDay(window.to.slice(0, 10)),
		previousUtcDay(now.toISOString().slice(0, 10)),
	].sort()[0] as string;
	const firstClosedDay = nextUtcDay(window.from.slice(0, 10));
	const rollups =
		firstClosedDay <= lastClosedDay
			? await listCostRollups(db, organizationId, firstClosedDay, lastClosedDay)
			: [];
	const contributions = rollups.map(rollupContribution);

	// "~" sorts after every timestamp character, so `${day}~` closes a day.
	const rawRanges: Array<{ from: string; to: string }> = [];
	let lower = window.from;
	for (const day of [...new Set(rollups.map((row) => row.day))].sort()) {
		const upper = `${previousUtcDay(day)}~`;
		if (lower <= upper) rawRanges.push({ from: lower, to: upper });
		lower = nextUtcDay(day);
	}
	if (lower <= window.to) rawRanges.push({ from: lower, to: window.to });

	const rawGrains = new Map<string, UsageContribution>();
	for (const range of rawRanges) {
		let cursor: { snapshotAt: string; id: string } | undefined;
		for (;;) {
			const rows = await listOrgCallCostLedger(db, {
				organizationId,
				from: range.from,
				to: range.to,
				limit: BILLING_LEDGER_AGGREGATION_PAGE_SIZE,
				cursor,
			});
			// Newest first, so the first row of a grain is its latest call.
			for (const row of normalizeLedgerRows(rows)) {
				const contribution = ledgerContribution(row);
				const key = JSON.stringify([
					contribution.day,
					contribution.tediId,
					contribution.sessionType,
					contribution.source,
					contribution.model,
					contribution.provider,
					contribution.providerResource,
					contribution.providerBaseUrl,
					contribution.deployment,
				]);
				const grain = rawGrains.get(key);
				if (grain) addCounters(grain, contribution);
				else rawGrains.set(key, contribution);
			}
			if (rows.length < BILLING_LEDGER_AGGREGATION_PAGE_SIZE) break;
			const last = rows.at(-1);
			if (!last) break;
			cursor = { snapshotAt: last.snapshotAt, id: last.id };
		}
	}
	contributions.push(...rawGrains.values());
	return contributions;
}

function completedAggregate<T extends UsageCounters>(
	value: T,
): T & UsageAggregate {
	const costCompleteness =
		value.pricedRowCount === 0
			? "unknown"
			: value.unpricedRowCount > 0
				? "partial"
				: "complete";
	return {
		...value,
		costCompleteness,
		totalCostUsd:
			costCompleteness === "complete" ? value.knownSubtotalUsd : null,
	};
}

function byKnownCost<T extends UsageCounters>(values: Iterable<T>) {
	return [...values]
		.map(completedAggregate)
		.sort((a, b) => b.knownSubtotalUsd - a.knownSubtotalUsd);
}

/** Fold contributions newest-first, mirroring the per-row ledger drilldown. */
function foldUsageContributions(
	contributions: UsageContribution[],
): OrgUsageFold {
	const ordered = [...contributions].sort((a, b) =>
		a.latestSnapshotAt === b.latestSnapshotAt
			? a.latestCallId < b.latestCallId
				? 1
				: a.latestCallId > b.latestCallId
					? -1
					: 0
			: a.latestSnapshotAt < b.latestSnapshotAt
				? 1
				: -1,
	);
	const totals = emptyCounters();
	const byTedi = new Map<
		string,
		UsageCounters & { tediId: string; tediName: string; tediSlug: string }
	>();
	const bySource = new Map<
		string,
		UsageCounters & { source: string; sessionType: string }
	>();
	const byModel = new Map<
		string,
		UsageCounters & {
			model: string;
			provider: string | null;
			providerResource: string | null;
			deployment: string | null;
		}
	>();
	const daily = new Map<string, UsageCounters & { date: string }>();
	const add = <T extends UsageCounters>(
		map: Map<string, T>,
		key: string,
		create: () => T,
		contribution: UsageContribution,
	) => {
		let entry = map.get(key);
		if (!entry) {
			entry = create();
			map.set(key, entry);
		}
		addCounters(entry, contribution);
	};

	for (const c of ordered) {
		addCounters(totals, c);
		add(
			byTedi,
			c.tediId,
			() => ({
				...emptyCounters(),
				tediId: c.tediId,
				tediName: c.tediName,
				tediSlug: c.tediSlug,
			}),
			c,
		);
		add(
			bySource,
			`${c.source}::${c.sessionType}`,
			() => ({
				...emptyCounters(),
				source: c.source,
				sessionType: c.sessionType,
			}),
			c,
		);
		add(
			byModel,
			[
				c.provider ?? "unknown",
				c.providerResource ?? c.providerBaseUrl ?? "unknown",
				c.deployment ?? "",
				c.model,
			].join("::"),
			() => ({
				...emptyCounters(),
				model: c.model,
				provider: c.provider,
				providerResource: c.providerResource,
				deployment: c.deployment,
			}),
			c,
		);
		add(daily, c.day, () => ({ ...emptyCounters(), date: c.day }), c);
	}

	const total = completedAggregate(totals);
	return {
		totals: {
			inputTokens: total.totalInputTokens,
			outputTokens: total.totalOutputTokens,
			cacheReadTokens: total.totalCacheReadTokens,
			cacheWriteTokens: total.totalCacheWriteTokens,
			totalTokens: total.totalTokens,
			estimatedCostUsd: total.totalCostUsd,
			knownSubtotalUsd: total.knownSubtotalUsd,
			pricedRowCount: total.pricedRowCount,
			unpricedRowCount: total.unpricedRowCount,
			unpricedTokens: total.unpricedTokens,
			reviewedEstimateRowCount: total.reviewedEstimateRowCount,
			reviewedEstimateTokens: total.reviewedEstimateTokens,
			reviewedEstimateMicros: total.reviewedEstimateMicros,
			sourceRetiredRowCount: total.sourceRetiredRowCount,
		},
		byTedi: byKnownCost(byTedi.values()),
		bySource: byKnownCost(bySource.values()),
		byModel: byKnownCost(byModel.values()),
		daily: [...daily.values()]
			.map(completedAggregate)
			.sort((a, b) => a.date.localeCompare(b.date)),
	};
}

/** Organization usage response sections, from either aggregation path. */
export function projectOrgUsageBreakdowns(usage: OrgUsageFold) {
	const tediBreakdown = usage.byTedi.map((row) => {
		const denominator = row.totalInputTokens + row.totalCacheReadTokens;
		return {
			tediId: row.tediId,
			tediName: row.tediName,
			tediSlug: row.tediSlug,
			totalTokens: row.totalTokens,
			estimatedCostUsd: row.totalCostUsd,
			...reviewedProviderCostSummary(row),
			cacheHitRate:
				denominator > 0 ? row.totalCacheReadTokens / denominator : null,
		};
	});
	return {
		totals: {
			totalTokens: usage.totals.totalTokens,
			inputTokens: usage.totals.inputTokens,
			outputTokens: usage.totals.outputTokens,
			cacheReadTokens: usage.totals.cacheReadTokens,
			cacheWriteTokens: usage.totals.cacheWriteTokens,
			estimatedCostUsd: usage.totals.estimatedCostUsd,
			...reviewedProviderCostSummary(usage.totals),
			activeTedis: tediBreakdown.filter(
				(row) => row.tediId !== "unattributed" && row.totalTokens > 0,
			).length,
		},
		daily: usage.daily.map((row) => ({
			date: row.date,
			totalTokens: row.totalTokens,
			estimatedCostUsd: row.totalCostUsd,
			...reviewedProviderCostSummary(row),
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
			...reviewedProviderCostSummary(row),
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
			...reviewedProviderCostSummary(row),
			rowCount: row.rowCount,
		})),
	};
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
		const usage = foldUsageContributions(
			await loadUsageContributions(db, organizationId, window, now),
		);
		const breakdowns = projectOrgUsageBreakdowns(usage);

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
			totals: breakdowns.totals,
			planLimits: {
				maxTokensPerMonth,
				currentMonthTokens: billing.usedTokens,
				usagePct,
				maxTedis,
				currentTedis: tedis.length,
			},
			daily: breakdowns.daily,
			tediBreakdown: breakdowns.tediBreakdown,
			modelBreakdown: breakdowns.modelBreakdown,
			sourceBreakdown: breakdowns.sourceBreakdown,
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
