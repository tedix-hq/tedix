import * as z from "zod";
import { ProviderExecutionIdentitySchema } from "./provider-execution";
import { JsonValueSchema } from "./common";

export const BillingSettlementModeSchema = z.enum([
	"managed",
	"external",
	"disabled",
]);
export type BillingSettlementMode = z.infer<typeof BillingSettlementModeSchema>;

export const RuntimeEntitlementStatusSchema = z.enum([
	"trial",
	"active",
	"past_due",
	"cancelled",
	"suspended",
]);

export const RuntimeEntitlementGrantSchema = z.object({
	key: z.string().min(1),
	status: z.enum(["active", "inactive"]),
	source: z.enum(["license", "managed-plan", "operator", "internal"]),
});
export type RuntimeEntitlementGrant = z.infer<
	typeof RuntimeEntitlementGrantSchema
>;

export const RuntimeEntitlementSchema = z.object({
	organizationId: z.string().min(1),
	status: RuntimeEntitlementStatusSchema,
	effectivePeriod: z.object({
		startsAt: z.string(),
		endsAt: z.string(),
	}),
	profile: z.object({
		key: z.string().min(1),
		name: z.string().min(1),
	}),
	limits: z.object({
		includedMonthlyCredits: z.number().int().nonnegative(),
		maxTedis: z.number().int().nonnegative(),
		maxCronJobsPerTedi: z.number().int().nonnegative(),
		maxIterationsPerTask: z.number().int(),
	}),
	grants: z.array(RuntimeEntitlementGrantSchema),
	source: z.enum(["installation", "managed-plan", "external", "operator"]),
	version: z.number().int().positive(),
});
export type RuntimeEntitlement = z.infer<typeof RuntimeEntitlementSchema>;

export const RuntimeEntitlementUsageSourceSchema = z.enum([
	"operator",
	"automation",
	"observer",
	"compaction",
	"kernel",
	"evaluation",
	"system",
	"gadget",
]);

/**
 * The member whose action started this inference: their sign-in subject
 * (Descope user id). Member credit caps and member usage totals key on it.
 * Absent when no person started the work (scheduled or autonomous runs);
 * then only the organization and tedi limits apply.
 */
export const ActingMemberSubjectSchema = z
	.string()
	.min(1)
	.max(300)
	.nullable()
	.optional()
	.describe(
		"Sign-in subject of the member who started this work; absent for scheduled or autonomous runs.",
	);

export const AuthorizeRuntimeInferenceInputSchema = z
	.strictObject({
		originToken: z.string().min(1).max(16_384),
		organizationId: z.string().min(1),
		tediId: z.string().min(1).nullable().optional(),
		userId: ActingMemberSubjectSchema,
		settlementMode: BillingSettlementModeSchema,
		source: RuntimeEntitlementUsageSourceSchema,
		execution: ProviderExecutionIdentitySchema,
		workItemId: z
			.string()
			.max(300)
			.nullable()
			.describe(
				"Null when the actual execution is not associated with a Work Item.",
			),
		estimatedInputTokens: z.number().int().min(0).max(10_000_000),
		estimatedOutputTokens: z.number().int().min(0).max(2_000_000),
		runId: z.string().max(300).nullable().optional(),
		traceId: z.string().max(300).nullable().optional(),
		idempotencyKey: z.string().min(8).max(300),
		metadata: z.record(z.string(), JsonValueSchema).optional(),
	})
	.refine(
		(r) =>
			r.execution.requestModel !== "cloudflare/auto" ||
			r.execution.autoRouting !== undefined,
		{ message: "New Auto inference requires routing evidence" },
	);
export type AuthorizeRuntimeInferenceInput = z.infer<
	typeof AuthorizeRuntimeInferenceInputSchema
>;

export const RuntimeEntitlementDenialCodeSchema = z.enum([
	"eu_provider_pool_required",
	"eu_provider_route_required",
	"eu_provider_credential_required",
	"residency_policy_unavailable",
	"entitlement_not_configured",
	"entitlement_inactive",
	"entitlement_period_inactive",
	"billing_not_configured",
	"subscription_inactive",
	"billing_period_inactive",
	"monthly_credit_limit_reached",
	"tedi_monthly_credit_cap_reached",
	"member_monthly_credit_cap_reached",
	"pricing_unavailable",
	"model_tier_not_allowed",
	"work_budget_exhausted",
]);

export type RuntimeEntitlementDenialCode = z.infer<
	typeof RuntimeEntitlementDenialCodeSchema
>;

const RUNTIME_INFERENCE_DENIAL_REASONS: Record<
	RuntimeEntitlementDenialCode,
	string
> = {
	eu_provider_pool_required: "An approved regional provider pool is required.",
	eu_provider_route_required: "An approved regional model route is required.",
	eu_provider_credential_required:
		"A regional provider credential is required.",
	residency_policy_unavailable: "The data residency policy could not be read.",
	entitlement_not_configured: "Runtime entitlement is not configured.",
	entitlement_inactive: "Runtime entitlement is inactive.",
	entitlement_period_inactive: "The runtime entitlement period is inactive.",
	billing_not_configured: "Billing is not configured.",
	subscription_inactive: "Your subscription needs attention.",
	billing_period_inactive: "Your billing period needs to be renewed.",
	monthly_credit_limit_reached:
		"This month's Tedix credits are used up. Buy a top-up or turn on pay-as-you-go.",
	tedi_monthly_credit_cap_reached:
		"This tedi reached the monthly credit cap an admin set for it.",
	member_monthly_credit_cap_reached:
		"You reached the monthly credit cap an admin set for you.",
	pricing_unavailable: "Model pricing is not available yet.",
	model_tier_not_allowed: "This model tier is not allowed by the current plan.",
	work_budget_exhausted:
		"This Work's credit budget is used up. An owner can raise the budget on the Work Item, its project, case or objective.",
};

/** Shared by turn notices and the billing console; the code identifies the exact gate. */
export function runtimeInferenceDenialMessage(
	code: RuntimeEntitlementDenialCode,
): string {
	return `${RUNTIME_INFERENCE_DENIAL_REASONS[code]} (${code})`;
}

const microusdPerMillion = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER);

/**
 * The governed provider rate that priced this admission's identity and
 * estimated input band. Senders pass it to AI Gateway as `cf-aig-custom-cost`
 * so Gateway logs use it instead of Cloudflare's public price list.
 */
export const AdmittedProviderRateSchema = z.strictObject({
	rateVersionId: z.string().min(1),
	inputMicrousdPerMillion: microusdPerMillion,
	outputMicrousdPerMillion: microusdPerMillion,
	cacheReadMicrousdPerMillion: microusdPerMillion,
	cacheWriteMicrousdPerMillion: microusdPerMillion,
});
export type AdmittedProviderRate = z.infer<typeof AdmittedProviderRateSchema>;

export const AuthorizeRuntimeInferenceResponseSchema = z
	.discriminatedUnion("allowed", [
		z.object({
			allowed: z.literal(true),
			settlementMode: BillingSettlementModeSchema,
			attributionVersion: z.literal(3),
			executionId: z.uuid(),
			sendBefore: z.iso.datetime(),
			/** Service-only transport material. Never record in attribution or execution receipts. */
			providerApiKey: z.string().optional(),
			providerExecution: ProviderExecutionIdentitySchema.optional(),
			/** Absent when no single governed rate resolves; never a guessed price. */
			providerRate: AdmittedProviderRateSchema.optional(),
			reservationId: z.string().nullable(),
			expiresAt: z.string().nullable(),
			estimatedCredits: z.number().int().nonnegative().nullable(),
		}),
		z.object({
			allowed: z.literal(false),
			code: RuntimeEntitlementDenialCodeSchema,
			message: z.string().optional(),
			entitlement: RuntimeEntitlementSchema.nullable(),
		}),
	])
	.superRefine((decision, ctx) => {
		if (!decision.allowed) return;
		if (
			Boolean(decision.providerApiKey) !==
				Boolean(decision.providerExecution) ||
			(decision.providerExecution &&
				decision.providerExecution.provider !== "azure-openai")
		)
			ctx.addIssue({
				code: "custom",
				message:
					"A regional credential requires its exact supported provider execution identity",
			});
		const managed = decision.settlementMode === "managed";
		const financial =
			decision.reservationId !== null &&
			decision.reservationId.trim().length > 0 &&
			decision.expiresAt !== null &&
			Number.isFinite(Date.parse(decision.expiresAt)) &&
			decision.estimatedCredits !== null;
		const empty =
			decision.reservationId === null &&
			decision.expiresAt === null &&
			decision.estimatedCredits === null;
		if (managed ? !financial : !empty)
			ctx.addIssue({
				code: "custom",
				message: "Settlement mode and reservation evidence disagree",
			});
	});
export type AuthorizeRuntimeInferenceResponse = z.infer<
	typeof AuthorizeRuntimeInferenceResponseSchema
>;

/**
 * Admission for one workspace chat model call. The workspace object names the
 * turn and who acts in it; apps/api reserves credits through the same path as
 * the kernel and the tedi runtime, and the AI Gateway log of the call settles
 * the reservation on the actual cost.
 */
export const AuthorizeWorkspaceInferenceInputSchema = z.strictObject({
	organizationId: z.string().min(1),
	workspaceId: z.string().min(1).max(300),
	turnId: z.string().min(1).max(300),
	/** Set when the turn runs as a guest tedi; its tedi cap applies. */
	tediId: z.string().min(1).nullable().optional(),
	userId: ActingMemberSubjectSchema,
	execution: ProviderExecutionIdentitySchema,
	residencyModality: z.enum(["image", "text"]).optional(),
	estimatedInputTokens: z.number().int().min(0).max(10_000_000),
	estimatedOutputTokens: z.number().int().min(0).max(2_000_000),
	idempotencyKey: z.string().min(8).max(300),
});
export type AuthorizeWorkspaceInferenceInput = z.infer<
	typeof AuthorizeWorkspaceInferenceInputSchema
>;

/** Return a reservation whose provider call was never sent or was refused. */
export const ReleaseInferenceReservationInputSchema = z.strictObject({
	organizationId: z.string().min(1),
	reservationId: z.string().min(1).max(300),
	reason: z.enum(["provider_request_not_sent", "provider_request_failed"]),
});
export type ReleaseInferenceReservationInput = z.infer<
	typeof ReleaseInferenceReservationInputSchema
>;

export const ReleaseInferenceReservationResponseSchema = z.object({
	released: z.boolean(),
});
