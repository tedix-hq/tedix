import {
	RecordProviderCostEvidenceInputSchema,
	RecordProviderCostEvidenceResponseSchema,
} from "../schemas/provider-cost-evidence";
import "@orpc/openapi/extensions/route";
/**
 * Billing Contract for oRPC
 * Stripe checkout, portal, plan catalog, and canonical billing overview
 */

import { oc } from "@orpc/contract";
import {
	AssignInternalPlanInputSchema,
	AssignInternalPlanResponseSchema,
} from "../schemas/internal-plan";
import * as z from "zod";
import {
	ListProviderModelRatesInputSchema,
	ProviderModelRateSchema,
	PublishProviderModelRateInputSchema,
} from "../schemas/provider-model-pricing";
import { baseErrors } from "../errors";
import {
	BillingInferenceSpendingInputSchema,
	BillingInferenceSpendingSchema,
} from "../schemas/billing-spending";
import {
	FiniteExecutionRevocationInputSchema,
	FiniteExecutionRevocationSchema,
	HistoricalExposureListInputSchema,
	HistoricalExposureSetSchema,
	HistoricalFreshDecisionInputSchema,
	HistoricalFreshRevocationInputSchema,
	HistoricalFreshDecisionSchema,
	BillingCreditsSchema,
	BillingOverviewSchema,
	BillingPlanSchema,
	BillingTopUpPackSchema,
	CheckoutInputSchema,
	CheckoutResponseSchema,
	CreateTopUpCheckoutInputSchema,
	GrantTopUpCreditsInputSchema,
	GrantTopUpCreditsResponseSchema,
	PortalResponseSchema,
	ProviderReconciliationInputSchema,
	ProviderReconciliationResponseSchema,
	RecordVoiceProviderUsageInputSchema,
	RecordVoiceProviderUsageResponseSchema,
	SetAccountCreditsInputSchema,
	SetAccountCreditsResponseSchema,
	SetBillingServiceCreditControlsInputSchema,
	SetBillingServiceCreditControlsResponseSchema,
	SetCreditCapsInputSchema,
	SetPayAsYouGoInputSchema,
} from "../schemas/billing";

// =============================================================================
// Contract
// =============================================================================

export const billingContract = oc
	.route({ tags: ["billing"], prefix: "/billing" })
	.errors(baseErrors)
	.router({
		assignInternalPlan: oc
			.route({
				method: "POST",
				path: "/internal-plan",
				tags: ["internal"],
				summary: "Assign a complimentary internal plan",
				description:
					"Platform billing authority: atomically assign an active internal plan and its organization features, with an immutable idempotent audit receipt. Refuses Stripe-linked accounts and in-flight reservations; never calls Stripe.",
			})
			.input(AssignInternalPlanInputSchema)
			.output(AssignInternalPlanResponseSchema),
		getInferenceSpending: oc
			.route({
				method: "GET",
				path: "/inference-spending",
				description:
					"Read the authenticated organization's newest settled USD inference-credit receipts from the last 30 days. Pagination and missing run/price attribution remain explicit; no financial mutation.",
			})
			.input(BillingInferenceSpendingInputSchema)
			.output(BillingInferenceSpendingSchema),
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

		createTopUpCheckout: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/top-ups/checkout",
				summary: "Buy a credit top-up",
				description:
					"Create an idempotent one-time Stripe Checkout session for a Tedix credit top-up pack. Top-up credits stay valid for 12 months and are spent after the month's included credits.",
			})
			.input(CreateTopUpCheckoutInputSchema)
			.output(CheckoutResponseSchema),

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
					"List the active Starter, Growth, Business, and Enterprise plans with their monthly price and included Tedix credits (1 credit = EUR 0.01).",
			})
			.output(z.array(BillingPlanSchema)),

		listTopUpPacks: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/top-ups",
				summary: "List credit top-up packs",
				description:
					"List the one-time Tedix credit top-up packs on sale. Each pack stays valid for 12 months.",
			})
			.output(z.array(BillingTopUpPackSchema)),

		getOverview: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/overview",
				summary: "Get the billing overview",
				description:
					"Return the organization's plan, Tedix credits used and remaining this month, top-up credits, pay-as-you-go state, usage by tedi and member, and the 80% and 100% notices.",
			})
			.output(BillingOverviewSchema),

		setCreditCaps: oc
			.route({
				method: "PUT",
				path: "/credit-caps",
				summary: "Set monthly credit caps",
				description:
					"Organization owner/admin: set or clear a monthly credit cap for individual tedis and members. A cap only narrows what one tedi or member may use from the organization's credits; null removes it.",
			})
			.input(SetCreditCapsInputSchema)
			.output(BillingCreditsSchema),

		setPayAsYouGo: oc
			.route({
				method: "PUT",
				path: "/pay-as-you-go",
				summary: "Set pay-as-you-go",
				description:
					"Organization owner/admin: keep work running past the month's credits at EUR 0.01 per credit, up to a monthly EUR cap, or turn it off so usage stops at the limit.",
			})
			.input(SetPayAsYouGoInputSchema)
			.output(BillingCreditsSchema),

		setAccountCredits: oc
			.route({
				method: "PUT",
				path: "/account-credits",
				tags: ["internal"],
				summary: "Set an organization's included credits",
				description:
					"Tedix operator only: set or clear an organization's monthly included credits (null uses the plan value). Bumps the entitlement version and writes an audit record.",
			})
			.input(SetAccountCreditsInputSchema)
			.output(SetAccountCreditsResponseSchema),

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

		/** Platform-admin idempotent top-up credit grant. */
		grantTopUpCredits: oc
			.route({
				method: "POST",
				path: "/top-ups/grant",
				tags: ["internal"],
				summary: "Grant top-up credits",
				description:
					"Platform billing authority: add idempotent top-up credits to an organization, valid for 12 months.",
			})
			.input(GrantTopUpCreditsInputSchema)
			.output(GrantTopUpCreditsResponseSchema),

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
		recordProviderCostEvidence: oc
			.route({
				method: "POST",
				path: "/provider-cost-evidence",
				tags: ["internal"],
				summary: "Record reviewed provider cost evidence",
				description:
					"Platform billing authority with separately admitted external financial authority: validate or append immutable provider estimates without customer charges.",
			})
			.input(RecordProviderCostEvidenceInputSchema)
			.output(RecordProviderCostEvidenceResponseSchema),

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
	type BillingServiceCreditSnapshot,
	BillingServiceCreditSnapshotSchema,
	type CheckoutInput,
	CheckoutInputSchema,
	type CheckoutResponse,
	CheckoutResponseSchema,
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
	SetCreditCapsInputSchema,
	SetPayAsYouGoInputSchema,
} from "../schemas/billing";
