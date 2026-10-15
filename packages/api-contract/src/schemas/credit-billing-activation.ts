import * as z from "zod";
import { CreditFxRateSchema } from "./billing";

export const ConfigureCreditBillingInputSchema = z.object({
	organizationId: z.uuid(),
	expectedEntitlementVersion: z.number().int().positive(),
	idempotencyKey: z.string().min(8).max(128),
	reason: z.string().trim().min(1).max(500),
	includedMonthlyCreditMicros: z
		.number()
		.int()
		.positive()
		.max(1_000_000_000_000),
	monthlyCapMicros: z.number().int().positive().max(1_000_000_000_000),
	perRunBudgetMicros: z.number().int().positive().max(1_000_000_000_000),
	/** Converts the USD provider receipts into EUR credit prices. */
	fx: CreditFxRateSchema,
	rateBindings: z
		.array(
			z.object({
				rateVersionId: z.string().min(1),
				inputConvention: z.enum(["inclusive", "exclusive"]),
				requestModelAliases: z.array(z.string().min(1)).max(20),
			}),
		)
		.min(1)
		.max(30),
});
export type ConfigureCreditBillingInput = z.infer<
	typeof ConfigureCreditBillingInputSchema
>;
export const ConfigureCreditBillingResponseSchema = z.object({
	organizationId: z.uuid(),
	planVersionId: z.string(),
	entitlementVersion: z.number().int(),
	creditBalanceMicros: z.number().int(),
	periodStart: z.string(),
	periodEnd: z.string(),
	includedCreditCarryForward: z.literal(true),
	alreadyConfigured: z.boolean(),
});

/**
 * Replaces a live wallet's rate snapshot with a new private plan version. The
 * balance, included credits, monthly cap and run budget stay as they are.
 */
export const RepriceCreditBillingInputSchema =
	ConfigureCreditBillingInputSchema.pick({
		organizationId: true,
		expectedEntitlementVersion: true,
		idempotencyKey: true,
		reason: true,
		fx: true,
		rateBindings: true,
	});
export type RepriceCreditBillingInput = z.infer<
	typeof RepriceCreditBillingInputSchema
>;
export const RepriceCreditBillingResponseSchema = z.object({
	organizationId: z.uuid(),
	planVersionId: z.string(),
	previousPlanVersionId: z.string(),
	entitlementVersion: z.number().int(),
	creditBalanceMicros: z.number().int(),
	rateVersionIds: z.array(z.string()),
	alreadyRepriced: z.boolean(),
});
