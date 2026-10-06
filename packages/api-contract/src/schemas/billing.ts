/**
 * Billing Zod Schemas
 * Validation schemas for Stripe checkout, portal, and billing status
 */

import * as z from "zod";
import { JsonValueSchema } from "./common";
import { CutoverInspectionHopSchema, type CutoverInspectionHop } from "./tedi";

// =============================================================================
// BILLING SCHEMAS
// =============================================================================

export const ProviderCapacityPolicySchema = z.object({
	enabled: z.boolean(),
	budgetRevision: z.number().int().positive().max(1_000_000),
	maxTransfersPerBudgetDay: z.number().int().positive().max(100),
	lowWatermarkTokens: z.number().int().nonnegative().max(1_000_000_000),
	lowWatermarkSpendMicros: z
		.number()
		.int()
		.nonnegative()
		.max(1_000_000_000_000),
	transferTokens: z.number().int().nonnegative().max(1_000_000_000),
	transferSpendMicros: z.number().int().nonnegative().max(1_000_000_000_000),
});

export const BillingIntervalSchema = z.enum(["month", "year"]);
export type BillingInterval = z.infer<typeof BillingIntervalSchema>;

export const StripeEnvironmentSchema = z.enum(["test", "live"]);
export type StripeEnvironment = z.infer<typeof StripeEnvironmentSchema>;

export const BillingPlanKeySchema = z.enum([
	"starter",
	"growth",
	"business",
	"enterprise",
]);
export type BillingPlanKey = z.infer<typeof BillingPlanKeySchema>;

export const CheckoutInputSchema = z.object({
	tier: z.enum(["growth", "business", "enterprise"]),
	interval: BillingIntervalSchema.default("month"),
	successUrl: z
		.string()
		.url()
		.optional()
		.describe(
			"Optional caller return URL; defaults to the canonical OS billing settings success state.",
		),
	cancelUrl: z
		.string()
		.url()
		.optional()
		.describe(
			"Optional caller return URL; defaults to the canonical OS billing settings cancellation state.",
		),
});
export type CheckoutInput = z.infer<typeof CheckoutInputSchema>;

export const CheckoutResponseSchema = z.object({
	checkoutUrl: z.string().url(),
	sessionId: z.string(),
	stripeEnvironment: StripeEnvironmentSchema,
});
export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;

export const InferenceCapacityPackSchema = z.object({
	packKey: z.string().min(1).max(100),
	name: z.string().min(1).max(200),
	tokens: z.number().int().positive(),
	spendCapacityMicros: z.number().int().positive(),
	priceMicros: z.number().int().nonnegative(),
	currency: z.string().min(3).max(3),
});
export type InferenceCapacityPack = z.infer<typeof InferenceCapacityPackSchema>;

export const CreateInferenceCapacityCheckoutInputSchema = z.object({
	packKey: z.string().min(1).max(100),
	successUrl: z
		.string()
		.url()
		.optional()
		.describe(
			"Optional caller return URL; defaults to the canonical OS billing settings success state.",
		),
	cancelUrl: z
		.string()
		.url()
		.optional()
		.describe(
			"Optional caller return URL; defaults to the canonical OS billing settings cancellation state.",
		),
});
export type CreateInferenceCapacityCheckoutInput = z.infer<
	typeof CreateInferenceCapacityCheckoutInputSchema
>;

export const PortalResponseSchema = z.object({
	portalUrl: z.string().url(),
	stripeEnvironment: StripeEnvironmentSchema,
});
export type PortalResponse = z.infer<typeof PortalResponseSchema>;

export const BillingPlanCatalogItemSchema = z.object({
	planKey: z.enum(["growth", "business", "enterprise"]),
	version: z.number().int().positive(),
	name: z.string(),
	currency: z.string(),
	monthlyPriceMicros: z.number().int().nonnegative(),
	annualPriceMicros: z.number().int().nonnegative(),
	includedMonthlyTokens: z.number().int(),
	overageUnitTokens: z.number().int().positive(),
	overageUnitPriceMicros: z.number().int().nonnegative(),
	maxTedis: z.number().int(),
	maxCronJobsPerTedi: z.number().int(),
	maxIterationsPerTask: z.number().int(),
});
export type BillingPlanCatalogItem = z.infer<
	typeof BillingPlanCatalogItemSchema
>;

export const BillingPlanCatalogSchema = z.object({
	stripeEnvironment: StripeEnvironmentSchema,
	plans: z.array(BillingPlanCatalogItemSchema),
});
export type BillingPlanCatalog = z.infer<typeof BillingPlanCatalogSchema>;

const BillingBalanceSnapshotSchema = z.object({
	status: z.enum(["trial", "active", "past_due", "cancelled", "suspended"]),
	billingMode: z.enum(["trial", "stripe", "invoice", "internal"]),
	planKey: BillingPlanKeySchema,
	planVersion: z.number().int(),
	periodStart: z.string(),
	periodEnd: z.string(),
	includedTokens: z.number().int(),
	usedTokens: z.number().int(),
	reservedTokens: z.number().int(),
	remainingIncludedTokens: z.number().int(),
	creditBalanceMicros: z.number().int(),
	reservedChargeMicros: z.number().int(),
	availableCreditMicros: z.number().int(),
	customerChargeMicros: z.number().int(),
	hardSpendLimitMicros: z.number().int().nullable(),
	allowOverage: z.boolean(),
	stripeCustomerId: z.string().nullable(),
});

export const RecordVoiceProviderUsageInputSchema = z
	.object({
		organizationId: z.string().min(1),
		tediId: z.string().min(1).nullable().optional(),
		providerUsageId: z.string().min(8).max(300),
		gatewayLogId: z.string().min(1).max(300).nullable().optional(),
		provider: z.string().min(1).max(100),
		model: z.string().min(1).max(200),
		usageKind: z.enum(["voice_stt", "voice_tts"]),
		unit: z.enum(["seconds", "characters"]),
		quantity: z.number().int().positive().max(10_000_000),
		occurredAt: z.string().datetime(),
		metadata: z.record(z.string(), JsonValueSchema).optional(),
	})
	.refine(
		(value) =>
			(value.usageKind === "voice_stt" && value.unit === "seconds") ||
			(value.usageKind === "voice_tts" && value.unit === "characters"),
		{
			message: "voice_stt uses seconds and voice_tts uses characters",
			path: ["unit"],
		},
	);
export type RecordVoiceProviderUsageInput = z.infer<
	typeof RecordVoiceProviderUsageInputSchema
>;

export const RecordVoiceProviderUsageResponseSchema = z.object({
	usageId: z.string(),
	providerCostMicros: z.number().int().nonnegative(),
	providerCostQuality: z.literal("estimated"),
	rateCardVersion: z.string().nullable(),
});
export type RecordVoiceProviderUsageResponse = z.infer<
	typeof RecordVoiceProviderUsageResponseSchema
>;

export const GrantBillingCreditInputSchema = z.object({
	organizationId: z.string().min(1),
	amountMicros: z.number().int().positive().max(1_000_000_000_000),
	idempotencyKey: z.string().min(8).max(300),
	sourceRef: z.string().max(300).nullable().optional(),
	expiresAt: z.string().datetime().nullable().optional(),
	description: z.string().max(500).nullable().optional(),
});
export type GrantBillingCreditInput = z.infer<
	typeof GrantBillingCreditInputSchema
>;

export const GrantBillingCreditResponseSchema = z.object({
	entryId: z.string(),
	creditBalanceMicros: z.number().int(),
});
export type GrantBillingCreditResponse = z.infer<
	typeof GrantBillingCreditResponseSchema
>;

export const ProviderReconciliationInputSchema = z
	.object({
		provider: z.string().min(1).max(100),
		providerResource: z.string().max(300).default(""),
		periodStart: z.string().datetime(),
		periodEnd: z.string().datetime(),
		providerCostMicros: z.number().int().nonnegative(),
		evidenceRef: z.string().min(1).max(1_000),
		approved: z.boolean().default(false),
		metadata: z.record(z.string(), JsonValueSchema).optional(),
	})
	.refine(
		(value) => Date.parse(value.periodEnd) > Date.parse(value.periodStart),
		{
			message: "periodEnd must be after periodStart",
			path: ["periodEnd"],
		},
	);
export type ProviderReconciliationInput = z.infer<
	typeof ProviderReconciliationInputSchema
>;

export const ProviderReconciliationResponseSchema = z.object({
	id: z.string(),
	status: z.enum(["pending", "matched", "variance", "approved"]),
	ledgerCostMicros: z.number().int(),
	providerCostMicros: z.number().int(),
	varianceMicros: z.number().int(),
	usageRowCount: z.number().int(),
	reconciledAt: z.string().nullable(),
});
export type ProviderReconciliationResponse = z.infer<
	typeof ProviderReconciliationResponseSchema
>;

export const BillingServiceCreditSnapshotSchema = z.object({
	serviceKey: z.literal("seo"),
	status: z.enum(["trial", "active", "past_due", "cancelled", "suspended"]),
	planVersionId: z.string(),
	periodStart: z.string(),
	periodEnd: z.string(),
	includedCredits: z.number().int().nonnegative(),
	grantedCredits: z.number().int().nonnegative(),
	usedCredits: z.number().int().nonnegative(),
	reservedCredits: z.number().int().nonnegative(),
	availableCredits: z.number().int().nonnegative(),
	enabled: z.boolean(),
	monthlyCreditLimit: z.number().int().nonnegative().nullable(),
	perTediMonthlyLimit: z.number().int().nonnegative().nullable(),
	monthlyProviderCostLimitMicros: z.number().int().nonnegative().nullable(),
	providerCostMicros: z.number().int().nonnegative(),
	reservedProviderCostMicros: z.number().int().nonnegative(),
});
export type BillingServiceCreditSnapshot = z.infer<
	typeof BillingServiceCreditSnapshotSchema
>;

export const GrantBillingServiceCreditsInputSchema = z.object({
	organizationId: z.string().min(1),
	serviceKey: z.literal("seo").default("seo"),
	amountCredits: z.number().int().positive().max(100_000_000),
	idempotencyKey: z.string().min(8).max(300),
	sourceRef: z.string().max(300).nullable().optional(),
	expiresAt: z.string().datetime().nullable().optional(),
	description: z.string().max(500).nullable().optional(),
});
export type GrantBillingServiceCreditsInput = z.infer<
	typeof GrantBillingServiceCreditsInputSchema
>;

export const GrantBillingServiceCreditsResponseSchema = z.object({
	entryId: z.string(),
	snapshot: BillingServiceCreditSnapshotSchema,
});
export type GrantBillingServiceCreditsResponse = z.infer<
	typeof GrantBillingServiceCreditsResponseSchema
>;

export const SetBillingServiceCreditControlsInputSchema = z.object({
	serviceKey: z.literal("seo").default("seo"),
	enabled: z.boolean(),
	monthlyCreditLimit: z.number().int().nonnegative().nullable().optional(),
	perTediMonthlyLimit: z.number().int().nonnegative().nullable().optional(),
	monthlyProviderCostLimitMicros: z
		.number()
		.int()
		.nonnegative()
		.nullable()
		.optional(),
});
export type SetBillingServiceCreditControlsInput = z.infer<
	typeof SetBillingServiceCreditControlsInputSchema
>;

export const SetBillingServiceCreditControlsResponseSchema = z.object({
	snapshot: BillingServiceCreditSnapshotSchema,
});
export type SetBillingServiceCreditControlsResponse = z.infer<
	typeof SetBillingServiceCreditControlsResponseSchema
>;

const WorkstationCoverageGroupSchema = z
	.object({
		rowCount: z.number().int().nonnegative().safe(),
		leaseSeconds: z.number().int().nonnegative().safe(),
	})
	.strict();

/** Recorded lease-end observations, never an invoice or complete compute bill. */
export const WorkstationCostCoverageSchema = z
	.object({
		periodStart: z.iso.datetime(),
		periodEnd: z.iso.datetime(),
		observedAt: z.iso.datetime(),
		unit: z.literal("compute_seconds"),
		basis: z.literal("recorded_lease_end_wall_clock"),
		status: z.enum(["none", "partial", "recorded_rows_reconciled"]),
		knownAttributedCostMicros: z.number().int().nonnegative().safe().nullable(),
		total: WorkstationCoverageGroupSchema,
		reconciled: WorkstationCoverageGroupSchema,
		pending: WorkstationCoverageGroupSchema,
		unproven: WorkstationCoverageGroupSchema,
	})
	.strict()
	.superRefine((value, ctx) => {
		const groups = [value.reconciled, value.pending, value.unproven];
		const rows = groups.reduce((n, group) => n + group.rowCount, 0);
		const seconds = groups.reduce((n, group) => n + group.leaseSeconds, 0);
		const status =
			value.total.rowCount === 0
				? "none"
				: value.reconciled.rowCount === value.total.rowCount
					? "recorded_rows_reconciled"
					: "partial";
		if (
			Date.parse(value.periodStart) >= Date.parse(value.periodEnd) ||
			rows !== value.total.rowCount ||
			seconds !== value.total.leaseSeconds ||
			!Number.isSafeInteger(rows) ||
			!Number.isSafeInteger(seconds) ||
			value.status !== status ||
			(value.reconciled.rowCount === 0) !==
				(value.knownAttributedCostMicros === null) ||
			groups.some((group) => group.rowCount === 0 && group.leaseSeconds !== 0)
		) {
			ctx.addIssue({
				code: "custom",
				message: "Inconsistent recorded workstation cost coverage",
			});
		}
	});

const BillingOverviewFieldsSchema = z.object({
	workstationCostCoverage: WorkstationCostCoverageSchema,
	stripeEnvironment: StripeEnvironmentSchema,
	snapshot: BillingBalanceSnapshotSchema,
	plan: z.object({
		name: z.string(),
		currency: z.string(),
		monthlyPriceMicros: z.number().int(),
		annualPriceMicros: z.number().int(),
		includedMonthlyCreditMicros: z.number().int(),
		overageUnitTokens: z.number().int(),
		overageUnitPriceMicros: z.number().int(),
		maxTedis: z.number().int(),
		maxCronJobsPerTedi: z.number().int(),
		maxIterationsPerTask: z.number().int(),
		defaultDailyTokenLimit: z.number().int(),
		defaultDailyMessageLimit: z.number().int(),
	}),
	period: z
		.object({
			usedInputTokens: z.number().int(),
			usedOutputTokens: z.number().int(),
			meteredOverageTokens: z.number().int(),
			providerCostMicros: z.number().int(),
			customerChargeMicros: z.number().int(),
			creditAppliedMicros: z.number().int(),
		})
		.nullable(),
	inferenceCapacity: z.object({
		available: z.boolean(),
		monthlyMetered: z.boolean(),
		blockingReason: z
			.enum([
				"subscription_inactive",
				"billing_period_inactive",
				"monthly_allowance_exhausted",
				"payment_required",
				"hard_spend_limit",
				"inference_capacity_exhausted",
			])
			.nullable()
			.describe("Null when every billing and inference-admission gate is open"),
		unblockAction: z.enum(["none", "top_up", "upgrade", "manage_payment"]),
		budgetDay: z.string(),
		baseDailyTokenLimit: z.number().int().nonnegative(),
		baseDailySpendLimitMicros: z
			.number()
			.int()
			.nonnegative()
			.nullable()
			.describe("Null when no organization daily spend ceiling is configured"),
		allocatedTokens: z
			.number()
			.int()
			.describe(
				"Net active ledger adjustment; negative after sponsor transfers or refunds",
			),
		allocatedSpendCapacityMicros: z
			.number()
			.int()
			.describe(
				"Net active spend-capacity adjustment; negative after sponsor transfers or refunds",
			),
		sponsoredTokens: z
			.number()
			.int()
			.describe(
				"The part of allocatedTokens this organization sponsored to embedded customers; negative, same sign as the total",
			),
		sponsoredSpendCapacityMicros: z
			.number()
			.int()
			.describe(
				"The part of allocatedSpendCapacityMicros sponsored to embedded customers; negative, same sign as the total",
			),
		usedTokens: z.number().int().nonnegative(),
		usedSpendMicros: z.number().int().nonnegative(),
		remainingTokens: z.number().int().nonnegative(),
		remainingSpendMicros: z
			.number()
			.int()
			.nonnegative()
			.nullable()
			.describe("Null when daily spend capacity is unlimited"),
		expiresAt: z.string().datetime(),
		packs: z.array(InferenceCapacityPackSchema),
		allocations: z.array(
			z.object({
				id: z.string().uuid(),
				packVersionId: z
					.string()
					.nullable()
					.describe("Null for a non-catalog adjustment"),
				packKey: z
					.string()
					.nullable()
					.describe("Null for a non-catalog adjustment"),
				packVersion: z
					.number()
					.int()
					.nullable()
					.describe("Null for a non-catalog adjustment"),
				packName: z
					.string()
					.nullable()
					.describe("Null for a non-catalog adjustment"),
				budgetDay: z.string(),
				tokenAmount: z.number().int(),
				spendAmountMicros: z.number().int(),
				sourceType: z.string(),
				sourceRef: z
					.string()
					.nullable()
					.describe("Null when the capacity source has no provider reference"),
				checkoutSessionId: z
					.string()
					.nullable()
					.describe("Null for entries not created by Stripe Checkout"),
				paymentIntentId: z
					.string()
					.nullable()
					.describe("Null when Stripe did not issue a payment intent"),
				stripeEnvironment: StripeEnvironmentSchema,
				expiresAt: z.string().datetime(),
				createdAt: z.string(),
				state: z.enum(["active", "expired", "compensating"]),
			}),
		),
		tediOverflow: z.array(
			z.object({
				tediId: z.string().uuid(),
				displayName: z.string(),
				usedTokens: z.number().int().nonnegative(),
				usedSpendMicros: z.number().int().nonnegative(),
				baseTokenLimit: z
					.number()
					.int()
					.nonnegative()
					.nullable()
					.describe("Null when the tedi has no finite token ceiling"),
				baseSpendLimitMicros: z
					.number()
					.int()
					.nonnegative()
					.nullable()
					.describe("Null when the tedi has no finite spend ceiling"),
				overflowTokens: z.number().int().nonnegative(),
				overflowSpendMicros: z.number().int().nonnegative(),
			}),
		),
	}),
	serviceCredits: z.object({
		seo: BillingServiceCreditSnapshotSchema.nullable(),
	}),
});
export const BillingOverviewSchema = BillingOverviewFieldsSchema.superRefine(
	(value, ctx) => {
		if (
			Date.parse(value.workstationCostCoverage.periodStart) !==
				Date.parse(value.snapshot.periodStart) ||
			Date.parse(value.workstationCostCoverage.periodEnd) !==
				Date.parse(value.snapshot.periodEnd)
		)
			ctx.addIssue({
				code: "custom",
				path: ["workstationCostCoverage"],
				message: "Workstation coverage must use the canonical billing period",
			});
	},
);
export type BillingOverview = z.infer<typeof BillingOverviewSchema>;

// Records only: these facts do not settle UNKNOWN liability or authorize execution.
const HistoricalHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const HistoricalObjectSchema = z.string().regex(/^[a-f0-9]{64}$/);
function historicalSelection(
	value: {
		rootObjectId: string;
		objectId: string;
		targetPath: CutoverInspectionHop[];
		rootObjectName?: string;
		objectName?: string;
		className?: string;
	},
	ctx: z.RefinementCtx,
) {
	const leaf = value.targetPath.at(-1);
	if (
		(leaf
			? leaf.objectId !== value.objectId ||
				value.objectId === value.rootObjectId
			: value.objectId !== value.rootObjectId) ||
		value.targetPath.some((hop) => hop.objectId === value.rootObjectId) ||
		new Set(value.targetPath.map((hop) => hop.objectId)).size !==
			value.targetPath.length
	)
		ctx.addIssue({
			code: "custom",
			message: "Historical selection and registered path disagree",
			path: ["targetPath"],
		});
	if (
		value.className !== undefined &&
		(value.className !== (leaf?.className ?? "AgentTediDO") ||
			value.objectName !==
				(leaf ? (leaf.identityName ?? leaf.name) : value.rootObjectName))
	)
		ctx.addIssue({
			code: "custom",
			message: "Historical selected identity disagrees",
			path: ["className"],
		});
}
const HistoricalSelection = {
	rootObjectId: HistoricalObjectSchema,
	objectId: HistoricalObjectSchema,
	targetPath: z.array(CutoverInspectionHopSchema).max(16),
};
export const HistoricalExposureInputSchema = z
	.strictObject({
		tediId: z.uuid(),
		operationId: z.string().min(1).max(256),
		...HistoricalSelection,
		expectedGeneration: z.number().int().positive().safe(),
		snapshotId: HistoricalHashSchema,
		sourceHash: HistoricalHashSchema,
	})
	.superRefine(historicalSelection)
	.describe(
		"Record one server-audited physical object under canonical root custody; an empty path selects the root. This does not establish complete graph, historical financial or execution coverage.",
	);
export type HistoricalExposureInput = z.infer<
	typeof HistoricalExposureInputSchema
>;
export const HistoricalExposureSchema = z
	.strictObject({
		id: z.uuid(),
		organizationId: z.uuid(),
		tediId: z.uuid(),
		rootObjectName: z.string().min(1),
		...HistoricalSelection,
		objectName: z.string().min(1),
		className: z.string().min(1).max(128),
		generation: z.number().int().positive().safe(),
		snapshotId: HistoricalHashSchema,
		sourceHash: HistoricalHashSchema,
		manifestHash: z.null(),
		originalRunId: z.null(),
		originalWorkId: z.null(),
		originalPeriod: z.null(),
		usage: z.null(),
		costMicros: z.null(),
		effects: z.literal("UNKNOWN"),
		exposure: z.literal("UNKNOWN"),
		workflowCount: z.number().int().nonnegative().safe(),
		fiberCount: z.number().int().nonnegative().safe(),
		identityCount: z.number().int().nonnegative().safe(),
		observedBy: z.string().min(1),
		observedUserId: z.uuid(),
		observedAt: z.iso.datetime(),
		requestHash: HistoricalHashSchema,
	})
	.superRefine(historicalSelection);
export type HistoricalExposure = z.infer<typeof HistoricalExposureSchema>;
export const HistoricalExposureSetSchema = z.strictObject({
	scope: z.literal("recorded_objects_only"),
	revision: z.number().int().nonnegative().safe(),
	hash: HistoricalHashSchema,
	exposures: z.array(HistoricalExposureSchema),
});
export const HistoricalFundingPinSchema = z.strictObject({
	accountId: z.uuid(),
	entitlementVersion: z.number().int().positive().safe(),
	settlementMode: z.enum(["managed", "external", "disabled"]),
	billingMode: z.enum(["trial", "stripe", "invoice", "internal"]),
	status: z.enum(["active", "trial"]),
	planVersionId: z.uuid(),
	planVersion: z.number().int().positive(),
	periodStart: z.iso.datetime(),
	periodEnd: z.iso.datetime(),
	stripeEnvironment: z.enum(["test", "live"]).nullable(),
});
export const HistoricalFreshDecisionInputSchema = z.strictObject({
	tediId: z.uuid(),
	operationId: z.string().min(1).max(256),
	objectId: HistoricalObjectSchema,
	expectedRevision: z.number().int().nonnegative().safe(),
	exposureSetHash: HistoricalHashSchema,
	permittedGeneration: z
		.number()
		.int()
		.positive()
		.safe()
		.describe(
			"Canonical root generation, greater than every recorded root archive generation. An audited root exposure is required; independent leaf generations do not establish the root epoch.",
		),
	permittedClasses: z
		.array(
			z.enum([
				"AgentTediDO",
				"ConversationFacet",
				"JudgeSessionFacet",
				"SynthesisSessionFacet",
			]),
		)
		.min(1)
		.refine((v) => new Set(v).size === v.length, "Classes must be unique"),
	funding: HistoricalFundingPinSchema,
	expiresAt: z.iso.datetime(),
	acknowledgeUnboundedUnknownExposure: z.literal(true),
});
export type HistoricalFreshDecisionInput = z.infer<
	typeof HistoricalFreshDecisionInputSchema
>;
export const HistoricalFreshRevocationInputSchema = z.strictObject({
	tediId: z.uuid(),
	operationId: z.string().min(1).max(256),
	expectedRevision: z.number().int().nonnegative().safe(),
	decisionId: z.uuid(),
});
export type HistoricalFreshRevocationInput = z.infer<
	typeof HistoricalFreshRevocationInputSchema
>;
export const HistoricalFreshDecisionSchema = z.strictObject({
	id: z.uuid(),
	organizationId: z.uuid(),
	tediId: z.uuid(),
	revision: z.number().int().positive().safe(),
	kind: z.enum(["decision", "revocation"]),
	decisionId: z.uuid().nullable(),
	recordedBy: z.string().min(1),
	recordedUserId: z.uuid(),
	recordedAt: z.iso.datetime(),
	requestHash: HistoricalHashSchema,
	input: z.union([
		HistoricalFreshDecisionInputSchema,
		HistoricalFreshRevocationInputSchema,
	]),
	authority: z.literal("records_only"),
});
export type HistoricalFreshDecision = z.infer<
	typeof HistoricalFreshDecisionSchema
>;
export const HistoricalExposureListInputSchema = z.strictObject({
	tediId: z.uuid(),
});

// Explicit finite permission events; historical records_only outputs stay unchanged.
export const FiniteExecutionAuthorizationInputSchema = z
	.strictObject({
		kind: z.literal("authorize_fresh_execution"),
		tediId: z.uuid(),
		operationId: z.string().min(1).max(256),
		expectedRevision: z.number().int().nonnegative().safe(),
		exposureSetHash: HistoricalHashSchema,
		freshRootName: z.string().min(1).max(512),
		freshRootId: HistoricalObjectSchema,
		preparedGeneration: z.number().int().positive().safe(),
		executionGeneration: z.number().int().positive().safe(),
		leafScopes: z
			.array(
				z.strictObject({
					className: z.enum([
						"ConversationFacet",
						"JudgeSessionFacet",
						"SynthesisSessionFacet",
					]),
					generations: z
						.array(z.number().int().positive().safe())
						.min(1)
						.refine(
							(v) => new Set(v).size === v.length,
							"Generations must be unique",
						),
				}),
			)
			.refine(
				(v) => new Set(v.map((x) => x.className)).size === v.length,
				"Classes must be unique",
			),
		funding: HistoricalFundingPinSchema,
		maxSendDurationSeconds: z.number().int().positive().safe(),
		expiresAt: z.iso.datetime(),
		acknowledgeUnboundedUnknownExposure: z.literal(true),
		acknowledgeOutstandingSendWindowAfterRevocation: z.literal(true),
	})
	.superRefine((v, ctx) => {
		if (
			!Number.isSafeInteger(v.preparedGeneration + 1) ||
			v.executionGeneration !== v.preparedGeneration + 1
		)
			ctx.addIssue({
				code: "custom",
				message: "Execution epoch must be the prepared epoch plus one",
				path: ["executionGeneration"],
			});
		if (
			Date.parse(v.expiresAt) > Date.parse(v.funding.periodEnd) ||
			Date.parse(v.expiresAt) <= Date.parse(v.funding.periodStart)
		)
			ctx.addIssue({
				code: "custom",
				message: "Finite window must fit the existing funding period",
				path: ["expiresAt"],
			});
	})
	.describe(
		"Explicit human finite fresh-execution permission within existing funding. The prepared distinct root must be held or quarantined with positive custody; requested execution epoch is permission scope, not caller attestation. Future leaves require actual accepted origin matching class/positive epoch scope. Each later send window is clamped to maxSendDurationSeconds, expiry and funding period end; revocation stops new admission but an already admitted finite outstanding window may remain. UNKNOWN exposure is unbounded and unresolved. Recording alone does not enforce provider dispatch or release actors.",
	);
export type FiniteExecutionAuthorizationInput = z.infer<
	typeof FiniteExecutionAuthorizationInputSchema
>;
export const FiniteExecutionRevocationInputSchema = z.strictObject({
	kind: z.literal("revoke_fresh_execution"),
	tediId: z.uuid(),
	operationId: z.string().min(1).max(256),
	expectedRevision: z.number().int().nonnegative().safe(),
	authorizationId: z.uuid(),
});
export type FiniteExecutionRevocationInput = z.infer<
	typeof FiniteExecutionRevocationInputSchema
>;
const FiniteEventCommon = {
	id: z.uuid(),
	organizationId: z.uuid(),
	tediId: z.uuid(),
	revision: z.number().int().positive().safe(),
	recordedBy: z.string().min(1),
	recordedUserId: z.uuid(),
	recordedAt: z.iso.datetime(),
	requestHash: HistoricalHashSchema,
	authority: z.literal("finite_execution_permit"),
};
export const FiniteExecutionAuthorizationSchema = z
	.strictObject({
		...FiniteEventCommon,
		kind: z.literal("decision"),
		decisionId: z.null(),
		input: FiniteExecutionAuthorizationInputSchema,
		preparation: z.strictObject({
			state: z.enum(["held", "quarantined"]),
			generation: z.number().int().positive().safe(),
			inspectionHash: HistoricalHashSchema,
			receiver: z.literal("raw-cutover-v1"),
		}),
		// Exact original immutable recorded set, not graph coverage or a numeric reserve.
		exposures: z.array(HistoricalExposureSchema).min(1),
		exposureOperations: z
			.array(
				z.strictObject({
					id: z.uuid(),
					operationId: z.string().min(1).max(256),
				}),
			)
			.min(1),
	})
	.superRefine((v, ctx) => {
		if (
			v.tediId !== v.input.tediId ||
			v.revision !== v.input.expectedRevision + 1 ||
			v.input.funding.accountId !== v.organizationId ||
			v.exposureOperations.length !== v.exposures.length ||
			v.exposureOperations.some((r, i) => r.id !== v.exposures[i]?.id) ||
			new Set(v.exposures.map((e) => e.id)).size !== v.exposures.length ||
			v.preparation.generation !== v.input.preparedGeneration ||
			v.exposures.some(
				(e) =>
					e.organizationId !== v.organizationId ||
					e.tediId !== v.tediId ||
					e.rootObjectId === v.input.freshRootId ||
					e.rootObjectName === v.input.freshRootName,
			) ||
			!v.exposures.some((e) => e.objectId === e.rootObjectId) ||
			Date.parse(v.recordedAt) >= Date.parse(v.input.expiresAt)
		)
			ctx.addIssue({
				code: "custom",
				message: "Finite authorization custody and recorded facts disagree",
			});
	});
export type FiniteExecutionAuthorization = z.infer<
	typeof FiniteExecutionAuthorizationSchema
>;
export const FiniteExecutionRevocationSchema = z
	.strictObject({
		...FiniteEventCommon,
		kind: z.literal("revocation"),
		decisionId: z.uuid(),
		input: FiniteExecutionRevocationInputSchema,
		freshRootName: z.string().min(1).max(512),
		freshRootId: HistoricalObjectSchema,
	})
	.superRefine((v, ctx) => {
		if (
			v.tediId !== v.input.tediId ||
			v.revision !== v.input.expectedRevision + 1 ||
			v.decisionId !== v.input.authorizationId
		)
			ctx.addIssue({
				code: "custom",
				message: "Finite revocation identity disagrees",
			});
	});
export type FiniteExecutionRevocation = z.infer<
	typeof FiniteExecutionRevocationSchema
>;
export const HistoricalDecisionEventSchema = z.union([
	HistoricalFreshDecisionSchema,
	FiniteExecutionAuthorizationSchema,
	FiniteExecutionRevocationSchema,
]);
export type HistoricalDecisionEvent = z.infer<
	typeof HistoricalDecisionEventSchema
>;
