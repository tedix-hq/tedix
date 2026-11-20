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

/** The published reference rate a credit price was converted at (ECB: USD per 1 EUR). */
export const CreditFxRateSchema = z.object({
	microUsdPerEur: z.number().int().positive().max(10_000_000),
	source: z.url(),
	asOf: z.iso.date(),
});
export type CreditFxRate = z.infer<typeof CreditFxRateSchema>;

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

export const PortalResponseSchema = z.object({
	portalUrl: z.string().url(),
	stripeEnvironment: StripeEnvironmentSchema,
});
export type PortalResponse = z.infer<typeof PortalResponseSchema>;

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
	serviceKey: z.enum(["seo", "web_search"]),
	status: z.enum(["trial", "active", "past_due", "cancelled", "suspended"]),
	planVersionId: z.string(),
	periodStart: z.string(),
	periodEnd: z.string(),
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

// =============================================================================
// TEDIX CREDITS (1 credit = EUR 0.01)
// =============================================================================

const CreditCountSchema = z.number().int().nonnegative().safe();
/** Ceiling for one pay-as-you-go monthly cap: EUR 1,000,000. */
export const PAY_AS_YOU_GO_MONTHLY_CAP_MAX_MICROS = 1_000_000_000_000;

export const BillingPlanSchema = z.object({
	key: BillingPlanKeySchema,
	name: z.string(),
	priceMicros: z.number().int().nonnegative(),
	currency: z.literal("eur"),
	includedCredits: CreditCountSchema,
});
export type BillingPlan = z.infer<typeof BillingPlanSchema>;

export const BillingUsageWindowSchema = z.enum(["month", "30d", "7d"]);

export const BillingDailyUsageSchema = z.array(
	z.object({
		day: z.string(),
		aiPercent: z.number().nonnegative(),
		codeRunPercent: z.number().nonnegative(),
		toolPercent: z.number().nonnegative(),
	}),
);

export const BillingTopUpPurchaseSchema = z.object({
	id: z.string(),
	credits: CreditCountSchema,
	purchasedAt: z.string(),
	expiresAt: z.string(),
});

export const BillingPaymentDetailsSchema = z.object({
	email: z.string().nullable(),
	method: z.string().nullable(),
});

export const BillingInvoicePageSchema = z.object({
	invoices: z.array(
		z.object({
			id: z.string(),
			number: z.string().nullable(),
			issuedAt: z.string(),
			amountMinor: z.number().int(),
			currency: z.string(),
			url: z.string().url().nullable(),
		}),
	),
	nextCursor: z.string().nullable(),
});

export const BillingTopUpPackSchema = z.object({
	packKey: z.string().min(1).max(100),
	credits: z.number().int().positive(),
	priceMicros: z.number().int().positive(),
	currency: z.literal("eur"),
	validMonths: z.literal(12),
});
export type BillingTopUpPack = z.infer<typeof BillingTopUpPackSchema>;

export const CreditNoticeSchema = z.object({
	threshold: z.union([z.literal(80), z.literal(100)]),
	reachedAt: z.string(),
});

export const BillingCreditsSchema = z.object({
	periodStart: z.string(),
	periodEnd: z.string(),
	/** Plan value or the operator-set override for this organization. */
	includedCredits: CreditCountSchema,
	/** This period, all sources. */
	usedCredits: CreditCountSchema,
	remainingIncludedCredits: CreditCountSchema,
	/** Unexpired purchased or converted credits. */
	topUpCredits: CreditCountSchema,
	breakdown: z.object({
		ai: CreditCountSchema,
		codeRuns: CreditCountSchema,
		services: CreditCountSchema,
	}),
	notices: z.array(CreditNoticeSchema),
	payAsYouGo: z.object({
		enabled: z.boolean(),
		monthlyCapMicros: z.number().int().nonnegative().nullable(),
		spentMicros: z.number().int().nonnegative(),
	}),
	tedis: z.array(
		z.object({
			tediId: z.string(),
			name: z.string(),
			usedCredits: CreditCountSchema,
			monthlyCapCredits: CreditCountSchema.nullable(),
		}),
	),
	members: z.array(
		z.object({
			userId: z.string(),
			name: z.string(),
			usedCredits: CreditCountSchema,
			monthlyCapCredits: CreditCountSchema.nullable(),
		}),
	),
});
export type BillingCredits = z.infer<typeof BillingCreditsSchema>;

export const CreditRefusalCodeSchema = z.enum([
	"billing_not_configured",
	"subscription_inactive",
	"billing_period_inactive",
	"monthly_credit_limit_reached",
	"tedi_monthly_credit_cap_reached",
	"member_monthly_credit_cap_reached",
]);
export type CreditRefusalCode = z.infer<typeof CreditRefusalCodeSchema>;

export const CreateTopUpCheckoutInputSchema = z.object({
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
export type CreateTopUpCheckoutInput = z.infer<
	typeof CreateTopUpCheckoutInputSchema
>;

const CreditCapInputSchema = CreditCountSchema.max(1_000_000_000).nullable();

export const SetCreditCapsInputSchema = z
	.object({
		tediCaps: z
			.array(
				z.object({
					tediId: z.string().min(1),
					monthlyCapCredits: CreditCapInputSchema,
				}),
			)
			.max(200)
			.optional(),
		memberCaps: z
			.array(
				z.object({
					userId: z.string().min(1),
					monthlyCapCredits: CreditCapInputSchema,
				}),
			)
			.max(200)
			.optional(),
	})
	.strict();
export type SetCreditCapsInput = z.infer<typeof SetCreditCapsInputSchema>;

export const SetPayAsYouGoInputSchema = z
	.object({
		enabled: z.boolean(),
		monthlyCapMicros: z
			.number()
			.int()
			.positive()
			.max(PAY_AS_YOU_GO_MONTHLY_CAP_MAX_MICROS)
			.nullable()
			.describe(
				"Monthly EUR cap for pay-as-you-go credits; required while enabled",
			),
	})
	.strict()
	.superRefine((value, ctx) => {
		if (value.enabled && value.monthlyCapMicros === null) {
			ctx.addIssue({
				code: "custom",
				path: ["monthlyCapMicros"],
				message: "A monthly cap is required when pay-as-you-go is enabled",
			});
		}
	});
export type SetPayAsYouGoInput = z.infer<typeof SetPayAsYouGoInputSchema>;

export const SetAccountCreditsInputSchema = z
	.object({
		organizationId: z.string().min(1),
		includedCreditsOverride: CreditCountSchema.max(1_000_000_000).nullable(),
		reason: z.string().min(3).max(500),
	})
	.strict();
export type SetAccountCreditsInput = z.infer<
	typeof SetAccountCreditsInputSchema
>;

export const SetAccountCreditsResponseSchema = z.object({
	organizationId: z.string(),
	includedCredits: CreditCountSchema,
	includedCreditsOverride: CreditCountSchema.nullable(),
	entitlementVersion: z.number().int().positive(),
});
export type SetAccountCreditsResponse = z.infer<
	typeof SetAccountCreditsResponseSchema
>;

export const GrantTopUpCreditsInputSchema = z
	.object({
		organizationId: z.string().min(1),
		credits: z.number().int().positive().max(100_000_000),
		idempotencyKey: z.string().min(8).max(300),
		reason: z.string().min(3).max(500),
	})
	.strict();
export type GrantTopUpCreditsInput = z.infer<
	typeof GrantTopUpCreditsInputSchema
>;

export const GrantTopUpCreditsResponseSchema = z.object({
	topUpId: z.string(),
	credits: z.number().int().positive(),
	expiresAt: z.string(),
});

const BillingOverviewFieldsSchema = z.object({
	stripeEnvironment: StripeEnvironmentSchema,
	account: z.object({
		status: z.enum(["trial", "active", "past_due", "cancelled", "suspended"]),
		billingMode: z.enum(["trial", "stripe", "invoice", "internal"]),
		hasIncludedCreditsOverride: z.boolean().optional(),
		hasPaidPlan: z.boolean().optional(),
		periodStart: z.string(),
		periodEnd: z.string(),
		hasStripeCustomer: z
			.boolean()
			.describe(
				"True when a Stripe customer exists, so invoices and the billing portal are available",
			),
	}),
	plan: BillingPlanSchema,
	credits: BillingCreditsSchema,
	admission: z.object({
		available: z.boolean(),
		blockingReason: CreditRefusalCodeSchema.nullable().describe(
			"Null when the pool can admit a typical AI call now",
		),
		unblockAction: z.enum(["none", "top_up", "upgrade", "manage_payment"]),
	}),
	workstationCostCoverage: WorkstationCostCoverageSchema,
});
export const BillingOverviewSchema = BillingOverviewFieldsSchema.superRefine(
	(value, ctx) => {
		if (
			Date.parse(value.workstationCostCoverage.periodStart) !==
				Date.parse(value.account.periodStart) ||
			Date.parse(value.workstationCostCoverage.periodEnd) !==
				Date.parse(value.account.periodEnd)
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
