import { ProviderCostEvidenceProjectionSchema } from "../schemas/provider-cost-evidence";
import {
	ReviewedProviderCostSummarySchema,
	PersistedCostBasisSchema,
} from "../schemas/cost-provenance";
import "@orpc/openapi/extensions/route";
/**
 * Organization Usage Contract
 * Org-level token usage aggregation across all tedis, aligned with plan limits.
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";

const OrgUsagePeriodSchema = z.enum(["24h", "7d", "30d"]);
const OrgUsageWindowSchema = z
	.object({ from: z.string().datetime(), to: z.string().datetime() })
	.refine((value) => Date.parse(value.to) > Date.parse(value.from), {
		message: "to must be after from",
		path: ["to"],
	});

const OrgUsageTediBreakdownSchema = z.object({
	...ReviewedProviderCostSummarySchema.shape,
	tediId: z.string(),
	tediName: z.string(),
	tediSlug: z.string(),
	totalTokens: z.number(),
	estimatedCostUsd: z
		.number()
		.nullable()
		.describe(
			"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
		),
	cacheHitRate: z.number().nullable(),
});

const OrgUsageDailySchema = z.object({
	...ReviewedProviderCostSummarySchema.shape,
	date: z.string(),
	totalTokens: z.number(),
	estimatedCostUsd: z
		.number()
		.nullable()
		.describe(
			"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
		),
	inputTokens: z.number(),
	outputTokens: z.number(),
});

const OrgModelBreakdownSchema = z.object({
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
});

const OrgSourceBreakdownSchema = z.object({
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

const CostAggregateSchema = z.object({
	...ReviewedProviderCostSummarySchema.shape,
	key: z.string(),
	label: z.string(),
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
	billableTokens: z.number(),
	billableCostUsd: z.number(),
	invoiceReadyTokens: z.number(),
	invoiceReadyCostUsd: z.number(),
	quarantinedTokens: z.number(),
	quarantinedCostUsd: z.number(),
	rowCount: z.number(),
});

const CostDrilldownTotalsSchema = z.object({
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
	billableTokens: z.number(),
	billableCostUsd: z.number(),
	invoiceReadyTokens: z.number(),
	invoiceReadyCostUsd: z.number(),
	quarantinedTokens: z.number(),
	quarantinedCostUsd: z.number(),
	nonBillableCostUsd: z.number(),
	unattributedCostUsd: z.number(),
});

const CostDrilldownBillingSchema = z.object({
	pricingVersion: z.string(),
	attributionVersion: z.string(),
	dailyRunRateUsd: z
		.number()
		.nullable()
		.describe(
			"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
		),
	projectedMonthlyCostUsd: z
		.number()
		.nullable()
		.describe(
			"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
		),
	invoiceReady: z.boolean(),
	invoiceReadyTokenShare: z.number().nullable(),
	quarantinedTokenShare: z.number().nullable(),
	quarantinedCostShare: z.number().nullable(),
	unattributedShare: z.number().nullable(),
});

const BillingDataQualityIssueCodeSchema = z.enum([
	"unknown_model",
	"unpriced_tokens",
	"ingestion_quarantined",
	// An empty ledger is NOT a clean one: zero rows is indistinguishable from a
	// fully failed ingestion, so it is reported as an explicit issue rather than
	// scored as healthy. See usage-ledger.ts buildDataQuality.
	"empty_ledger",
]);

const BillingDataQualityIssueSchema = z.object({
	code: BillingDataQualityIssueCodeSchema,
	severity: z.enum(["warning", "critical"]),
	message: z.string(),
	rowCount: z.number(),
	totalTokens: z.number(),
	totalCostUsd: z
		.number()
		.nullable()
		.describe(
			"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
		),
	tokenShare: z.number().nullable(),
	costShare: z.number().nullable(),
});

const BillingDataQualitySchema = z.object({
	level: z.enum(["ok", "warning", "critical"]),
	score: z.number(),
	rowCount: z.number(),
	issueRowCount: z.number(),
	totalTokens: z.number(),
	issueTokens: z.number(),
	totalCostUsd: z
		.number()
		.nullable()
		.describe(
			"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
		),
	issueCostUsd: z.number(),
	issueTokenShare: z.number().nullable(),
	issueCostShare: z.number().nullable(),
	pricedTokenShare: z.number().nullable(),
	unknownModelTokenShare: z.number().nullable(),
	zeroCostTokenShare: z.number().nullable(),
	issues: z.array(BillingDataQualityIssueSchema),
	byTedi: z.array(
		z.object({
			tediId: z.string(),
			tediName: z.string(),
			tediSlug: z.string(),
			rowCount: z.number(),
			totalTokens: z.number(),
			totalCostUsd: z
				.number()
				.nullable()
				.describe(
					"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
				),
			issueRowCount: z.number(),
			issueTokens: z.number(),
			issueCostUsd: z.number(),
			issueTokenShare: z.number().nullable(),
			issueCostShare: z.number().nullable(),
		}),
	),
	recentProblemRows: z.array(
		z.object({
			id: z.string(),
			tediId: z.string(),
			tediName: z.string(),
			tediSlug: z.string(),
			snapshotAt: z.string(),
			model: z.string(),
			source: z.string(),
			sessionType: z.string(),
			totalTokens: z.number(),
			estimatedCostUsd: z
				.number()
				.nullable()
				.describe(
					"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
				),
			flags: z.array(BillingDataQualityIssueCodeSchema),
		}),
	),
	recommendations: z.array(z.string()),
});

const CostDrilldownRowSchema = z.object({
	providerCostEvidence: ProviderCostEvidenceProjectionSchema.nullable(),
	sourceRetired: z.boolean(),
	id: z.string(),
	tediId: z.string(),
	tediName: z.string(),
	tediSlug: z.string(),
	snapshotAt: z.string(),
	model: z.string(),
	provider: z.string().nullable(),
	providerResource: z.string().nullable(),
	providerBaseUrl: z.string().nullable(),
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
	callDurationMs: z
		.number()
		.nonnegative()
		.nullable()
		.describe(
			"Elapsed milliseconds for an admitted provider call; null when unavailable.",
		),
	executionId: z
		.string()
		.nullable()
		.describe(
			"Null for historical and gateway-ingested rows without an admitted execution ID.",
		),
	estimatedCostUsd: z
		.number()
		.nullable()
		.describe(
			"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
		),
	rawEstimatedCostUsd: z
		.number()
		.nullable()
		.describe(
			"Original persisted amount; null when no amount was recorded, independent of quarantine.",
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
	dataQuality: z.enum(["ok", "quarantined_no_pricing", "quarantined_failed"]),
	sessionCount: z.number(),
	createdAt: z.string().nullable(),
	billingCategory: z.string(),
	billable: z.boolean(),
	billableTokens: z.number(),
	billableCostUsd: z.number(),
	invoiceReady: z.boolean(),
	invoiceReadyTokens: z.number(),
	invoiceReadyCostUsd: z.number(),
	reconciliationStatus: z.enum(["ready", "quarantined"]),
	reconciliationReasons: z.array(BillingDataQualityIssueCodeSchema),
	quarantinedTokens: z.number(),
	quarantinedCostUsd: z.number(),
	pricingVersion: z.string(),
	attributionVersion: z.string(),
});

const CostDrilldownOutputSchema = z.object({
	organization: z.object({
		id: z.string(),
		name: z.string(),
		tier: z.string(),
		status: z.string(),
	}),
	period: OrgUsagePeriodSchema,
	window: z.object({
		from: z.string(),
		to: z.string(),
	}),
	totals: CostDrilldownTotalsSchema,
	billing: CostDrilldownBillingSchema,
	dataQuality: BillingDataQualitySchema,
	byTedi: z.array(
		CostAggregateSchema.extend({
			tediId: z.string(),
			tediName: z.string(),
			tediSlug: z.string(),
		}),
	),
	bySource: z.array(
		CostAggregateSchema.extend({
			source: z.string(),
			sessionType: z.string(),
		}),
	),
	byCategory: z.array(
		CostAggregateSchema.extend({
			billingCategory: z.string(),
		}),
	),
	byModel: z.array(
		CostAggregateSchema.extend({
			model: z.string(),
			provider: z.string().nullable(),
			providerResource: z.string().nullable(),
			deployment: z.string().nullable(),
		}),
	),
	byResource: z.array(
		CostAggregateSchema.extend({
			provider: z.string().nullable(),
			providerResource: z.string().nullable(),
			providerBaseUrl: z.string().nullable(),
			deployment: z.string().nullable(),
		}),
	),
	daily: z.array(
		CostAggregateSchema.extend({
			date: z.string(),
		}),
	),
});

const BillingLedgerOutputSchema = z.object({
	organization: z.object({
		id: z.string(),
		name: z.string(),
		tier: z.string(),
		status: z.string(),
	}),
	period: OrgUsagePeriodSchema,
	window: z.object({
		from: z.string(),
		to: z.string(),
	}),
	totals: CostDrilldownTotalsSchema,
	billing: CostDrilldownBillingSchema,
	dataQuality: BillingDataQualitySchema,
	pagination: z.object({
		limit: z.number().int().positive(),
		returnedRows: z.number().int().nonnegative(),
		totalRows: z.number().int().nonnegative(),
		hasMore: z.boolean(),
	}),
	rows: z.array(CostDrilldownRowSchema),
});

const OrgUsageOutputSchema = z.object({
	organization: z.object({
		id: z.string(),
		name: z.string(),
		tier: z.string(),
		status: z.string(),
	}),
	period: OrgUsagePeriodSchema,
	window: OrgUsageWindowSchema,
	totals: z.object({
		...ReviewedProviderCostSummarySchema.shape,
		totalTokens: z.number(),
		inputTokens: z.number(),
		outputTokens: z.number(),
		cacheReadTokens: z.number(),
		cacheWriteTokens: z.number(),
		estimatedCostUsd: z
			.number()
			.nullable()
			.describe(
				"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
			),
		activeTedis: z.number(),
	}),
	planLimits: z.object({
		maxTokensPerMonth: z.number(),
		currentMonthTokens: z.number(),
		usagePct: z.number().nullable(),
		maxTedis: z.number(),
		currentTedis: z.number(),
	}),
	daily: z.array(OrgUsageDailySchema),
	tediBreakdown: z.array(OrgUsageTediBreakdownSchema),
	modelBreakdown: z.array(OrgModelBreakdownSchema),
	sourceBreakdown: z.array(OrgSourceBreakdownSchema),
});

export const orgUsageContract = oc
	.route({ tags: ["org-usage"], prefix: "/organizations" })
	.errors(baseErrors)
	.router({
		getOrgUsage: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{organizationId}/usage",
				summary: "Get organization-level token usage and cost aggregation",
				description:
					"Aggregates token usage across all tedis in the org. Shows totals, per-tedi breakdown, daily chart data, and plan limit comparison.",
			})
			.input(
				z.object({
					organizationId: z.string(),
					period: OrgUsagePeriodSchema.default("30d"),
					window: OrgUsageWindowSchema.optional().describe(
						"Exact billing window for OS charts; omitted by legacy callers that intentionally request a rolling period",
					),
				}),
			)
			.output(OrgUsageOutputSchema),

		/**
		 * Get billing-grade cost attribution drilldown for an org
		 * GET /organizations/{organizationId}/cost-drilldown
		 */
		getCostDrilldown: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{organizationId}/cost-drilldown",
				summary: "Get organization cost drilldown",
				description:
					"Returns billing-grade model cost attribution across tedis, sources, billing categories, sessions, provider resources, models, and days.",
			})
			.input(
				z.object({
					organizationId: z.string(),
					period: OrgUsagePeriodSchema.default("7d"),
					tediId: z.string().optional(),
					source: z.string().optional(),
					model: z.string().optional(),
					includeUnattributed: z.boolean().default(true),
					sessionLimit: z.number().int().min(1).max(500).default(50),
				}),
			)
			.output(CostDrilldownOutputSchema),

		/**
		 * List normalized billing ledger rows for an org
		 * GET /organizations/{organizationId}/billing-ledger
		 */
		getBillingLedger: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{organizationId}/billing-ledger",
				summary: "Get organization billing ledger",
				description:
					"Lists the newest normalized D1 tedi_call_costs rows while computing totals and data-quality aggregates across the complete filtered window.",
			})
			.input(
				z.object({
					organizationId: z.string(),
					period: OrgUsagePeriodSchema.default("7d"),
					tediId: z.string().optional(),
					source: z.string().optional(),
					model: z.string().optional(),
					includeUnattributed: z.boolean().default(true),
					limit: z.number().int().min(1).max(1000).default(200),
				}),
			)
			.output(BillingLedgerOutputSchema),
	});

export type OrgUsageContract = typeof orgUsageContract;
export type OrgUsageOutput = z.infer<typeof OrgUsageOutputSchema>;
export type CostDrilldownOutput = z.infer<typeof CostDrilldownOutputSchema>;
export type BillingLedgerOutput = z.infer<typeof BillingLedgerOutputSchema>;
