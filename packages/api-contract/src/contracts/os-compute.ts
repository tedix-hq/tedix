import { CostSummarySchema } from "../schemas/cost-provenance";
import "@orpc/openapi/extensions/route";

import { oc } from "@orpc/contract";
import * as z from "zod";
import { baseErrors } from "../errors";
import {
	CostAttributionGapSchema,
	CostCredentialHealthSchema,
	CostLedgerFreshnessSchema,
	CostAdmissionPolicySchema,
	CostProvenanceBucketSchema,
	CostProvenanceSchema,
} from "../schemas/cost-provenance";
import { ModelCatalogSelectionKindSchema } from "../schemas/model-catalog-projection";

/**
 * Compute POSTURE: the organization-scoped read behind the Tedix OS "Compute
 * and Models" surface and every contextual cost chip.
 *
 * This is operator visibility, never an invoice. Invoices, destructive
 * reconciliation, and secrets stay in the administrative billing plane
 * (`orgUsage.getBillingLedger`, `billing.*`). What lives here is the answer to
 * "can I trust the money I am looking at", which the OS needs beside the work
 * itself.
 *
 * Guarded on the same two planes as the rest of the tenant OS surface
 * (`AUTHZ.osRead`), and org-derived from the caller — there is no
 * `organizationId` input to confuse with an ownership check.
 *
 * WHAT THIS DELIBERATELY DOES NOT CLAIM:
 *   - No value is labeled `provider_reported`. Nothing in this deployment reads
 *     a model provider's billed amount; see `../schemas/cost-provenance`.
 *   - D1 is the sole inference-admission authority. AI Gateway records cost
 *     and usage; it does not carry a second spend-limit policy.
 *   - Model-provider health is always `unknown`: no durable health store exists.
 *   - Unattributed cost is a FLOOR. Rows with no organization are invisible to
 *     every org-scoped read by construction.
 *   - Budget numbers are copied from the canonical admission readers
 *     (`getBillingBalanceSnapshot`, `getRuntimeEntitlement`) and never
 *     recomputed here, so the surface cannot disagree with the gate that
 *     actually blocks inference.
 */

export const CostComputeWindowSchema = z.enum(["24h", "7d", "30d"]);
export type CostComputeWindow = z.infer<typeof CostComputeWindowSchema>;

/**
 * Budget, copied verbatim from the canonical balance snapshot.
 *
 * `remainingIncludedTokens` carries the snapshot's `-1` sentinel for an
 * unlimited plan rather than being flattened to a number the reader would
 * mistake for an exhausted allowance. `configured: false` means no billing
 * account exists — which is NOT "0 remaining", it is "no budget is known".
 */
export const CostBudgetSchema = z.object({
	configured: z.boolean(),
	// NO `.min(0)`. `getBillingBalanceSnapshot` passes the plan's
	// `included_monthly_tokens` through verbatim, and a NEGATIVE value is that
	// column's unlimited sentinel (`credits.ts:119` tests `< 0` for exactly
	// this). A `.min(0)` here made the whole posture read fail output validation
	// with a 500 for every organization on an unlimited plan — including
	// org_tedix — while every fixture used a finite allowance and passed.
	includedTokens: z
		.number()
		.int()
		.nullable()
		.describe(
			"A negative value is the plan's unlimited sentinel; null means no billing account exists, which is not an allowance of 0",
		),
	usedTokens: z
		.number()
		.int()
		.min(0)
		.nullable()
		.describe("Null when no billing account exists — not a consumption of 0"),
	reservedTokens: z
		.number()
		.int()
		.min(0)
		.nullable()
		.describe("Null when no billing account exists — not a reservation of 0"),
	remainingIncludedTokens: z
		.number()
		.int()
		.nullable()
		.describe("-1 means the plan is unlimited; null means no budget is known"),
	// `availableCreditMicros` and `hardSpendLimitMicros` are DELIBERATELY absent.
	// They are billing-plane values (`billing.getOverview`, rendered only in the
	// OS admin billing surface), nothing on this surface renders them, and putting them here
	// would widen what an `os:read` user or an `apps:read` machine key can read
	// for no benefit at all. The plane boundary is the point.
	allowOverage: z
		.boolean()
		.nullable()
		.describe(
			"Null when no entitlement is configured, which is not the same as overage being denied",
		),
	entitlementActive: z
		.boolean()
		.nullable()
		.describe(
			"Whether the admission path currently admits inference; null when no entitlement is configured",
		),
	detail: z.string(),
});
export type CostBudget = z.infer<typeof CostBudgetSchema>;

export const CostSpendTotalsSchema = z.object({
	...CostSummarySchema.shape,
	rowCount: z.number().int().min(0),
	totalTokens: z.number().int().min(0),
	/** Cost of rows the ingestion job did NOT quarantine. */
	costUsd: z
		.number()
		.min(0)
		.nullable()
		.describe(
			"Null when contributing cost evidence is incomplete; known subtotal remains separate and explicit zero is preserved.",
		),
	/** Held-out value, reported beside spend and never summed into it. */
	quarantinedCostUsd: z
		.number()
		.min(0)
		.nullable()
		.describe(
			"Null when any held row has unknown cost; known held subtotal is reported separately.",
		),
	quarantinedKnownSubtotalUsd: z.number().min(0),
	quarantinedTokens: z.number().int().min(0),
	quarantinedRowCount: z.number().int().min(0),
	/**
	 * The strongest label this total may claim: the weakest label among its
	 * contributing rows. Null when no rows contributed — an empty window has no
	 * provenance, and a labeled zero would be the exact defect this shape exists
	 * to prevent.
	 */
	provenanceFloor: CostProvenanceSchema.nullable().describe(
		"Null when no row contributed to this total. An empty window has no provenance, and a labeled zero would be the exact defect this shape exists to prevent",
	),
});
export type CostSpendTotals = z.infer<typeof CostSpendTotalsSchema>;

export const CostModelRoutingSchema = z.object({
	/**
	 * Effective model the routing chain selected, reusing the model catalog's
	 * own vocabulary rather than a second one. Null when the catalog reports no
	 * selectable model.
	 */
	modelRef: z
		.string()
		.nullable()
		.describe(
			"Null when the catalog reports no selectable model — an absent selection, not a default one",
		),
	/**
	 * The catalog's OWN selection vocabulary, not a restatement of it. Typing
	 * this as free text is what let a fixture invent `deployment_default`, a
	 * value `buildRouting` cannot emit, and ship it as if it were observed.
	 */
	selectedBy: ModelCatalogSelectionKindSchema.nullable().describe(
		"Null when no model was selected, so no selection reason exists to report",
	),
	detail: z.string(),
	allowedCount: z.number().int().min(0),
	deniedCount: z.number().int().min(0),
	wiredProviders: z.array(z.string()),
	/**
	 * Providers that actually served calls in the window, from the ledger. A
	 * provider here that the catalog did not select is the ONLY fallback signal
	 * the system can produce — see `fallbackDetail`.
	 */
	observedProviders: z.array(z.string()),
	/**
	 * Why the served provider may differ from the selected one. Runtime fallback
	 * is not recorded anywhere durable (the Agent runtime's Azure breaker is an
	 * in-memory per-isolate global), so a detected divergence carries no reason
	 * and no trip time. Null when nothing diverged.
	 */
	fallbackDetail: z
		.string()
		.nullable()
		.describe(
			"Null when the served provider matched the selected one, so no divergence exists to explain. A non-null value reports the divergence WITHOUT a reason or trip time: runtime fallback is an in-memory per-isolate breaker and records neither",
		),
});
export type CostModelRouting = z.infer<typeof CostModelRoutingSchema>;

export const ComputePostureSchema = z.object({
	window: CostComputeWindowSchema,
	from: z.string(),
	to: z.string(),
	freshness: CostLedgerFreshnessSchema,
	spend: CostSpendTotalsSchema,
	provenance: z.array(CostProvenanceBucketSchema),
	budget: CostBudgetSchema,
	routing: CostModelRoutingSchema,
	credentialHealth: CostCredentialHealthSchema,
	providerHealth: z.object({
		status: z.literal("unknown"),
		detail: z.string(),
	}),
	admissionPolicy: CostAdmissionPolicySchema,
	attribution: CostAttributionGapSchema,
});
export type ComputePosture = z.infer<typeof ComputePostureSchema>;

export const osComputeContract = oc
	.route({ tags: ["os-compute"], prefix: "/os-compute" })
	.errors(baseErrors)
	.router({
		posture: oc
			.route({
				method: "GET",
				path: "/posture",
				summary: "Get the organization's compute and models posture",
				description:
					"Operator-facing read of runtime spend with explicit provenance: ingestion freshness, per-label cost provenance, budget consumed and remaining from the canonical admission readers, model routing and the one detectable fallback signal, AI Gateway credential health, provider health (always unknown), D1 admission policy, and unattributed/quarantined cost. Every value is labeled; nothing is reported as zero because a read returned nothing.",
			})
			.input(
				z.object({
					window: CostComputeWindowSchema.default("7d"),
				}),
			)
			.output(ComputePostureSchema),
	});

export type OsComputeContract = typeof osComputeContract;
