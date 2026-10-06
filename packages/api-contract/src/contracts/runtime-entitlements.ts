import "@orpc/openapi/extensions/route";

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	AuthorizeRuntimeInferenceInputSchema,
	AuthorizeRuntimeInferenceResponseSchema,
	BillingSettlementModeSchema,
	RuntimeEntitlementSchema,
	RuntimeEntitlementStatusSchema,
} from "../schemas/runtime-entitlements";
import { AiGatewayAdmissionPolicySchema } from "../schemas/tedi";

export const RuntimeEntitlementSummarySchema = z.object({
	planKey: z
		.string()
		.min(1)
		.describe("Provider-neutral runtime profile key (e.g. `growth`)"),
	planName: z.string().min(1).describe("Human-readable plan profile name"),
	status: RuntimeEntitlementStatusSchema,
	periodStart: z.string().describe("Effective period start (ISO timestamp)"),
	periodEnd: z.string().describe("Effective period end (ISO timestamp)"),
	active: z
		.boolean()
		.describe(
			"Whether the admission path currently admits runtime inference: a trial/active status whose effective period contains now",
		),
	settlementMode: BillingSettlementModeSchema.describe(
		"Deployment-level billing settlement mode the admission path enforces",
	),
	source: RuntimeEntitlementSchema.shape.source,
	version: z.number().int().positive(),
});
export type RuntimeEntitlementSummary = z.infer<
	typeof RuntimeEntitlementSummarySchema
>;

export const runtimeEntitlementsContract = oc
	.route({ tags: ["runtime-entitlements"], prefix: "/runtime-entitlements" })
	.errors(baseErrors)
	.router({
		get: oc
			.route({
				method: "GET",
				path: "/summary",
				summary: "Get the organization's runtime entitlement summary",
				description:
					"Operator-facing read of the runtime admission state: plan, status, effective period, computed admission activity, settlement mode, and the organization-scope AI Gateway model policy. Nullable when no entitlement is configured.",
			})
			.input(z.object({}))
			.output(
				z.object({
					entitlement: RuntimeEntitlementSummarySchema.nullable().describe(
						"Null when the organization has no runtime entitlement configured — runtime inference is not admitted in that state",
					),
					modelPolicy: AiGatewayAdmissionPolicySchema.nullable().describe(
						"Organization-scope AI Gateway admission policy exactly as the admission path resolves it; null when unconfigured (all catalog model tiers admitted)",
					),
				}),
			),
		getEffective: oc
			.route({
				method: "GET",
				path: "/effective",
				summary: "Get the effective runtime entitlement",
				description:
					"Return the authenticated tenant's provider-neutral runtime profile, limits, grants, source, and effective period.",
			})
			.input(z.object({}))
			.output(RuntimeEntitlementSchema),
		authorizeInference: oc
			.route({
				method: "POST",
				path: "/authorize-inference",
				tags: ["internal"],
				summary: "Authorize runtime inference",
				description:
					"Service-authenticated runtime admission. Managed settlement creates a reservation; disabled and external settlement validate the entitlement without one.",
			})
			.input(AuthorizeRuntimeInferenceInputSchema)
			.output(AuthorizeRuntimeInferenceResponseSchema),
	});

export type RuntimeEntitlementsContract = typeof runtimeEntitlementsContract;
