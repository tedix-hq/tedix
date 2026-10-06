import {
	costSummary,
	type CostSummary,
} from "@tedix/api-contract/schemas/cost-provenance";
/**
 * Tedi Token Usage Router
 * Per-call cost metrics (from AI Gateway log ingestion) and optimization
 * recommendations.
 *
 * Uses withAuth to accept service bindings, user JWTs, and API keys.
 */

import { implement } from "@orpc/server";
import { tediUsageContract } from "@tedix/api-contract/contracts/tedi-usage";
import {
	getCallCostHistory,
	getCallCosts,
	getCallCostTotals,
} from "@tedix/db/queries/tedi-usage";
import { getTediById } from "@tedix/db/queries/tedis";
import {
	getUserToolCallMetrics,
	hasAEConfig,
} from "../../lib/analytics-engine";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

// =============================================================================
// HELPERS
// =============================================================================

type CallCost = Awaited<ReturnType<typeof getCallCosts>>[number];

type ModelCostEntry = CostSummary & {
	rowCount: number;
	model: string;
	provider: string | null;
	providerResource: string | null;
	deployment: string | null;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	estimatedCostUsd: number | null;
	sessionCount: number;
};

type SourceCostEntry = CostSummary & {
	source: string;
	sessionType: string;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheWriteTokens: number;
	totalTokens: number;
	totalCostUsd: number | null;
	rowCount: number;
};

function addCost(
	summary: CostSummary,
	row: Pick<CallCost, "estimatedCostUsd" | "totalTokens" | "dataQuality">,
) {
	const known =
		row.dataQuality === "ok" &&
		row.estimatedCostUsd !== null &&
		Number.isFinite(row.estimatedCostUsd) &&
		row.estimatedCostUsd >= 0;
	summary.knownSubtotalUsd += known ? row.estimatedCostUsd! : 0;
	summary.pricedRowCount += known ? 1 : 0;
	summary.unpricedRowCount += known ? 0 : 1;
	summary.unpricedTokens += known ? 0 : row.totalTokens;
	Object.assign(summary, costSummary(summary));
	return summary.costCompleteness === "complete"
		? summary.knownSubtotalUsd
		: null;
}
function initialCost(
	row: Pick<CallCost, "estimatedCostUsd" | "totalTokens" | "dataQuality">,
) {
	const summary = costSummary({
		knownSubtotalUsd: 0,
		pricedRowCount: 0,
		unpricedRowCount: 0,
		unpricedTokens: 0,
	});
	addCost(summary, row);
	return summary;
}

function aggregateModelCosts(costs: CallCost[]): ModelCostEntry[] {
	const summaryMap = new Map<string, ModelCostEntry>();

	for (const cost of costs) {
		const key = `${cost.provider ?? "unknown"}::${cost.providerResource ?? cost.providerBaseUrl ?? "unknown"}::${cost.model}`;
		const existing = summaryMap.get(key);
		if (existing) {
			existing.inputTokens += cost.inputTokens;
			existing.outputTokens += cost.outputTokens;
			existing.cacheReadTokens += cost.cacheReadTokens;
			existing.cacheWriteTokens += cost.cacheWriteTokens;
			existing.totalTokens += cost.totalTokens;
			existing.estimatedCostUsd = addCost(existing, cost);
			existing.rowCount++;
			existing.sessionCount = Math.max(
				existing.sessionCount,
				cost.sessionCount,
			);
		} else {
			summaryMap.set(key, {
				model: cost.model,
				provider: cost.provider ?? null,
				providerResource: cost.providerResource ?? null,
				deployment: cost.deployment ?? null,
				inputTokens: cost.inputTokens,
				outputTokens: cost.outputTokens,
				cacheReadTokens: cost.cacheReadTokens,
				cacheWriteTokens: cost.cacheWriteTokens,
				totalTokens: cost.totalTokens,
				...initialCost(cost),
				rowCount: 1,
				estimatedCostUsd:
					cost.dataQuality === "ok" ? cost.estimatedCostUsd : null,
				sessionCount: cost.sessionCount,
			});
		}
	}

	return [...summaryMap.values()].sort(
		(a, b) => b.knownSubtotalUsd - a.knownSubtotalUsd,
	);
}

function aggregateSourceCosts(
	costs: Array<
		Pick<
			CallCost,
			| "source"
			| "sessionType"
			| "inputTokens"
			| "outputTokens"
			| "cacheReadTokens"
			| "cacheWriteTokens"
			| "totalTokens"
			| "estimatedCostUsd"
			| "dataQuality"
		>
	>,
): SourceCostEntry[] {
	const summaryMap = new Map<string, SourceCostEntry>();
	for (const cost of costs) {
		const key = `${cost.source}::${cost.sessionType}`;
		const existing = summaryMap.get(key);
		if (existing) {
			existing.totalInputTokens += cost.inputTokens;
			existing.totalOutputTokens += cost.outputTokens;
			existing.totalCacheReadTokens += cost.cacheReadTokens;
			existing.totalCacheWriteTokens += cost.cacheWriteTokens;
			existing.totalTokens += cost.totalTokens;
			existing.totalCostUsd = addCost(existing, cost);
			existing.rowCount++;
		} else {
			summaryMap.set(key, {
				source: cost.source,
				sessionType: cost.sessionType,
				totalInputTokens: cost.inputTokens,
				totalOutputTokens: cost.outputTokens,
				totalCacheReadTokens: cost.cacheReadTokens,
				totalCacheWriteTokens: cost.cacheWriteTokens,
				totalTokens: cost.totalTokens,
				...initialCost(cost),
				totalCostUsd: cost.dataQuality === "ok" ? cost.estimatedCostUsd : null,
				rowCount: 1,
			});
		}
	}

	return [...summaryMap.values()].sort(
		(a, b) => b.knownSubtotalUsd - a.knownSubtotalUsd,
	);
}

// =============================================================================
// IMPLEMENTER
// =============================================================================

const tediUsageOs = implement(tediUsageContract).$context<BaseContext>();
const authedOs = tediUsageOs.use(withAuth);

// =============================================================================
// PROCEDURES
// =============================================================================

const getTediUsageProcedure = authedOs.getTediUsage
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { tediId, period, includeRecommendations } = input;

		const tedi = await getTediById(db, tediId);
		if (!tedi) {
			throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
		}

		// If caller has orgId context, verify ownership
		if (
			context.organizationId &&
			tedi.organizationId !== context.organizationId
		) {
			throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
		}

		const now = new Date();
		const daysMap = { live: 1, "24h": 1, "7d": 7, "30d": 30 } as const;
		const days = daysMap[period];
		const from = new Date(
			now.getTime() - days * 24 * 60 * 60 * 1000,
		).toISOString();
		const to = now.toISOString();

		const callCosts = await getCallCosts(db, tediId, {
			from,
			limit: days * 300,
		});
		const callCostTotals = await getCallCostTotals(db, tediId, { from, to });
		const dailyHistory = await getCallCostHistory(db, tediId, { from, to });

		// Enrich tool call metrics from Analytics Engine (sole source of truth
		// for tool-call success/failure — the gateway-log ingestion has no
		// tool-call telemetry, only model calls).
		let aeToolCalls = { totalCalls: 0, failedCalls: 0 };
		if (tedi.descopeUserId && hasAEConfig(context.env)) {
			try {
				aeToolCalls = await getUserToolCallMetrics(
					context.env,
					tedi.descopeUserId,
					from,
					to,
				);
			} catch (err) {
				console.warn("[TediUsage] AE query failed, using zeros:", err);
			}
		}

		const totals = {
			inputTokens: callCostTotals.inputTokens,
			outputTokens: callCostTotals.outputTokens,
			cacheReadTokens: callCostTotals.cacheReadTokens,
			cacheWriteTokens: callCostTotals.cacheWriteTokens,
			totalTokens: callCostTotals.totalTokens,
			estimatedCostUsd: callCostTotals.estimatedCostUsd,
			...costSummary(callCostTotals),
			callCount: callCostTotals.callCount,
			toolCallsTotal: aeToolCalls.totalCalls,
			toolCallsFailed: aeToolCalls.failedCalls,
		};

		const modelBreakdown = aggregateModelCosts(callCosts);
		const sourceBreakdown = aggregateSourceCosts(callCosts);

		const cacheDenominator = totals.cacheReadTokens + totals.inputTokens;
		const cacheHitRate =
			cacheDenominator > 0 ? totals.cacheReadTokens / cacheDenominator : null;
		const toolSuccessRate =
			totals.toolCallsTotal > 0
				? (totals.toolCallsTotal - totals.toolCallsFailed) /
					totals.toolCallsTotal
				: null;

		const recommendations: string[] = [];
		if (includeRecommendations) {
			if (cacheHitRate != null && cacheHitRate < 0.5) {
				recommendations.push(
					`Low cache hit rate (${(cacheHitRate * 100).toFixed(0)}%). Check if session continuity is lost from resets or container restarts.`,
				);
			}

			if (toolSuccessRate != null && toolSuccessRate < 0.9) {
				const failPct = ((1 - toolSuccessRate) * 100).toFixed(0);
				recommendations.push(
					`${failPct}% of tool calls failing. Each failure + retry burns tokens.`,
				);
			}

			// Cost-specific recommendations
			const dailyAvgCost =
				days > 0 && totals.estimatedCostUsd !== null
					? totals.estimatedCostUsd / days
					: null;
			if (dailyAvgCost !== null && dailyAvgCost > 5) {
				recommendations.push(
					`High daily cost ($${dailyAvgCost.toFixed(2)}/day). Consider model routing — use cheaper models for routine tasks.`,
				);
			}

			if (modelBreakdown.length > 1) {
				const topModel = modelBreakdown[0];
				if (
					topModel &&
					topModel.estimatedCostUsd !== null &&
					totals.estimatedCostUsd !== null &&
					topModel.estimatedCostUsd > totals.estimatedCostUsd * 0.8
				) {
					recommendations.push(
						`${topModel.model} accounts for ${((topModel.estimatedCostUsd / Math.max(totals.estimatedCostUsd, 0.01)) * 100).toFixed(0)}% of costs. Consider routing simpler tasks to a lighter model.`,
					);
				}
			}

			if (totals.costCompleteness !== "complete")
				recommendations.push(
					"Cost is incomplete; recorded usage includes unpriced or held calls.",
				);
			if (recommendations.length === 0 && callCosts.length > 0) {
				recommendations.push("No issues detected. Token usage looks healthy.");
			}

			if (callCosts.length === 0) {
				recommendations.push(
					"No call-cost data yet. AI Gateway log ingestion runs every 15 minutes; check back shortly.",
				);
			}
		}

		const dailyAvgUsd =
			days > 0 && totals.estimatedCostUsd !== null
				? totals.estimatedCostUsd / days
				: null;

		return {
			tedi: { id: tedi.id, name: tedi.name, slug: tedi.slug },
			period,
			totals,
			efficiency: {
				cacheHitRate,
				toolCallSuccessRate: toolSuccessRate,
			},
			cost: {
				...costSummary(totals),
				totalUsd: totals.estimatedCostUsd,
				dailyAvgUsd,
				modelBreakdown,
				sourceBreakdown,
			},
			recommendations,
			history: {
				daily: dailyHistory,
			},
		};
	});

// =============================================================================
// CALL COSTS PROCEDURE
// =============================================================================

const getCallCostsProcedure = authedOs.getCallCosts
	.use(AUTHZ.tedisRead)
	.handler(async ({ input, context }) => {
		const { db } = context;
		const { tediId, period, model } = input;

		const tedi = await getTediById(db, tediId);
		if (!tedi) {
			throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
		}

		if (
			context.organizationId &&
			tedi.organizationId !== context.organizationId
		) {
			throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
		}

		const daysMap = { "24h": 1, "7d": 7, "30d": 30 } as const;
		const days = daysMap[period];
		const from = new Date(
			Date.now() - days * 24 * 60 * 60 * 1000,
		).toISOString();

		const costs = await getCallCosts(db, tediId, {
			from,
			model,
			limit: days * 300,
		});
		const normalizedCosts = costs.map((cost) => ({
			id: cost.id,
			// getCallCosts filters on this exact tediId, so it is always resolved
			// here even though the column is nullable for kernel-only rows.
			tediId: cost.tediId as string,
			snapshotAt: cost.snapshotAt,
			model: cost.model,
			provider: cost.provider ?? null,
			providerResource: cost.providerResource ?? null,
			deployment: cost.deployment ?? null,
			runId: cost.runId ?? null,
			workItemId: cost.workItemId ?? null,
			sessionKeyHash: cost.sessionKeyHash ?? null,
			sessionType: cost.sessionType,
			source: cost.source,
			dataQuality: cost.dataQuality,
			inputTokens: cost.inputTokens,
			outputTokens: cost.outputTokens,
			cacheReadTokens: cost.cacheReadTokens,
			cacheWriteTokens: cost.cacheWriteTokens,
			totalTokens: cost.totalTokens,
			estimatedCostUsd: cost.estimatedCostUsd,
			costBasis: cost.costBasis,
			rateVersionId: cost.rateVersionId,
			costReason: cost.costReason,
			executionId: cost.executionId,
			rawReportedCostUsd: cost.rawReportedCostUsd,
			sessionCount: cost.sessionCount,
			createdAt: cost.createdAt ?? null,
		}));

		const summary = aggregateModelCosts(costs).map((row) => ({
			model: row.model,
			provider: row.provider,
			providerResource: row.providerResource,
			deployment: row.deployment,
			totalInputTokens: row.inputTokens,
			totalOutputTokens: row.outputTokens,
			totalCacheReadTokens: row.cacheReadTokens,
			totalCacheWriteTokens: row.cacheWriteTokens,
			totalTokens: row.totalTokens,
			totalCostUsd: row.estimatedCostUsd,
			snapshotCount: row.rowCount,
			...costSummary(row),
		}));

		const sourceSummary = aggregateSourceCosts(normalizedCosts);

		return {
			tediId,
			period,
			costs: normalizedCosts,
			summary,
			sourceSummary,
		};
	});

// =============================================================================
// CONTRACT ROUTER
// =============================================================================

export const tediUsageContractRouter = tediUsageOs.router({
	getTediUsage: getTediUsageProcedure,
	getCallCosts: getCallCostsProcedure,
});
