import "@orpc/openapi/extensions/route";
/**
 * Billing Contract for oRPC
 * Stripe checkout, portal, plan catalog, and canonical billing overview
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
	ListProviderModelRatesInputSchema,
	ProviderModelRateSchema,
	PublishProviderModelRateInputSchema,
} from "../schemas/provider-model-pricing";
import { baseErrors } from "../errors";
import {
	FiniteExecutionAuthorizationInputSchema,
	FiniteExecutionAuthorizationSchema,
	FiniteExecutionRevocationInputSchema,
	FiniteExecutionRevocationSchema,
	HistoricalExposureInputSchema,
	HistoricalExposureSchema,
	HistoricalExposureListInputSchema,
	HistoricalExposureSetSchema,
	HistoricalFreshDecisionInputSchema,
	HistoricalFreshRevocationInputSchema,
	HistoricalFreshDecisionSchema,
	ProviderCapacityPolicySchema,
	BillingOverviewSchema,
	BillingPlanCatalogSchema,
	CheckoutInputSchema,
	CheckoutResponseSchema,
	CreateInferenceCapacityCheckoutInputSchema,
	GrantBillingCreditInputSchema,
	GrantBillingCreditResponseSchema,
	GrantBillingServiceCreditsInputSchema,
	GrantBillingServiceCreditsResponseSchema,
	PortalResponseSchema,
	ProviderReconciliationInputSchema,
	ProviderReconciliationResponseSchema,
	RecordVoiceProviderUsageInputSchema,
	RecordVoiceProviderUsageResponseSchema,
	SetBillingServiceCreditControlsInputSchema,
	SetBillingServiceCreditControlsResponseSchema,
} from "../schemas/billing";

const ProviderCapacitySponsorshipSchema = z.object({
	installationId: z.uuid(),
	providerAppId: z.uuid(),
	externalTenantId: z.string(),
	customerOrganizationId: z.uuid(),
	policy: ProviderCapacityPolicySchema.nullable().describe(
		"Null until the provider organization explicitly enables or disables sponsorship for this installation.",
	),
});

const ProviderCapacitySponsorshipReadinessSchema =
	ProviderCapacitySponsorshipSchema.extend({
		readiness: z
			.object({
				budgetDay: z.string(),
				status: z.enum([
					"disabled",
					"customer_funded",
					"ready",
					"allowance_exhausted",
					"provider_capacity_insufficient",
				]),
				transfersUsed: z.number().int().nonnegative(),
				transfersRemaining: z.number().int().nonnegative(),
				resetsAt: z
					.string()
					.datetime()
					.describe("UTC boundary when daily provider capacity resets."),
			})
			.describe(
				"Current UTC-day readiness. A configured policy is not necessarily funded for another transfer.",
			),
	});

// =============================================================================
// Contract
// =============================================================================

export const billingContract = oc
	.route({ tags: ["billing"], prefix: "/billing" })
	.errors(baseErrors)
	.router({
		recordHistoricalExposure: oc
			.route({
				method: "POST",
				path: "/historical-exposures",
				tags: ["internal"],
				description:
					"Human owner/admin: record server-audited UNKNOWN exposure for a selected physical root or registered descendant under canonical root custody. No settlement or execution authority.",
			})
			.input(HistoricalExposureInputSchema)
			.output(HistoricalExposureSchema),
		listHistoricalExposures: oc
			.route({
				method: "GET",
				path: "/historical-exposures",
				tags: ["internal"],
				description:
					"Human owner/admin: inspect the recorded physical-object exposure set under canonical root custody; no complete graph or provider coverage claim.",
			})
			.input(HistoricalExposureListInputSchema)
			.output(HistoricalExposureSetSchema),
		authorizeHistoricalFreshExecution: oc
			.route({
				method: "POST",
				path: "/historical-fresh-execution/authorize",
				tags: ["internal"],
				description:
					"Human owner/admin: explicitly record finite fresh-execution permission within existing funding after distinct nonactive root inspection. Unresolved UNKNOWN is unbounded; already admitted finite send windows may outlive revocation. Recording does not release actors or enforce provider admission.",
			})
			.input(FiniteExecutionAuthorizationInputSchema)
			.output(FiniteExecutionAuthorizationSchema),
		revokeHistoricalFreshExecution: oc
			.route({
				method: "POST",
				path: "/historical-fresh-execution/revoke",
				tags: ["internal"],
				description:
					"Human owner/admin: append explicit finite permission revocation. No renewal, refund, historical settlement or cancellation of already outstanding finite sends.",
			})
			.input(FiniteExecutionRevocationInputSchema)
			.output(FiniteExecutionRevocationSchema),
		recordHistoricalFreshDecision: oc
			.route({
				method: "POST",
				path: "/historical-fresh-decisions",
				tags: ["internal"],
				description:
					"Human owner/admin bookkeeping within existing funding: pins UNKNOWN exposure and finite fresh scope; does not activate or permit provider execution.",
			})
			.input(HistoricalFreshDecisionInputSchema)
			.output(HistoricalFreshDecisionSchema),
		revokeHistoricalFreshDecision: oc
			.route({
				method: "POST",
				path: "/historical-fresh-decisions/revoke",
				tags: ["internal"],
				description:
					"Human owner/admin: append revocation; retries never renew or reactivate a decision.",
			})
			.input(HistoricalFreshRevocationInputSchema)
			.output(HistoricalFreshDecisionSchema),
		listProviderModelRates: oc
			.route({
				method: "GET",
				path: "/provider-model-rates",
				tags: ["internal"],
				summary: "List provider model rate versions",
				description:
					"Platform billing authority: list immutable provider cost evidence versions, including superseded history.",
			})
			.input(ListProviderModelRatesInputSchema)
			.output(z.object({ rates: z.array(ProviderModelRateSchema) })),
		publishProviderModelRate: oc
			.route({
				method: "POST",
				path: "/provider-model-rates",
				tags: ["internal"],
				summary: "Publish provider model rate version",
				description:
					"Platform billing authority: publish a future provider rate or an explicit exact-interval correction with reviewed evidence; never changes customer tariffs or existing usage.",
			})
			.input(PublishProviderModelRateInputSchema)
			.output(ProviderModelRateSchema),
		/**
		 * Create a Stripe Checkout session for subscription
		 * Redirects user to Stripe-hosted checkout page
		 */
		createCheckout: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/checkout",
				summary: "Create a subscription checkout session",
				description:
					"Create an idempotent Stripe-hosted Checkout session for the authenticated organization and selected plan and billing interval.",
			})
			.input(CheckoutInputSchema)
			.output(CheckoutResponseSchema),

		createInferenceCapacityCheckout: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/inference-capacity/checkout",
				summary: "Create an inference capacity checkout session",
				description:
					"Create an idempotent one-time Stripe Checkout session for a catalog capacity pack that expires at the next UTC midnight.",
			})
			.input(CreateInferenceCapacityCheckoutInputSchema)
			.output(CheckoutResponseSchema),

		listProviderCapacitySponsorships: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/inference-capacity/sponsorships",
				summary: "List provider capacity sponsorships",
				description:
					"List only the authenticated provider organization's embedded installations and their automatic inference-capacity policies.",
			})
			.output(
				z.object({ data: z.array(ProviderCapacitySponsorshipReadinessSchema) }),
			),

		setProviderCapacitySponsorship: oc
			.route({
				tags: ["REST"],
				method: "PUT",
				path: "/inference-capacity/sponsorships/{installationId}",
				summary: "Configure provider capacity sponsorship",
				description:
					"Configure a bounded automatic allowance for one embedded installation owned by the authenticated provider organization. Increment budgetRevision to reset the installation allowance without deleting prior usage or transfers. The caller cannot select or replace the customer organization.",
			})
			.input(
				z
					.object({
						installationId: z.uuid(),
						policy: ProviderCapacityPolicySchema,
					})
					.refine(
						(input) =>
							!input.policy.enabled ||
							input.policy.transferTokens > 0 ||
							input.policy.transferSpendMicros > 0,
						{
							message: "An enabled sponsorship must transfer capacity",
							path: ["policy"],
						},
					),
			)
			.output(ProviderCapacitySponsorshipSchema),

		/**
		 * Create a Stripe Customer Portal session
		 * Allows user to manage subscription, update payment method, cancel
		 */
		createPortal: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/portal",
				summary: "Create a billing portal session",
				description:
					"Create a Stripe-hosted Customer Portal session for the authenticated organization to manage its subscription and payment details.",
			})
			.input(
				z.object({
					returnUrl: z.string().url().optional(),
				}),
			)
			.output(PortalResponseSchema),

		listPlans: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/plans",
				summary: "List available billing plans",
				description:
					"List the active Growth, Business, and Enterprise plan versions with their prices, token allowances, overage rates, and operating limits.",
			})
			.output(BillingPlanCatalogSchema),

		getOverview: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/overview",
				summary: "Get the billing overview",
				description:
					"Return the authenticated organization's current entitlement, balance, usage-period totals, plan limits, and SEO service-credit state.",
			})
			.output(BillingOverviewSchema),

		/** Internal direct ledger path for Gateway-blind voice provider units. */
		recordVoiceProviderUsage: oc
			.route({
				method: "POST",
				path: "/provider-usage/voice",
				tags: ["internal"],
				summary: "Record voice provider usage",
				description:
					"Service-authenticated ledger path for Gateway-blind speech-to-text or text-to-speech provider units and their estimated provider cost.",
			})
			.input(RecordVoiceProviderUsageInputSchema)
			.output(RecordVoiceProviderUsageResponseSchema),

		/** Platform-admin immutable credit grant. */
		grantCredit: oc
			.route({
				method: "POST",
				path: "/credits/grant",
				tags: ["internal"],
				summary: "Grant billing credit",
				description:
					"Platform billing authority: append an immutable, idempotent credit grant to an organization's general billing ledger and return the resulting balance.",
			})
			.input(GrantBillingCreditInputSchema)
			.output(GrantBillingCreditResponseSchema),

		/** An organization restoring its own day to the base its plan includes. */
		restoreDailyCapacity: oc
			.route({
				method: "POST",
				path: "/inference-capacity/restore",
				tags: ["internal"],
				summary: "Restore today's capacity to the plan base",
				description:
					"Return this organization's capacity for the current UTC day to the base its plan already includes, cancelling negative allocations such as the debits a provider takes on for sponsoring its embedded customers. It can only cancel a debit — it never raises a ceiling above the plan base, grants nothing the plan did not include, and costs nothing. Uses the organization's own billing authority, deliberately not platform authority: an organization that has been drained must be able to unblock itself. Idempotent for the day.",
			})
			.input(z.object({}))
			.output(
				z.object({
					budgetDay: z.string(),
					restoredTokens: z
						.number()
						.int()
						.nonnegative()
						.describe("0 when the day was already at or above base"),
					restoredSpendMicros: z.number().int().nonnegative(),
					allocationId: z
						.string()
						.nullable()
						.describe(
							"Null when nothing was restored: the day was already at or above the plan base, so no allocation was written. A restore that changes nothing writes nothing.",
						),
				}),
			),

		/** Platform-admin correction of a wrong billing-period window. */
		correctBillingPeriod: oc
			.route({
				method: "POST",
				path: "/billing-period/correct",
				tags: ["internal"],
				summary: "Correct a billing account period",
				description:
					"Platform billing authority: move a billing account onto a correct period window. rollBillingPeriods already advances a CLOSED window by one month; this is for a window that is WRONG — an account whose period spans a year carries one monthly allowance across it and the roll cannot reach it. Moves the window only: not the plan, status, mode, or any balance, and never earlier than the current periodStart. RESETS ALLOWANCE ACCOUNTING: usage metered against the old window is detached and the included allowance reads as untouched again, which is normally the point of correcting a stretched window. Charges are unaffected, and the detached totals are recorded in the account's lastPeriodCorrection metadata.",
			})
			.input(
				z.object({
					organizationId: z.uuid(),
					periodStart: z.iso.datetime(),
					periodEnd: z.iso.datetime(),
					reason: z.string().trim().min(1).max(500),
				}),
			)
			.output(
				z.object({
					organizationId: z.string(),
					periodStart: z.string(),
					periodEnd: z.string(),
					entitlementVersion: z.number().int(),
				}),
			),

		/** Platform-admin immutable daily inference-capacity grant. */
		grantInferenceCapacity: oc
			.route({
				method: "POST",
				path: "/inference-capacity/grant",
				tags: ["internal"],
				summary: "Grant daily inference capacity",
				description:
					"Platform billing authority: append an immutable, idempotent token and spend-capacity grant for one organization and UTC budget day. This is an operator adjustment, not a purchase or mutable balance reset.",
			})
			.input(
				z
					.object({
						organizationId: z.uuid(),
						tokenAmount: z.number().int().nonnegative().max(1_000_000_000),
						spendAmountMicros: z
							.number()
							.int()
							.nonnegative()
							.max(1_000_000_000_000),
						idempotencyKey: z.string().trim().min(1).max(300),
						description: z.string().trim().min(1).max(500),
					})
					.refine(
						(input) => input.tokenAmount > 0 || input.spendAmountMicros > 0,
						{
							message: "A capacity grant must provide tokens or spend",
						},
					),
			)
			.output(
				z.object({
					allocationId: z.uuid(),
					budgetDay: z.string(),
					expiresAt: z.string(),
					stripeEnvironment: z.enum(["test", "live"]),
				}),
			),

		/** Platform-admin immutable managed-service credit grant. */
		grantServiceCredits: oc
			.route({
				method: "POST",
				path: "/service-credits/grant",
				tags: ["internal"],
				summary: "Grant service credits",
				description:
					"Platform billing authority: append an immutable, idempotent SEO service-credit grant and return the resulting entitlement snapshot.",
			})
			.input(GrantBillingServiceCreditsInputSchema)
			.output(GrantBillingServiceCreditsResponseSchema),

		/** Organization owner/admin lower ceilings and kill switch. */
		setServiceCreditControls: oc
			.route({
				method: "PUT",
				path: "/service-credits/controls",
				summary: "Set service-credit controls",
				description:
					"Enable or disable the authenticated organization's SEO service credits and set optional monthly, per-tedi, and provider-cost ceilings.",
			})
			.input(SetBillingServiceCreditControlsInputSchema)
			.output(SetBillingServiceCreditControlsResponseSchema),

		/** Platform-admin provider invoice/export reconciliation. */
		recordProviderReconciliation: oc
			.route({
				method: "POST",
				path: "/provider-reconciliation",
				tags: ["internal"],
				summary: "Record provider reconciliation",
				description:
					"Platform billing authority: compare provider-reported cost evidence with the internal usage ledger for a time window and record the reconciliation result.",
			})
			.input(ProviderReconciliationInputSchema)
			.output(ProviderReconciliationResponseSchema),
	});

export type BillingContract = typeof billingContract;

export {
	type BillingInterval,
	BillingIntervalSchema,
	type BillingOverview,
	BillingOverviewSchema,
	type BillingPlanCatalog,
	type BillingPlanCatalogItem,
	BillingPlanCatalogItemSchema,
	BillingPlanCatalogSchema,
	type BillingServiceCreditSnapshot,
	BillingServiceCreditSnapshotSchema,
	type CheckoutInput,
	CheckoutInputSchema,
	type CheckoutResponse,
	CheckoutResponseSchema,
	type GrantBillingCreditInput,
	GrantBillingCreditInputSchema,
	type GrantBillingCreditResponse,
	GrantBillingCreditResponseSchema,
	type GrantBillingServiceCreditsInput,
	GrantBillingServiceCreditsInputSchema,
	type GrantBillingServiceCreditsResponse,
	GrantBillingServiceCreditsResponseSchema,
	type PortalResponse,
	PortalResponseSchema,
	type ProviderReconciliationInput,
	ProviderReconciliationInputSchema,
	type ProviderReconciliationResponse,
	ProviderReconciliationResponseSchema,
	type RecordVoiceProviderUsageInput,
	RecordVoiceProviderUsageInputSchema,
	type RecordVoiceProviderUsageResponse,
	RecordVoiceProviderUsageResponseSchema,
	type SetBillingServiceCreditControlsInput,
	SetBillingServiceCreditControlsInputSchema,
	type SetBillingServiceCreditControlsResponse,
	SetBillingServiceCreditControlsResponseSchema,
} from "../schemas/billing";
