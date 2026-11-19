/** Sample MCP payment events and policies, and per-call costs. */

import {
	fid,
	ORG_ID,
	RUN_CHURN_FAILED,
	RUN_REVENUE_LIVE,
	RUN_REVENUE_OK,
	T1,
	T2,
	T3,
	T4,
	TEDI_JUNO,
	TEDI_MILES,
	TEDI_NOVA,
} from "./core";

// --- MCP payment ledger fixtures (/admin/payments) ---

export const MCP_PAYMENT_RECEIPT = fid("76", 1);

const mcpPaymentEvent = (
	n: number,
	overrides: {
		requirementId: string;
		eventType: "payment_required" | "payment_settled" | "payment_rejected";
		status: "required" | "settled" | "rejected";
		amount: string;
		settled: boolean;
		createdAt: string;
		budgetDecision?: Record<string, string | boolean>;
	},
) => ({
	id: n === 1 ? MCP_PAYMENT_RECEIPT : fid("76", n),
	requirementId: overrides.requirementId,
	eventType: overrides.eventType,
	status: overrides.status,
	protocol: "x402",
	mode: "mock",
	network: "base-sepolia",
	asset: "usdc",
	currency: "USDC",
	amount: overrides.amount,
	recipient: "0x1111111111111111111111111111111111111111",
	resource: null,
	appId: null,
	appSlug: "storefront",
	organizationId: ORG_ID,
	toolRowId: null,
	toolId: "generate_market_report",
	tediId: TEDI_MILES,
	userId: null,
	clientId: null,
	authType: "tedi",
	traceId: null,
	toolArgsHash: null,
	settled: overrides.settled,
	requirements: null,
	paymentProof: null,
	paymentResponse: overrides.settled ? { settlementId: "mock-1" } : null,
	budgetPolicy: overrides.budgetDecision ? { scope: "org" } : null,
	budgetDecision: overrides.budgetDecision ?? null,
	decisionRationale: null,
	auditEventId: null,
	rationaleRecordId: null,
	createdAt: overrides.createdAt,
});

export const MCP_PAYMENT_EVENTS = [
	mcpPaymentEvent(1, {
		requirementId: "req-local-1",
		eventType: "payment_settled",
		status: "settled",
		amount: "0.25",
		settled: true,
		createdAt: T3,
		budgetDecision: {
			allowed: true,
			projected: "0.25",
			maxAmount: "5",
			currency: "USDC",
			scope: "org",
			mode: "enforce",
		},
	}),
	mcpPaymentEvent(2, {
		requirementId: "req-local-2",
		eventType: "payment_required",
		status: "required",
		amount: "0.25",
		settled: false,
		createdAt: T4,
	}),
];

export const MCP_PAYMENT_POLICIES = [
	{
		id: fid("77", 1),
		organizationId: ORG_ID,
		tediId: null,
		appSlug: null,
		toolId: null,
		currency: "USDC",
		network: "base-sepolia",
		enabled: true,
		maxAmount: "5",
		maxTransactionAmount: null,
		allowedRecipients: null,
		allowedTools: null,
		windowSeconds: 86_400,
		mode: "enforce" as const,
		createdBy: null,
		updatedBy: null,
		createdAt: T1,
		updatedAt: T1,
	},
];

const callCostRow = (
	n: number,
	tediId: string,
	runId: string | null,
	model: string,
	costUsd: number,
	snapshotAt: string,
	// Literal, not the contract enum: this module is loaded by vite.config.ts
	// under raw Node, where package subpaths do not resolve. The ingestion job
	// writes exactly these three values (`tedi_call_costs.data_quality`).
	dataQuality: "ok" | "quarantined_no_pricing" | "quarantined_failed" = "ok",
) => ({
	providerCostEvidence: null,
	sourceRetired: false,
	costBasis:
		dataQuality === "quarantined_no_pricing"
			? ("unknown" as const)
			: ("legacy_estimate" as const),
	rateVersionId: null,
	costReason: null,
	executionId: null,
	rawReportedCostUsd: null,
	id: fid("75", n),
	tediId,
	snapshotAt,
	model,
	provider: "anthropic",
	providerResource: null,
	deployment: null,
	runId,
	workItemId: null,
	sessionKeyHash: null,
	sessionType: "tedi" as const,
	source: "ai-gateway",
	inputTokens: 12_400,
	outputTokens: 1_900,
	cacheReadTokens: 8_000,
	cacheWriteTokens: 0,
	totalTokens: 22_300,
	estimatedCostUsd: dataQuality === "quarantined_no_pricing" ? null : costUsd,
	dataQuality,
	sessionCount: 1,
	createdAt: snapshotAt,
});

export const CALL_COSTS = [
	callCostRow(1, TEDI_MILES, RUN_REVENUE_OK, "claude-sonnet-4-5", 0.084, T2),
	callCostRow(2, TEDI_MILES, RUN_CHURN_FAILED, "claude-sonnet-4-5", 0.031, T3),
	callCostRow(3, TEDI_MILES, RUN_REVENUE_LIVE, "claude-sonnet-4-5", 0.012, T4),
	callCostRow(4, TEDI_JUNO, null, "claude-haiku-4-5", 0.006, T4),
	callCostRow(5, TEDI_NOVA, null, "claude-sonnet-4-5", 0.02, T4),
	// A quarantined row so the dev lane exercises the state a spend total must
	// never absorb: zero stored cost with real tokens, held out by ingestion.
	callCostRow(
		6,
		TEDI_NOVA,
		null,
		"claude-sonnet-4-5",
		0,
		T4,
		"quarantined_no_pricing",
	),
];

// --- Tedix credits (/admin/billing, /compute) ---
// Literals, not contract imports: vite.config.ts loads fixtures under raw Node.

const creditNow = new Date();
export const CREDIT_PERIOD_START = new Date(
	Date.UTC(creditNow.getUTCFullYear(), creditNow.getUTCMonth(), 1),
).toISOString();
export const CREDIT_PERIOD_END = new Date(
	Date.UTC(creditNow.getUTCFullYear(), creditNow.getUTCMonth() + 1, 1),
).toISOString();

/** Monthly plans; 1 credit = €0.01 = 10,000 EUR micros. */
export const CREDIT_PLANS = [
	{
		key: "starter" as const,
		name: "Starter",
		priceMicros: 0,
		currency: "eur" as const,
		includedCredits: 500,
	},
	{
		key: "growth" as const,
		name: "Growth",
		priceMicros: 200_000_000,
		currency: "eur" as const,
		includedCredits: 15_000,
	},
	{
		key: "business" as const,
		name: "Business",
		priceMicros: 500_000_000,
		currency: "eur" as const,
		includedCredits: 40_000,
	},
	{
		key: "enterprise" as const,
		name: "Enterprise",
		priceMicros: 1_000_000_000,
		currency: "eur" as const,
		includedCredits: 100_000,
	},
];

const topUpPack = (credits: number) => ({
	packKey: `credits-${credits}`,
	credits,
	priceMicros: credits * 10_000,
	currency: "eur" as const,
	validMonths: 12 as const,
});

/** One-time packs; unused credits last 12 months. */
export const CREDIT_TOP_UP_PACKS = [1_000, 5_000, 10_000, 25_000, 50_000].map(
	topUpPack,
);

type CreditCap = number | null;

/**
 * A Growth organization past its 80% notice: 12,600 of 15,000 included
 * credits used, with 5,000 top-up credits still unused. Outside Billing ›
 * Usage that reads "63% used this month" (12,600 of 20,000). Mutable so the
 * cap and pay-as-you-go forms round-trip in the dev lane.
 */
export const creditUsage = {
	periodStart: CREDIT_PERIOD_START,
	periodEnd: CREDIT_PERIOD_END,
	includedCredits: 15_000,
	usedCredits: 12_600,
	remainingIncludedCredits: 2_400,
	topUpCredits: 5_000,
	breakdown: { ai: 10_900, codeRuns: 1_200, services: 500 },
	notices: [
		{
			threshold: 80 as 80 | 100,
			reachedAt: new Date(
				Date.parse(CREDIT_PERIOD_START) + 18 * 86_400_000,
			).toISOString(),
		},
	],
	payAsYouGo: {
		enabled: false,
		monthlyCapMicros: null as CreditCap,
		spentMicros: 0,
	},
	tedis: [
		{
			tediId: TEDI_NOVA,
			name: "Nova",
			usedCredits: 6_200,
			monthlyCapCredits: 8_000 as CreditCap,
		},
		{
			tediId: TEDI_MILES,
			name: "Miles",
			usedCredits: 4_900,
			monthlyCapCredits: null as CreditCap,
		},
		{
			tediId: TEDI_JUNO,
			name: "Juno",
			usedCredits: 1_500,
			monthlyCapCredits: 2_000 as CreditCap,
		},
	],
	members: [
		{
			userId: "dev-operator",
			name: "Local Operator",
			usedCredits: 3_400,
			monthlyCapCredits: null as CreditCap,
		},
		{
			userId: "dev-teammate",
			name: "Sam Rivera",
			usedCredits: 1_100,
			monthlyCapCredits: 1_500 as CreditCap,
		},
	],
};
