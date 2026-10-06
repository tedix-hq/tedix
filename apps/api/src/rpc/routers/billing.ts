import { getWorkstationCostCoverage } from "@tedix/db/queries/billing/provider-usage";
/**
 * Billing Router
 * Stripe Checkout, Customer Portal, and canonical billing overview
 */

/// <reference path="../../../worker-configuration.d.ts" />

import { implement, ORPCError } from "@orpc/server";
import { billingContract } from "@tedix/api-contract/contracts/billing";
import {
	listProviderModelRates,
	publishProviderModelRate,
} from "@tedix/db/queries/billing/provider-model-rates";
import { isPlatformPrincipal } from "@tedix/auth/types";
import {
	getBillingBalanceSnapshot,
	grantBillingCredit,
} from "@tedix/db/queries/billing/credits";
import {
	countSponsoredCapacityTransfers,
	getActiveCapacityAllocationTotals,
	getInferenceCapacityDailyOverview,
	getInferenceCapacityLedger,
	recordCapacityAllocation,
} from "@tedix/db/queries/billing/capacity-allocations";
import { getEffectiveInferencePolicies } from "@tedix/db/queries/billing/inference-policies";
import {
	billingBlockingReason,
	incrementalOverageChargeMicros,
	NOMINAL_TURN_TOKENS,
	usesMonthlyInferenceCapacity,
} from "@tedix/db/queries/billing/reservations";
import {
	getActiveInferenceCapacityPackByKey,
	listActiveInferenceCapacityPacks,
} from "@tedix/db/queries/billing/capacity-packs";
import {
	getBillingUsagePeriod,
	recordBillingProviderReconciliation,
} from "@tedix/db/queries/billing/health";
import {
	listProviderCapacitySponsorships,
	setProviderCapacitySponsorship,
} from "@tedix/db/queries/provider-installations";
import {
	correctBillingAccountPeriod,
	getActiveBillingPlanByKey,
	getBillingEntitlement,
} from "@tedix/db/queries/billing/plans";
import {
	getBillingServiceCreditSnapshot,
	grantBillingServiceCredits,
	setBillingServiceCreditControls,
} from "@tedix/db/queries/billing-service-credits";
import { toJsonRecord } from "@tedix/db/utils/json";
import { buildBillingSettingsUrl } from "../../lib/billing-urls";
import { resolveBillingSettlementMode } from "../../lib/billing-settlement-mode";
import { resolveFleetAuthorityDb } from "../../lib/fleet-authority";
import { getStripe } from "../../lib/stripe";
import {
	planSellsStripeOverage,
	STRIPE_TOKEN_OVERAGE_LOOKUP_KEY,
	stripeCheckoutIdempotencyKey,
	stripePlanPriceLookupKey,
} from "../../lib/stripe-billing";
import {
	getStripeEnvironmentConfig,
	resolveStripeEnvironment,
} from "../../lib/stripe-environment";
import { recordVoiceProviderUsage } from "../../lib/voice-provider-usage";
import { resolveSponsorshipReadiness } from "./billing-sponsorship-readiness";
import {
	type BaseContext,
	withAuth,
	withAuthorization,
	withFleetAuthority,
	withServiceAuth,
} from "../orpc";

const os = implement(billingContract).$context<BaseContext>();

async function inferenceCapacityCheckoutIdempotencyKey(input: {
	organizationId: string;
	packVersionId: string;
	priceId: string;
	stripeEnvironment: "test" | "live";
	successUrl: string;
	cancelUrl: string;
	nowMs: number;
}): Promise<string> {
	const bucket = Math.floor(input.nowMs / (30 * 60 * 1_000));
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(
			[
				input.organizationId,
				input.packVersionId,
				input.priceId,
				input.stripeEnvironment,
				input.successUrl,
				input.cancelUrl,
				String(bucket),
			].join("\n"),
		),
	);
	return `tedix:inference-capacity-checkout:${Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")}`;
}

function requireManagedSettlement(context: BaseContext): void {
	if (resolveBillingSettlementMode(context.env) !== "managed") {
		throw new ORPCError("FORBIDDEN", {
			message: "Managed billing settlement is not enabled",
		});
	}
}

async function requireStripePriceByLookupKey(
	stripe: Awaited<ReturnType<typeof getStripe>>,
	lookupKey: string,
): Promise<string> {
	const prices = await stripe.prices.list({
		active: true,
		lookup_keys: [lookupKey],
		limit: 1,
	});
	const price = prices.data[0];
	if (!price) {
		throw new ORPCError("INTERNAL_SERVER_ERROR", {
			message: `Stripe has no active price with lookup key ${lookupKey}`,
		});
	}
	return price.id;
}

/**
 * Platform billing authority mints spending power: it grants credit, grants
 * inference capacity, grants service credits, corrects a billing period and
 * records provider reconciliation. `isPlatformPrincipal` answers true for a
 * TEDI token carrying `platform:admin` in `tediScopes`, which made a second
 * door into the one thing VISION.md says stays owner-held — a tedi could not
 * write its own `budgets` field, but it could grant itself the capacity that
 * the enforcing SQL adds to the very same ceiling.
 *
 * A tedi is therefore never platform billing authority, whatever its scopes
 * say. Human, operator API key, M2M and service-binding principals are
 * unchanged; these authority procedures have no tedi-runtime caller.
 */
export function requirePlatformBillingAuthority(context: BaseContext): string {
	if (context.authType === "tedi") {
		throw new ORPCError("FORBIDDEN", {
			message:
				"Platform billing authority is never held by a tedi principal; capacity and credit stay owner-held",
		});
	}
	if (!isPlatformPrincipal(context)) {
		throw new ORPCError("FORBIDDEN", {
			message: "Platform billing authority is required",
		});
	}
	return (
		context.user?.sub ??
		context.apiKey?.id ??
		context.serviceAccount?.clientId ??
		context.tediId ??
		"platform-admin"
	);
}

function requireOrganizationBillingAuthority(context: BaseContext): string {
	if (
		!isPlatformPrincipal(context) &&
		context.userRole !== "owner" &&
		context.userRole !== "admin"
	) {
		throw new ORPCError("FORBIDDEN", {
			message: "Organization owner or admin authority is required",
		});
	}
	return (
		context.user?.sub ??
		context.apiKey?.id ??
		context.serviceAccount?.clientId ??
		context.tediId ??
		"organization-admin"
	);
}

// =============================================================================
// CREATE CHECKOUT SESSION
// =============================================================================

const createCheckoutContract = os.createCheckout
	.use(withAuth)
	.use(withFleetAuthority)
	.handler(async ({ context, input }) => {
		requireManagedSettlement(context);
		const { env, organizationId } = context;
		if (!organizationId) {
			throw new ORPCError("UNAUTHORIZED", { message: "No organization" });
		}

		const stripeEnvironment = resolveStripeEnvironment(env);
		const stripeConfig = getStripeEnvironmentConfig(env, stripeEnvironment);
		const stripe = await getStripe(stripeConfig.secretKey);
		const entitlement = await getBillingEntitlement(context.db, organizationId);
		if (!entitlement) {
			throw new ORPCError("NOT_FOUND", {
				message: "Billing account not found",
			});
		}

		const plan = await getActiveBillingPlanByKey(
			context.db,
			input.tier,
			new Date().toISOString(),
		);
		if (!plan) {
			throw new ORPCError("BAD_REQUEST", {
				message: `Invalid tier: ${input.tier}`,
			});
		}

		if (
			entitlement.account.stripeEnvironment === stripeEnvironment &&
			entitlement.account.stripeSubscriptionId &&
			["active", "trial", "past_due"].includes(entitlement.account.status)
		) {
			throw new ORPCError("CONFLICT", {
				message:
					"An existing Stripe subscription is already linked. Use the billing portal to manage it.",
			});
		}

		const osUrl = env.OS_URL;
		const successUrl =
			input.successUrl ?? buildBillingSettingsUrl({ osUrl, state: "success" });
		const cancelUrl =
			input.cancelUrl ?? buildBillingSettingsUrl({ osUrl, state: "cancelled" });

		// Reuse an existing customer. Subscription-mode Checkout creates one
		// automatically when `customer` is omitted; `customer_creation` is valid
		// only for payment-mode sessions.
		const customerParams: Record<string, unknown> = {};
		if (
			entitlement.account.stripeEnvironment === stripeEnvironment &&
			entitlement.account.stripeCustomerId
		) {
			customerParams.customer = entitlement.account.stripeCustomerId;
		}

		// Build line items: base subscription + metered overage (if tier sells it)
		const priceId = await requireStripePriceByLookupKey(
			stripe,
			stripePlanPriceLookupKey(plan.planKey, input.interval),
		);
		const lineItems: Array<{ price: string; quantity?: number }> = [
			{ price: priceId, quantity: 1 },
		];
		const overagePriceId = planSellsStripeOverage(plan)
			? await requireStripePriceByLookupKey(
					stripe,
					STRIPE_TOKEN_OVERAGE_LOOKUP_KEY,
				)
			: null;
		if (overagePriceId) {
			lineItems.push({ price: overagePriceId });
		}

		const checkoutNowMs = Date.now();
		const checkoutBucket = Math.floor(checkoutNowMs / (30 * 60 * 1_000));
		// Stable within the idempotency bucket and always 30-60 minutes ahead.
		const expiresAt = (checkoutBucket + 2) * 30 * 60;
		const idempotencyKey = await stripeCheckoutIdempotencyKey({
			organizationId,
			planVersionId: plan.id,
			priceId,
			overagePriceId,
			interval: input.interval,
			successUrl,
			cancelUrl,
			nowMs: checkoutNowMs,
		});
		const session = await stripe.checkout.sessions.create(
			{
				mode: "subscription",
				...customerParams,
				client_reference_id: organizationId,
				line_items: lineItems,
				success_url: successUrl,
				cancel_url: cancelUrl,
				expires_at: expiresAt,
				metadata: {
					organizationId,
					tier: input.tier,
					planVersionId: plan.id,
					stripeEnvironment,
				},
				subscription_data: {
					metadata: {
						organizationId,
						tier: input.tier,
						planVersionId: plan.id,
						stripeEnvironment,
					},
				},
			},
			{ idempotencyKey },
		);

		if (!session.url) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to create checkout session",
			});
		}

		return {
			checkoutUrl: session.url,
			sessionId: session.id,
			stripeEnvironment,
		};
	});

const createInferenceCapacityCheckoutContract =
	os.createInferenceCapacityCheckout
		.use(withAuth)
		.use(withFleetAuthority)
		.handler(async ({ context, input }) => {
			requireManagedSettlement(context);
			requireOrganizationBillingAuthority(context);
			const { env, organizationId } = context;
			if (!organizationId) {
				throw new ORPCError("UNAUTHORIZED", { message: "No organization" });
			}
			const stripeEnvironment = resolveStripeEnvironment(env);
			const now = new Date();
			const pack = await getActiveInferenceCapacityPackByKey(context.db, {
				packKey: input.packKey,
				stripeEnvironment,
				now: now.toISOString(),
			});
			if (!pack) {
				throw new ORPCError("NOT_FOUND", {
					message: "Inference capacity pack is not available",
				});
			}
			const entitlement = await getBillingEntitlement(
				context.db,
				organizationId,
			);
			if (
				!entitlement ||
				!["trial", "active"].includes(entitlement.account.status)
			) {
				throw new ORPCError("FORBIDDEN", {
					message:
						"An active billing entitlement is required for a capacity top-up",
				});
			}
			const balance = await getBillingBalanceSnapshot(
				context.db,
				organizationId,
				now.toISOString(),
			);
			if (
				usesMonthlyInferenceCapacity({
					status: entitlement.account.status,
					allowOverage: entitlement.plan.allowOverage,
					billingMode: entitlement.account.billingMode,
					isSponsoredCustomer: balance?.isSponsoredCustomer ?? false,
					stripeCustomerId:
						entitlement.account.stripeEnvironment === stripeEnvironment
							? entitlement.account.stripeCustomerId
							: null,
				})
			) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"This account uses monthly metering; a daily capacity pack is unnecessary",
				});
			}
			const stripeConfig = getStripeEnvironmentConfig(env, stripeEnvironment);
			const stripe = await getStripe(stripeConfig.secretKey);
			if (!pack.stripeLookupKey) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: `Inference capacity pack ${pack.packKey} has no Stripe lookup key`,
				});
			}
			const priceId = await requireStripePriceByLookupKey(
				stripe,
				pack.stripeLookupKey,
			);
			const successUrl =
				input.successUrl ??
				buildBillingSettingsUrl({ osUrl: env.OS_URL, state: "topup-success" });
			const cancelUrl =
				input.cancelUrl ??
				buildBillingSettingsUrl({
					osUrl: env.OS_URL,
					state: "topup-cancelled",
				});
			const nowMs = now.getTime();
			const bucket = Math.floor(nowMs / (30 * 60 * 1_000));
			const customerParams: Record<string, unknown> = {};
			if (
				entitlement.account.stripeEnvironment === stripeEnvironment &&
				entitlement.account.stripeCustomerId
			) {
				customerParams.customer = entitlement.account.stripeCustomerId;
			} else {
				customerParams.customer_creation = "always";
			}
			const idempotencyKey = await inferenceCapacityCheckoutIdempotencyKey({
				organizationId,
				packVersionId: pack.id,
				priceId,
				stripeEnvironment,
				successUrl,
				cancelUrl,
				nowMs,
			});
			const capacityMetadata = {
				checkoutKind: "inference_capacity",
				organizationId,
				packVersionId: pack.id,
				stripeEnvironment,
			};
			const session = await stripe.checkout.sessions.create(
				{
					mode: "payment",
					allowed_payment_method_types: ["card"],
					...customerParams,
					client_reference_id: organizationId,
					line_items: [{ price: priceId, quantity: 1 }],
					success_url: successUrl,
					cancel_url: cancelUrl,
					expires_at: (bucket + 2) * 30 * 60,
					metadata: capacityMetadata,
					payment_intent_data: { metadata: capacityMetadata },
				},
				{ idempotencyKey },
			);
			if (!session.url) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message: "Failed to create inference capacity checkout session",
				});
			}
			return {
				checkoutUrl: session.url,
				sessionId: session.id,
				stripeEnvironment,
			};
		});

// =============================================================================
// CREATE CUSTOMER PORTAL SESSION
// =============================================================================

const createPortalContract = os.createPortal
	.use(withAuth)
	.use(withFleetAuthority)
	.handler(async ({ context, input }) => {
		requireManagedSettlement(context);
		const { env, organizationId } = context;
		if (!organizationId) {
			throw new ORPCError("UNAUTHORIZED", { message: "No organization" });
		}

		const stripeEnvironment = resolveStripeEnvironment(env);
		const stripeConfig = getStripeEnvironmentConfig(env, stripeEnvironment);
		const entitlement = await getBillingEntitlement(context.db, organizationId);
		if (
			!entitlement?.account.stripeCustomerId ||
			entitlement.account.stripeEnvironment !== stripeEnvironment
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "No active subscription. Subscribe first.",
			});
		}

		const stripe = await getStripe(stripeConfig.secretKey);

		const portalSession = await stripe.billingPortal.sessions.create({
			customer: entitlement.account.stripeCustomerId,
			configuration: stripeConfig.portalConfigurationId,
			return_url:
				input.returnUrl ?? buildBillingSettingsUrl({ osUrl: env.OS_URL }),
		});

		return { portalUrl: portalSession.url, stripeEnvironment };
	});

const listProviderCapacitySponsorshipsContract =
	os.listProviderCapacitySponsorships
		.use(withAuth)
		.use(withFleetAuthority)
		.use(withAuthorization("billing:read", "billing:read"))
		.handler(async ({ context }) => {
			if (!context.organizationId) {
				throw new ORPCError("UNAUTHORIZED", { message: "No organization" });
			}
			const now = new Date().toISOString();
			const sponsorships = await listProviderCapacitySponsorships(
				context.db,
				context.organizationId,
			);
			const stripeEnvironment = resolveStripeEnvironment(context.env);
			const [provider, providerPolicies] = await Promise.all([
				getInferenceCapacityDailyOverview(context.db, {
					organizationId: context.organizationId,
					stripeEnvironment,
					now,
				}),
				getEffectiveInferencePolicies(context.db, context.organizationId),
			]);
			return {
				data: await Promise.all(
					sponsorships.map(async (sponsorship) => {
						const customer = await getInferenceCapacityDailyOverview(
							context.db,
							{
								organizationId: sponsorship.customerOrganizationId,
								stripeEnvironment,
								now,
							},
						);
						const transfersUsed = sponsorship.policy
							? await countSponsoredCapacityTransfers(context.db, {
									customerOrganizationId: sponsorship.customerOrganizationId,
									providerInstallationId: sponsorship.installationId,
									budgetRevision: sponsorship.policy.budgetRevision,
									budgetDay: customer.budgetDay,
									stripeEnvironment,
								})
							: 0;
						return {
							...sponsorship,
							readiness: resolveSponsorshipReadiness({
								policy: sponsorship.policy,
								provider,
								customer,
								providerPolicyAvailable: providerPolicies !== null,
								providerDailyTokenLimit:
									providerPolicies?.organization.dailyTokenLimit ?? null,
								providerDailySpendLimitMicros:
									providerPolicies?.organization.dailySpendLimitMicros ?? null,
								transfersUsed,
							}),
						};
					}),
				),
			};
		});

const setProviderCapacitySponsorshipContract = os.setProviderCapacitySponsorship
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ context, input }) => {
		if (!context.organizationId) {
			throw new ORPCError("UNAUTHORIZED", { message: "No organization" });
		}
		requireOrganizationBillingAuthority(context);
		const sponsorship = await setProviderCapacitySponsorship(context.db, {
			providerOrganizationId: context.organizationId,
			installationId: input.installationId,
			policy: input.policy,
		});
		if (!sponsorship) {
			throw new ORPCError("NOT_FOUND", {
				message: "Provider installation not found",
			});
		}
		return sponsorship;
	});

const getOverviewContract = os.getOverview
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:read", "billing:read"))
	.handler(async ({ context }) => {
		requireManagedSettlement(context);
		const { env, organizationId } = context;
		if (!organizationId) {
			throw new ORPCError("UNAUTHORIZED", { message: "No organization" });
		}
		const now = new Date().toISOString();
		const stripeEnvironment = resolveStripeEnvironment(env);
		const [entitlement, snapshot, seoCredits, policy, capacity, packs] =
			await Promise.all([
				getBillingEntitlement(context.db, organizationId),
				getBillingBalanceSnapshot(context.db, organizationId, now),
				getBillingServiceCreditSnapshot(context.db, organizationId, "seo", now),
				getEffectiveInferencePolicies(context.db, organizationId),
				getInferenceCapacityDailyOverview(context.db, {
					organizationId,
					stripeEnvironment,
					now,
				}),
				listActiveInferenceCapacityPacks(context.db, {
					stripeEnvironment,
					now,
				}),
			]);
		if (!entitlement || !snapshot || !policy) {
			throw new ORPCError("NOT_FOUND", {
				message: "Billing account is not configured",
			});
		}
		const workstationCostCoverage = await getWorkstationCostCoverage(
			context.db,
			{
				organizationId,
				periodStart: snapshot.periodStart,
				periodEnd: snapshot.periodEnd,
			},
		);
		const period = await getBillingUsagePeriod(
			context.db,
			organizationId,
			snapshot.periodStart,
		);
		const baseDailyTokenLimit = Math.max(
			0,
			policy.organization.dailyTokenLimit ??
				entitlement.plan.defaultDailyTokenLimit,
		);
		const baseDailySpendLimitMicros =
			policy.organization.dailySpendLimitMicros === undefined
				? null
				: Math.max(0, policy.organization.dailySpendLimitMicros);
		const capacityLedger = await getInferenceCapacityLedger(context.db, {
			organizationId,
			stripeEnvironment,
			now,
			baseDailyTokenLimit,
			baseDailySpendLimitMicros,
		});
		const effectiveTokens = baseDailyTokenLimit + capacity.allocatedTokens;
		const effectiveSpend =
			baseDailySpendLimitMicros === null
				? null
				: baseDailySpendLimitMicros + capacity.allocatedSpendMicros;
		const monthlyMetered = usesMonthlyInferenceCapacity({
			status: snapshot.status,
			allowOverage: snapshot.allowOverage,
			billingMode: snapshot.billingMode,
			isSponsoredCustomer: snapshot.isSponsoredCustomer,
			stripeCustomerId:
				entitlement.account.stripeEnvironment === stripeEnvironment
					? snapshot.stripeCustomerId
					: null,
		});
		// Same rule as the admission gate: a second copy of the rules drifted and
		// reported `available: true` for an organization the gate denied.
		const blockingReason = billingBlockingReason({
			status: snapshot.status,
			now,
			periodStart: snapshot.periodStart,
			periodEnd: snapshot.periodEnd,
			allowOverage: snapshot.allowOverage,
			remainingIncludedTokens: snapshot.remainingIncludedTokens,
			billingMode: snapshot.billingMode,
			isSponsoredCustomer: snapshot.isSponsoredCustomer,
			stripeCustomerId:
				entitlement.account.stripeEnvironment === stripeEnvironment
					? snapshot.stripeCustomerId
					: null,
			availableCreditMicros: snapshot.availableCreditMicros,
			hardSpendLimitMicros: snapshot.hardSpendLimitMicros,
			customerChargeMicros: snapshot.customerChargeMicros,
			reservedChargeMicros: snapshot.reservedChargeMicros,
			estimatedChargeMicros: incrementalOverageChargeMicros({
				includedTokens: snapshot.includedTokens,
				usedTokens: snapshot.usedTokens,
				reservedTokens: snapshot.reservedTokens,
				estimatedTokens: NOMINAL_TURN_TOKENS,
				overageUnitTokens: entitlement.plan.overageUnitTokens,
				overageUnitPriceMicros: entitlement.plan.overageUnitPriceMicros,
			}),
			effectiveDailyTokens: effectiveTokens,
			effectiveDailySpendMicros: effectiveSpend,
			usedDailyTokens: capacity.usedTokens,
			usedDailySpendMicros: capacity.usedSpendMicros,
			// The console answers "could a turn run right now?", not "may this
			// exact request proceed", so it asks about a representative turn.
			estimatedTokens: NOMINAL_TURN_TOKENS,
		});
		const unblockAction =
			blockingReason === "inference_capacity_exhausted" && packs.length > 0
				? ("top_up" as const)
				: blockingReason === "monthly_allowance_exhausted"
					? ("upgrade" as const)
					: blockingReason === "subscription_inactive" ||
						  blockingReason === "payment_required"
						? ("manage_payment" as const)
						: ("none" as const);
		const nextMidnight = new Date(`${capacity.budgetDay}T00:00:00.000Z`);
		nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
		return {
			stripeEnvironment,
			workstationCostCoverage,
			snapshot: {
				status: snapshot.status,
				billingMode: snapshot.billingMode,
				planKey: snapshot.planKey,
				planVersion: snapshot.planVersion,
				periodStart: snapshot.periodStart,
				periodEnd: snapshot.periodEnd,
				includedTokens: snapshot.includedTokens,
				usedTokens: snapshot.usedTokens,
				reservedTokens: snapshot.reservedTokens,
				remainingIncludedTokens: snapshot.remainingIncludedTokens,
				creditBalanceMicros: snapshot.creditBalanceMicros,
				reservedChargeMicros: snapshot.reservedChargeMicros,
				availableCreditMicros: snapshot.availableCreditMicros,
				customerChargeMicros: snapshot.customerChargeMicros,
				hardSpendLimitMicros: snapshot.hardSpendLimitMicros,
				allowOverage: snapshot.allowOverage,
				stripeCustomerId:
					entitlement.account.stripeEnvironment === stripeEnvironment
						? snapshot.stripeCustomerId
						: null,
			},
			plan: {
				name: entitlement.plan.name,
				currency: entitlement.plan.currency,
				monthlyPriceMicros: entitlement.plan.monthlyPriceMicros,
				annualPriceMicros: entitlement.plan.annualPriceMicros,
				includedMonthlyCreditMicros:
					entitlement.plan.includedMonthlyCreditMicros,
				overageUnitTokens: entitlement.plan.overageUnitTokens,
				overageUnitPriceMicros: entitlement.plan.overageUnitPriceMicros,
				maxTedis: entitlement.plan.maxTedis,
				maxCronJobsPerTedi: entitlement.plan.maxCronJobsPerTedi,
				maxIterationsPerTask: entitlement.plan.maxIterationsPerTask,
				defaultDailyTokenLimit: entitlement.plan.defaultDailyTokenLimit,
				defaultDailyMessageLimit: entitlement.plan.defaultDailyMessageLimit,
			},
			period: period
				? {
						usedInputTokens: period.usedInputTokens,
						usedOutputTokens: period.usedOutputTokens,
						meteredOverageTokens: period.meteredOverageTokens,
						providerCostMicros: period.providerCostMicros,
						customerChargeMicros: period.customerChargeMicros,
						creditAppliedMicros: period.creditAppliedMicros,
					}
				: null,
			inferenceCapacity: {
				available: blockingReason === null,
				monthlyMetered,
				blockingReason,
				unblockAction,
				budgetDay: capacity.budgetDay,
				baseDailyTokenLimit,
				baseDailySpendLimitMicros,
				allocatedTokens: capacity.allocatedTokens,
				allocatedSpendCapacityMicros: capacity.allocatedSpendMicros,
				sponsoredTokens: capacity.sponsoredTokens,
				sponsoredSpendCapacityMicros: capacity.sponsoredSpendMicros,
				usedTokens: capacity.usedTokens,
				usedSpendMicros: capacity.usedSpendMicros,
				remainingTokens: Math.max(0, effectiveTokens - capacity.usedTokens),
				remainingSpendMicros:
					effectiveSpend === null
						? null
						: Math.max(0, effectiveSpend - capacity.usedSpendMicros),
				expiresAt: capacity.earliestExpiryAt ?? nextMidnight.toISOString(),
				allocations: capacityLedger.allocations,
				tediOverflow: capacityLedger.tediOverflow,
				packs: (monthlyMetered ? [] : packs).map((pack) => ({
					packKey: pack.packKey,
					name: pack.name,
					tokens: pack.tokenAmount,
					spendCapacityMicros: pack.spendAmountMicros,
					priceMicros: pack.priceMicros,
					currency: pack.currency,
				})),
			},
			serviceCredits: {
				seo: seoCredits,
			},
		};
	});

const listPlansContract = os.listPlans
	.use(withAuth)
	.use(withFleetAuthority)
	.handler(async ({ context }) => {
		requireManagedSettlement(context);
		const stripeEnvironment = resolveStripeEnvironment(context.env);
		const now = new Date().toISOString();
		const plans = await Promise.all(
			(["growth", "business", "enterprise"] as const).map((planKey) =>
				getActiveBillingPlanByKey(context.db, planKey, now),
			),
		);
		return {
			stripeEnvironment,
			plans: plans.flatMap((plan) =>
				plan
					? [
							{
								planKey: plan.planKey as "growth" | "business" | "enterprise",
								version: plan.version,
								name: plan.name,
								currency: plan.currency,
								monthlyPriceMicros: plan.monthlyPriceMicros,
								annualPriceMicros: plan.annualPriceMicros,
								includedMonthlyTokens: plan.includedMonthlyTokens,
								overageUnitTokens: plan.overageUnitTokens,
								overageUnitPriceMicros: plan.overageUnitPriceMicros,
								maxTedis: plan.maxTedis,
								maxCronJobsPerTedi: plan.maxCronJobsPerTedi,
								maxIterationsPerTask: plan.maxIterationsPerTask,
							},
						]
					: [],
			),
		};
	});

const recordVoiceProviderUsageContract = os.recordVoiceProviderUsage
	.use(withServiceAuth)
	.use(withFleetAuthority)
	.handler(async ({ context, input }) =>
		recordVoiceProviderUsage(resolveFleetAuthorityDb(context.env), input),
	);

const grantCreditContract = os.grantCredit
	.use(withAuth)
	.use(withFleetAuthority)
	.handler(async ({ context, input }) => {
		const actor = requirePlatformBillingAuthority(context);
		const now = new Date().toISOString();
		const entry = await grantBillingCredit(context.db, {
			id: crypto.randomUUID(),
			organizationId: input.organizationId,
			amountMicros: input.amountMicros,
			sourceType: "operator_grant",
			sourceRef: input.sourceRef,
			idempotencyKey: input.idempotencyKey,
			expiresAt: input.expiresAt,
			description: input.description,
			metadata: { actor },
			createdAt: now,
		});
		const snapshot = await getBillingBalanceSnapshot(
			context.db,
			input.organizationId,
			now,
		);
		if (!snapshot) {
			throw new ORPCError("NOT_FOUND", {
				message: "Billing account is not configured",
			});
		}
		return {
			entryId: entry.id,
			creditBalanceMicros: snapshot.creditBalanceMicros,
		};
	});

const restoreDailyCapacityContract = os.restoreDailyCapacity
	.use(withAuth)
	.handler(async ({ context }) => {
		const { organizationId } = context;
		if (!organizationId) {
			throw new ORPCError("UNAUTHORIZED", { message: "No organization" });
		}
		const actor = requireOrganizationBillingAuthority(context);
		const now = new Date().toISOString();
		const budgetDay = now.slice(0, 10);
		const stripeEnvironment = resolveStripeEnvironment(context.env);
		const totals = await getActiveCapacityAllocationTotals(context.db, {
			organizationId,
			budgetDay,
			stripeEnvironment,
			now,
		});
		// Only ever cancels a debit. A day already at or above base restores
		// nothing, so this can never lift a ceiling past what the plan includes.
		const restoredTokens = Math.max(0, -totals.tokenAmount);
		const restoredSpendMicros = Math.max(0, -totals.spendAmountMicros);
		if (restoredTokens === 0 && restoredSpendMicros === 0) {
			return {
				budgetDay,
				restoredTokens: 0,
				restoredSpendMicros: 0,
				allocationId: null,
			};
		}
		const expiresAt = new Date(
			Date.parse(`${budgetDay}T00:00:00.000Z`) + 86_400_000,
		).toISOString();
		const allocation = await recordCapacityAllocation(context.db, {
			id: crypto.randomUUID(),
			organizationId,
			budgetDay,
			tokenAmount: restoredTokens,
			spendAmountMicros: restoredSpendMicros,
			sourceType: "self_service_restore",
			sourceRef: actor,
			// One restore per organization per day: a second call is the same
			// request, not a second grant.
			idempotencyKey: `restore:${organizationId}:${budgetDay}`,
			stripeEnvironment,
			expiresAt,
			metadata: {
				actor,
				restoredFrom: {
					tokenAmount: totals.tokenAmount,
					spendAmountMicros: totals.spendAmountMicros,
					sponsoredTokenAmount: totals.sponsoredTokenAmount,
					sponsoredSpendAmountMicros: totals.sponsoredSpendAmountMicros,
				},
			},
			createdAt: now,
		});
		return {
			budgetDay,
			restoredTokens,
			restoredSpendMicros,
			allocationId: allocation.id,
		};
	});

const correctBillingPeriodContract = os.correctBillingPeriod
	.use(withAuth)
	.use(withFleetAuthority)
	.handler(async ({ context, input }) => {
		const actor = requirePlatformBillingAuthority(context);
		const account = await correctBillingAccountPeriod(context.db, {
			organizationId: input.organizationId,
			periodStart: input.periodStart,
			periodEnd: input.periodEnd,
			now: new Date().toISOString(),
			reason: `${input.reason} (by ${actor})`,
		});
		return {
			organizationId: account.organizationId,
			periodStart: account.periodStart,
			periodEnd: account.periodEnd,
			entitlementVersion: account.entitlementVersion,
		};
	});

const grantInferenceCapacityContract = os.grantInferenceCapacity
	.use(withAuth)
	.use(withFleetAuthority)
	.handler(async ({ context, input }) => {
		const actor = requirePlatformBillingAuthority(context);
		const now = new Date().toISOString();
		const stripeEnvironment = resolveStripeEnvironment(context.env);
		const budgetDay = now.slice(0, 10);
		const expiresAt = new Date(
			Date.parse(`${budgetDay}T00:00:00.000Z`) + 86_400_000,
		).toISOString();
		const allocation = await recordCapacityAllocation(context.db, {
			id: crypto.randomUUID(),
			organizationId: input.organizationId,
			budgetDay,
			tokenAmount: input.tokenAmount,
			spendAmountMicros: input.spendAmountMicros,
			sourceType: "operator_grant",
			sourceRef: actor,
			idempotencyKey: input.idempotencyKey,
			stripeEnvironment,
			expiresAt,
			metadata: { actor, description: input.description },
			createdAt: now,
		});
		return {
			allocationId: allocation.id,
			budgetDay: allocation.budgetDay,
			expiresAt: allocation.expiresAt,
			stripeEnvironment: allocation.stripeEnvironment,
		};
	});

const grantServiceCreditsContract = os.grantServiceCredits
	.use(withAuth)
	.use(withFleetAuthority)
	.handler(async ({ context, input }) => {
		const actor = requirePlatformBillingAuthority(context);
		const now = new Date().toISOString();
		const entry = await grantBillingServiceCredits(context.db, {
			id: crypto.randomUUID(),
			organizationId: input.organizationId,
			serviceKey: input.serviceKey,
			amountCredits: input.amountCredits,
			sourceType: "operator_grant",
			sourceRef: input.sourceRef,
			idempotencyKey: input.idempotencyKey,
			expiresAt: input.expiresAt,
			description: input.description,
			metadata: { actor },
			createdAt: now,
		});
		const snapshot = await getBillingServiceCreditSnapshot(
			context.db,
			input.organizationId,
			input.serviceKey,
			now,
		);
		if (!snapshot) {
			throw new ORPCError("NOT_FOUND", {
				message: "Service credit entitlement is not configured",
			});
		}
		return { entryId: entry.id, snapshot };
	});

const setServiceCreditControlsContract = os.setServiceCreditControls
	.use(withAuth)
	.handler(async ({ context, input }) => {
		const { organizationId } = context;
		if (!organizationId) {
			throw new ORPCError("UNAUTHORIZED", { message: "No organization" });
		}
		const actor = requireOrganizationBillingAuthority(context);
		const now = new Date().toISOString();
		await setBillingServiceCreditControls(context.db, {
			organizationId,
			serviceKey: input.serviceKey,
			enabled: input.enabled,
			monthlyCreditLimit: input.monthlyCreditLimit,
			perTediMonthlyLimit: input.perTediMonthlyLimit,
			monthlyProviderCostLimitMicros: input.monthlyProviderCostLimitMicros,
			updatedBy: actor,
			now,
		});
		const snapshot = await getBillingServiceCreditSnapshot(
			context.db,
			organizationId,
			input.serviceKey,
			now,
		);
		if (!snapshot) {
			throw new ORPCError("NOT_FOUND", {
				message: "Service credit entitlement is not configured",
			});
		}
		return { snapshot };
	});

const recordProviderReconciliationContract = os.recordProviderReconciliation
	.use(withAuth)
	.use(withFleetAuthority)
	.handler(async ({ context, input }) => {
		const actor = requirePlatformBillingAuthority(context);
		const row = await recordBillingProviderReconciliation(
			resolveFleetAuthorityDb(context.env),
			{
				id: crypto.randomUUID(),
				provider: input.provider,
				providerResource: input.providerResource,
				periodStart: input.periodStart,
				periodEnd: input.periodEnd,
				providerCostMicros: input.providerCostMicros,
				evidenceRef: input.evidenceRef,
				reconciledBy: actor,
				approved: input.approved,
				metadata:
					input.metadata === undefined
						? undefined
						: toJsonRecord(input.metadata),
				now: new Date().toISOString(),
			},
		);
		return {
			id: row.id,
			status: row.status,
			ledgerCostMicros: row.ledgerCostMicros,
			providerCostMicros: row.providerCostMicros,
			varianceMicros: row.varianceMicros,
			usageRowCount: row.usageRowCount,
			reconciledAt: row.reconciledAt,
		};
	});

// =============================================================================
// EXPORT
// =============================================================================

const listProviderModelRatesContract = os.listProviderModelRates
	.use(withAuth)
	.use(withFleetAuthority)
	.handler(async ({ context, input }) => {
		requirePlatformBillingAuthority(context);
		return {
			rates: await listProviderModelRates(
				resolveFleetAuthorityDb(context.env),
				input,
			),
		};
	});
const publishProviderModelRateContract = os.publishProviderModelRate
	.use(withAuth)
	.use(withFleetAuthority)
	.handler(async ({ context, input }) => {
		const publishedBy = requirePlatformBillingAuthority(context);
		const row = await publishProviderModelRate(
			resolveFleetAuthorityDb(context.env),
			{
				...input,
				id: crypto.randomUUID(),
				publishedBy,
				publishedAt: new Date().toISOString(),
			},
		);
		if (!row)
			throw new ORPCError("CONFLICT", {
				message:
					"Rate publication conflicts with an existing version, correction leaf, or publication/verification time",
			});
		return row;
	});

const recordHistoricalExposureContract = os.recordHistoricalExposure
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ context, input }) =>
		(
			await import("./billing/historical-exposure")
		).recordHistoricalExposureHandler(context, input),
	);
const listHistoricalExposuresContract = os.listHistoricalExposures
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:manage", "billing:read"))
	.handler(async ({ context, input }) =>
		(
			await import("./billing/historical-exposure")
		).listHistoricalExposuresHandler(context, input),
	);
const recordHistoricalFreshDecisionContract = os.recordHistoricalFreshDecision
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ context, input }) =>
		(
			await import("./billing/historical-exposure")
		).recordHistoricalFreshDecisionHandler(context, input),
	);
const revokeHistoricalFreshDecisionContract = os.revokeHistoricalFreshDecision
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ context, input }) =>
		(
			await import("./billing/historical-exposure")
		).revokeHistoricalFreshDecisionHandler(context, input),
	);
const authorizeHistoricalFreshExecutionContract =
	os.authorizeHistoricalFreshExecution
		.use(withAuth)
		.use(withFleetAuthority)
		.use(withAuthorization("billing:manage", "billing:write"))
		.handler(async ({ context, input }) =>
			(
				await import("./billing/historical-exposure")
			).authorizeHistoricalFreshExecutionHandler(context, input),
		);
const revokeHistoricalFreshExecutionContract = os.revokeHistoricalFreshExecution
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ context, input }) =>
		(
			await import("./billing/historical-exposure")
		).revokeHistoricalFreshExecutionHandler(context, input),
	);
export const billingContractRouter = os.router({
	authorizeHistoricalFreshExecution: authorizeHistoricalFreshExecutionContract,
	revokeHistoricalFreshExecution: revokeHistoricalFreshExecutionContract,
	recordHistoricalExposure: recordHistoricalExposureContract,
	listHistoricalExposures: listHistoricalExposuresContract,
	recordHistoricalFreshDecision: recordHistoricalFreshDecisionContract,
	revokeHistoricalFreshDecision: revokeHistoricalFreshDecisionContract,
	listProviderModelRates: listProviderModelRatesContract,
	publishProviderModelRate: publishProviderModelRateContract,
	createCheckout: createCheckoutContract,
	createInferenceCapacityCheckout: createInferenceCapacityCheckoutContract,
	listProviderCapacitySponsorships: listProviderCapacitySponsorshipsContract,
	setProviderCapacitySponsorship: setProviderCapacitySponsorshipContract,
	createPortal: createPortalContract,
	getOverview: getOverviewContract,
	listPlans: listPlansContract,
	recordVoiceProviderUsage: recordVoiceProviderUsageContract,
	grantCredit: grantCreditContract,
	correctBillingPeriod: correctBillingPeriodContract,
	restoreDailyCapacity: restoreDailyCapacityContract,
	grantInferenceCapacity: grantInferenceCapacityContract,
	grantServiceCredits: grantServiceCreditsContract,
	setServiceCreditControls: setServiceCreditControlsContract,
	recordProviderReconciliation: recordProviderReconciliationContract,
});
