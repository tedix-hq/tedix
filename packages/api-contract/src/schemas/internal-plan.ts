import * as z from "zod";
import { OrganizationFeaturesSchema } from "./organization";
import {
	BillingSettlementModeSchema,
	RuntimeEntitlementSchema,
} from "./runtime-entitlements";

export const AssignInternalPlanInputSchema = z.object({
	organizationId: z.uuid(),
	planKey: z.enum(["starter", "growth", "business", "enterprise"]),
	idempotencyKey: z.string().trim().min(8).max(128),
	reason: z.string().trim().min(1).max(500),
});

export const AssignInternalPlanResponseSchema = z.object({
	organizationId: z.string(),
	planVersionId: z.string(),
	billingMode: z.literal("internal"),
	alreadyAssigned: z.boolean(),
	features: OrganizationFeaturesSchema,
	runtime: RuntimeEntitlementSchema,
	active: z.boolean(),
	settlementMode: BillingSettlementModeSchema,
	allowOverage: z.boolean(),
	overageUnitPriceMicros: z.number().int(),
});
