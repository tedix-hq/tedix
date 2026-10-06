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
		includedMonthlyTokens: z.number().int(),
		maxTedis: z.number().int(),
		maxCronJobsPerTedi: z.number().int(),
		maxIterationsPerTask: z.number().int(),
		defaultDailyTokenLimit: z.number().int(),
		defaultDailyMessageLimit: z.number().int(),
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

export const AuthorizeRuntimeInferenceInputSchema = z.strictObject({
	originToken: z.string().min(1).max(16_384),
	organizationId: z.string().min(1),
	tediId: z.string().min(1).nullable().optional(),
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
});
export type AuthorizeRuntimeInferenceInput = z.infer<
	typeof AuthorizeRuntimeInferenceInputSchema
>;

export const RuntimeEntitlementDenialCodeSchema = z.enum([
	"entitlement_not_configured",
	"entitlement_inactive",
	"entitlement_period_inactive",
	"billing_not_configured",
	"subscription_inactive",
	"billing_period_inactive",
	"monthly_allowance_exhausted",
	"payment_required",
	"hard_spend_limit",
	"inference_capacity_exhausted",
	"model_tier_not_allowed",
]);

export const AuthorizeRuntimeInferenceResponseSchema = z
	.discriminatedUnion("allowed", [
		z.object({
			allowed: z.literal(true),
			settlementMode: BillingSettlementModeSchema,
			attributionVersion: z.literal(3),
			executionId: z.uuid(),
			sendBefore: z.iso.datetime(),
			reservationId: z.string().nullable(),
			expiresAt: z.string().nullable(),
			estimatedChargeMicros: z.number().int().nonnegative().nullable(),
		}),
		z.object({
			allowed: z.literal(false),
			code: RuntimeEntitlementDenialCodeSchema,
			entitlement: RuntimeEntitlementSchema.nullable(),
		}),
	])
	.superRefine((decision, ctx) => {
		if (!decision.allowed) return;
		const managed = decision.settlementMode === "managed";
		const financial =
			decision.reservationId !== null &&
			decision.reservationId.trim().length > 0 &&
			decision.expiresAt !== null &&
			Number.isFinite(Date.parse(decision.expiresAt)) &&
			decision.estimatedChargeMicros !== null;
		const empty =
			decision.reservationId === null &&
			decision.expiresAt === null &&
			decision.estimatedChargeMicros === null;
		if (managed ? !financial : !empty)
			ctx.addIssue({
				code: "custom",
				message: "Settlement mode and reservation evidence disagree",
			});
	});
export type AuthorizeRuntimeInferenceResponse = z.infer<
	typeof AuthorizeRuntimeInferenceResponseSchema
>;
