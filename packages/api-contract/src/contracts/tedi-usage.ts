import { ProviderCostEvidenceProjectionSchema } from "../schemas/provider-cost-evidence";
import {
	ReviewedProviderCostSummarySchema,
	PersistedCostBasisSchema,
} from "../schemas/cost-provenance";
import "@orpc/openapi/extensions/route";
/**
 * Tedi Usage Contract
 * oRPC contract for token usage metrics, efficiency analysis, and optimization recommendations.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import { TediIdParamSchema } from "../schemas/tedi";

const TokenTotalsSchema = z.object({
	...ReviewedProviderCostSummarySchema.shape,
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadTokens: z.number(),
	cacheWriteTokens: z.number(),
	totalTokens: z.number(),
	estimatedCostUsd: z
		.number()
		.nullable()
		.describe(
			"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
		),
	/** Number of AI Gateway log rows (calls) in the window. */
	callCount: z.number(),
	toolCallsTotal: z.number(),
	toolCallsFailed: z.number(),
});

const SourceBreakdownEntrySchema = z.object({
	...ReviewedProviderCostSummarySchema.shape,
	source: z.string(),
	sessionType: z.string(),
	totalInputTokens: z.number(),
	totalOutputTokens: z.number(),
	totalCacheReadTokens: z.number(),
	totalCacheWriteTokens: z.number(),
	totalTokens: z.number(),
	totalCostUsd: z
		.number()
		.nullable()
		.describe(
			"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
		),
	rowCount: z.number(),
});

const ModelBreakdownEntrySchema = z.object({
	...ReviewedProviderCostSummarySchema.shape,
	model: z.string(),
	provider: z.string().nullable(),
	providerResource: z.string().nullable(),
	deployment: z.string().nullable(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadTokens: z.number(),
	cacheWriteTokens: z.number(),
	totalTokens: z.number(),
	estimatedCostUsd: z
		.number()
		.nullable()
		.describe(
			"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
		),
	sessionCount: z.number(),
});

const EfficiencySchema = z.object({
	cacheHitRate: z.number().nullable(),
	toolCallSuccessRate: z.number().nullable(),
});

/** Daily-bucketed token/cost history, aggregated directly from `tedi_call_costs`. */
const CallCostHistoryBucketSchema = z.object({
	...ReviewedProviderCostSummarySchema.shape,
	date: z.string(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	totalTokens: z.number(),
	estimatedCostUsd: z
		.number()
		.nullable()
		.describe(
			"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
		),
	callCount: z.number(),
});

const CallCostEntrySchema = z.object({
	providerCostEvidence: ProviderCostEvidenceProjectionSchema.nullable(),
	sourceRetired: z.boolean(),
	id: z.string(),
	tediId: z.string(),
	snapshotAt: z.string(),
	model: z.string(),
	provider: z.string().nullable(),
	providerResource: z.string().nullable(),
	deployment: z.string().nullable(),
	runId: z.string().nullable(),
	workItemId: z.string().nullable(),
	sessionKeyHash: z.string().nullable(),
	sessionType: z.enum(["tedi", "tedi_observer", "kernel", "unattributed"]),
	source: z.string(),
	inputTokens: z.number(),
	outputTokens: z.number(),
	cacheReadTokens: z.number(),
	cacheWriteTokens: z.number(),
	totalTokens: z.number(),
	estimatedCostUsd: z
		.number()
		.nullable()
		.describe(
			"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
		),
	costBasis: PersistedCostBasisSchema,
	rateVersionId: z
		.string()
		.nullable()
		.describe(
			"Null for provider-reported, historical, unknown, or multiple-rate evidence.",
		),
	costReason: z
		.string()
		.nullable()
		.describe("Null when no missing-cost reason was recorded."),
	executionId: z
		.string()
		.nullable()
		.describe(
			"Null when historical evidence has no immutable execution receipt or the aggregate spans multiple executions.",
		),
	rawReportedCostUsd: z
		.number()
		.nullable()
		.describe(
			"Original gateway amount; null when the provider did not report an amount.",
		),
	dataQuality: z.enum(["ok", "quarantined_no_pricing", "quarantined_failed"]),
	sessionCount: z.number(),
	createdAt: z.string().nullable(),
});

const CallCostsOutputSchema = z.object({
	tediId: z.string(),
	period: z.enum(["24h", "7d", "30d"]),
	costs: z.array(CallCostEntrySchema),
	summary: z.array(
		z.object({
			...ReviewedProviderCostSummarySchema.shape,
			model: z.string(),
			provider: z.string().nullable(),
			providerResource: z.string().nullable(),
			deployment: z.string().nullable(),
			totalInputTokens: z.number(),
			totalOutputTokens: z.number(),
			totalCacheReadTokens: z.number(),
			totalCacheWriteTokens: z.number(),
			totalTokens: z.number(),
			totalCostUsd: z
				.number()
				.nullable()
				.describe(
					"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
				),
			snapshotCount: z.number(),
		}),
	),
	sourceSummary: z.array(SourceBreakdownEntrySchema),
});

const TediUsageOutputSchema = z.object({
	tedi: z.object({
		id: z.string(),
		name: z.string(),
		slug: z.string(),
	}),
	period: z.enum(["live", "24h", "7d", "30d"]),
	totals: TokenTotalsSchema,
	efficiency: EfficiencySchema,
	cost: z.object({
		...ReviewedProviderCostSummarySchema.shape,
		totalUsd: z
			.number()
			.nullable()
			.describe(
				"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
			),
		dailyAvgUsd: z
			.number()
			.nullable()
			.describe(
				"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
			),
		modelBreakdown: z.array(ModelBreakdownEntrySchema),
		sourceBreakdown: z.array(SourceBreakdownEntrySchema),
	}),
	recommendations: z.array(z.string()),
	history: z.object({
		daily: z.array(CallCostHistoryBucketSchema),
	}),
});

export const tediUsageContract = oc
	.route({ tags: ["tedi-usage"], prefix: "/tedis" })
	.errors(baseErrors)
	.router({
		/**
		 * Get token usage metrics and efficiency analysis for a tedi
		 * GET /tedis/{tediId}/usage
		 */
		getTediUsage: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{tediId}/usage",
				summary: "Get tedi token usage and efficiency analysis",
				description:
					"Returns token usage totals, efficiency metrics, optimization recommendations, and daily cost history for a tedi over a configurable time period, ingested directly from AI Gateway logs.",
			})
			.input(
				TediIdParamSchema.extend({
					period: z.enum(["live", "24h", "7d", "30d"]).default("7d"),
					includeRecommendations: z.boolean().default(true),
				}),
			)
			.output(TediUsageOutputSchema),

		/**
		 * Get per-model call cost attribution for a tedi
		 * GET /tedis/{tediId}/call-costs
		 */
		getCallCosts: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{tediId}/call-costs",
				summary: "Get per-model call cost attribution",
				description:
					"Returns direct per-call cost rows ingested from AI Gateway logs (one row per gateway log row), with a per-model summary for billing attribution.",
			})
			.input(
				TediIdParamSchema.extend({
					period: z.enum(["24h", "7d", "30d"]).default("7d"),
					model: z.string().optional(),
				}),
			)
			.output(CallCostsOutputSchema),
	});

export type TediUsageContract = typeof tediUsageContract;
export type TediUsageOutput = z.infer<typeof TediUsageOutputSchema>;
export type CallCostsOutput = z.infer<typeof CallCostsOutputSchema>;
