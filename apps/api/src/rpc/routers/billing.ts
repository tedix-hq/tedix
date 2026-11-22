import { baseErrorConstructors } from "@tedix/api-contract/errors";
import {
	listDailyCreditUsage,
	listPurchasedCreditPacks,
} from "@tedix/db/queries/billing/dashboard";
import { getWorkstationCostCoverage } from "@tedix/db/queries/billing/provider-usage";
/**
 * Billing Router
 * Stripe Checkout, Customer Portal, Tedix credits and the billing overview.
 * Usage is billed and limited in Tedix credits (1 credit = EUR 0.01) from one
 * monthly pool per organization.
 */

/// <reference path="../../../worker-configuration.d.ts" />

import { implement } from "@orpc/server";
import { checkoutBusinessTermsParams } from "../../lib/checkout-business-terms";
import { billingContract } from "@tedix/api-contract/contracts/billing";
import type {
	BillingCredits,
	CreditRefusalCode,
} from "@tedix/api-contract/schemas/billing";
import {
	monthlyAllowanceCredits,
	TOP_UP_VALID_MONTHS,
} from "@tedix/api-contract/utils/credit-pricing";
import { assignInternalPlan } from "@tedix/db/queries/billing/internal-plan";
import { getOrganizationFeatures } from "@tedix/db/queries/organizations";
import {
	getRuntimeEntitlement,
	runtimeEntitlementIsActive,
} from "@tedix/db/queries/runtime-entitlements";
import {
	listProviderModelRates,
	publishProviderModelRate,
} from "@tedix/db/queries/billing/provider-model-rates";
import { isPlatformPrincipal } from "@tedix/auth/types";
import {
	type CreditPoolSnapshot,
	creditRefusalReason,
	getCreditPoolSnapshot,
	grantTopUpCredits,
	listActiveTopUpPacks,
	listCreditNotices,
	listCreditSubjectUsage,
	setAccountCredits,
	setCreditCaps,
	setPayAsYouGo,
} from "@tedix/db/queries/billing/credit-pool";
import { recordBillingProviderReconciliation } from "@tedix/db/queries/billing/health";
import {
	correctBillingAccountPeriod,
	getActiveBillingPlanByKey,
	getBillingEntitlement,
} from "@tedix/db/queries/billing/plans";
import {
	getBillingServiceCreditSnapshot,
	setBillingServiceCreditControls,
} from "@tedix/db/queries/billing-service-credits";
import { getMembersByOrganization } from "@tedix/db/queries/organization-members";
import { getTedisByOrganization } from "@tedix/db/queries/tedis";
import { BILLING_PLAN_KEYS } from "@tedix/db/schema/billing";
import { toJsonRecord } from "@tedix/db/utils/json";
import { buildBillingSettingsUrl } from "../../lib/billing-urls";
import { resolveBillingSettlementMode } from "../../lib/billing-settlement-mode";
import { resolveFleetAuthorityDb } from "../../lib/fleet-authority";
import { getStripe } from "../../lib/stripe";
import {
	planSellsPayAsYouGo,
	STRIPE_CREDIT_PAYG_LOOKUP_KEY,
	stripeCheckoutIdempotencyKey,
	stripePlanPriceLookupKey,
} from "../../lib/stripe-billing";
import {
	getStripeEnvironmentConfig,
	resolveStripeEnvironment,
} from "../../lib/stripe-environment";
import { recordVoiceProviderUsage } from "../../lib/voice-provider-usage";
import {
	AUTHZ,
	type BaseContext,
	withAuth,
	withAuthorization,
	withFleetAuthority,
	withServiceAuth,
} from "../orpc";

const os = implement(billingContract).$context<BaseContext>();

/**
 * Credits a typical AI turn needs. The overview answers "could a turn run
 * right now?", not whether one exact request fits, so it asks about one
 * representative call (EUR 0.50 of credits).
 */
const NOMINAL_TURN_CREDITS = 50;

async function topUpCheckoutIdempotencyKey(input: {
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
	return `tedix:credit-top-up-checkout:${Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("")}`;
}

function requireManagedSettlement(context: BaseContext): void {
	if (resolveBillingSettlementMode(context.env) !== "managed") {
		throw baseErrorConstructors.FORBIDDEN({
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
		throw baseErrorConstructors.INTERNAL_SERVER_ERROR({
			message: `Stripe has no active price with lookup key ${lookupKey}`,
		});
	}
	return price.id;
}

/**
 * Platform billing authority mints spending power: it grants top-up credits,
 * sets an organization's included credits, corrects a billing period and
 * records provider reconciliation. `isPlatformPrincipal` answers true for a
 * TEDI token carrying `platform:admin` in `tediScopes`, which made a second
 * door into the one thing VISION.md says stays owner-held.
 *
 * A tedi is therefore never platform billing authority, whatever its scopes
 * say. Human, operator API key, M2M and service-binding principals are
 * unchanged; these authority procedures have no tedi-runtime caller.
 */
export function requirePlatformBillingAuthority(context: BaseContext): string {
	if (context.authType === "tedi") {
		throw baseErrorConstructors.FORBIDDEN({
			message:
				"Platform billing authority is never held by a tedi principal; credits stay owner-held",
		});
	}
	if (!isPlatformPrincipal(context)) {
		throw baseErrorConstructors.FORBIDDEN({
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
		throw baseErrorConstructors.FORBIDDEN({
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

/** The credits section the billing pages show, from one pool snapshot. */
async function readBillingCredits(
	context: BaseContext,
	organizationId: string,
	snapshot: CreditPoolSnapshot,
): Promise<BillingCredits> {
	const [notices, tediUsage, memberUsage, tedis, members] = await Promise.all([
		listCreditNotices(context.db, {
			organizationId,
			periodStart: snapshot.periodStart,
		}),
		listCreditSubjectUsage(context.db, {
			organizationId,
			periodStart: snapshot.periodStart,
			subjectKind: "tedi",
		}),
		listCreditSubjectUsage(context.db, {
			organizationId,
			periodStart: snapshot.periodStart,
			subjectKind: "member",
		}),
		getTedisByOrganization(context.db, organizationId),
		getMembersByOrganization(context.db, organizationId, { status: "active" }),
	]);
	const tediRows = new Map(tediUsage.map((row) => [row.subjectKey, row]));
	const memberRows = new Map(memberUsage.map((row) => [row.subjectKey, row]));
	// Members are keyed by their sign-in subject, the identity every caller
	// carries when it starts a code run or a service operation.
	const memberNames = new Map(
		members.map((member) => [
			member.descopeUserId,
			member.name?.trim() || member.email,
		]),
	);
	return {
		periodStart: snapshot.periodStart,
		periodEnd: snapshot.periodEnd,
		includedCredits: snapshot.includedCredits,
		usedCredits: snapshot.usedCredits,
		remainingIncludedCredits: snapshot.remainingIncludedCredits,
		topUpCredits: snapshot.topUpCredits,
		breakdown: snapshot.breakdown,
		notices,
		payAsYouGo: {
			enabled: snapshot.payAsYouGo.enabled,
			monthlyCapMicros: snapshot.payAsYouGo.monthlyCapMicros,
			spentMicros: snapshot.payAsYouGo.spentMicros,
		},
		tedis: [
			...tedis.map((tedi) => ({
				tediId: tedi.id,
				name: tedi.name,
				usedCredits: tediRows.get(tedi.id)?.usedCredits ?? 0,
				monthlyCapCredits: tediRows.get(tedi.id)?.monthlyCapCredits ?? null,
			})),
			// Usage of a tedi retired since stays visible under its id.
			...tediUsage
				.filter((row) => !tedis.some((tedi) => tedi.id === row.subjectKey))
				.map((row) => ({
					tediId: row.subjectKey,
					name: row.subjectKey,
					usedCredits: row.usedCredits,
					monthlyCapCredits: row.monthlyCapCredits,
				})),
		],
		members: [
			...memberNames.keys(),
			...memberUsage
				.map((row) => row.subjectKey)
				.filter((key) => !memberNames.has(key)),
		].map((userId) => ({
			userId,
			name: memberNames.get(userId) ?? userId,
			usedCredits: memberRows.get(userId)?.usedCredits ?? 0,
			monthlyCapCredits: memberRows.get(userId)?.monthlyCapCredits ?? null,
		})),
	};
}

async function requireCreditPool(
	context: BaseContext,
	organizationId: string,
	now: string,
): Promise<CreditPoolSnapshot> {
	const snapshot = await getCreditPoolSnapshot(context.db, {
		organizationId,
		now,
	});
	if (!snapshot) {
		throw baseErrorConstructors.NOT_FOUND({
			message: "Billing account is not configured",
		});
	}
	return snapshot;
}

function unblockAction(
	reason: CreditRefusalCode | null,
	snapshot: CreditPoolSnapshot,
): "none" | "top_up" | "upgrade" | "manage_payment" {
	if (reason === "monthly_credit_limit_reached")
		return snapshot.planKey === "starter" ? "upgrade" : "top_up";
	if (reason === "subscription_inactive") return "manage_payment";
	return "none";
}

// =============================================================================
// CREATE CHECKOUT SESSION
// =============================================================================

const createCheckoutContract = os.createCheckout
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ context, input }) => {
		requireManagedSettlement(context);
		requireOrganizationBillingAuthority(context);
		const { env, organizationId } = context;
		if (!organizationId) {
			throw baseErrorConstructors.FORBIDDEN({ message: "No organization" });
		}

		const stripeEnvironment = resolveStripeEnvironment(env);
		const stripeConfig = getStripeEnvironmentConfig(env, stripeEnvironment);
		const stripe = await getStripe(stripeConfig.secretKey);
		const entitlement = await getBillingEntitlement(context.db, organizationId);
		if (!entitlement) {
			throw baseErrorConstructors.NOT_FOUND({
				message: "Billing account not found",
			});
		}

		const plan = await getActiveBillingPlanByKey(
			context.db,
			input.tier,
			new Date().toISOString(),
		);
		if (!plan) {
			throw baseErrorConstructors.BAD_REQUEST({
				message: `Invalid tier: ${input.tier}`,
			});
		}

		if (
			entitlement.account.stripeEnvironment === stripeEnvironment &&
			entitlement.account.stripeSubscriptionId &&
			["active", "trial", "past_due"].includes(entitlement.account.status)
		) {
			throw baseErrorConstructors.CONFLICT({
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

		// Base subscription, plus the metered pay-as-you-go credit price on a
		// plan that offers it. Nothing is metered until an admin opts in.
		const priceId = await requireStripePriceByLookupKey(
			stripe,
			stripePlanPriceLookupKey(plan.planKey, input.interval),
		);
		const lineItems: Array<{ price: string; quantity?: number }> = [
			{ price: priceId, quantity: 1 },
		];
		const payAsYouGoPriceId = planSellsPayAsYouGo(plan)
			? await requireStripePriceByLookupKey(
					stripe,
					STRIPE_CREDIT_PAYG_LOOKUP_KEY,
				)
			: null;
		if (payAsYouGoPriceId) {
			lineItems.push({ price: payAsYouGoPriceId });
		}

		const checkoutNowMs = Date.now();
		const checkoutBucket = Math.floor(checkoutNowMs / (30 * 60 * 1_000));
		// Stable within the idempotency bucket and always 30-60 minutes ahead.
		const expiresAt = (checkoutBucket + 2) * 30 * 60;
		const idempotencyKey = await stripeCheckoutIdempotencyKey({
			organizationId,
			planVersionId: plan.id,
			priceId,
			payAsYouGoPriceId,
			interval: input.interval,
			successUrl,
			cancelUrl,
			nowMs: checkoutNowMs,
		});
		const session = await stripe.checkout.sessions.create(
			{
				mode: "subscription",
				...customerParams,
				...checkoutBusinessTermsParams({
					hasExistingCustomer: "customer" in customerParams,
				}),
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
			throw baseErrorConstructors.INTERNAL_SERVER_ERROR({
				message: "Failed to create checkout session",
			});
		}

		return {
			checkoutUrl: session.url,
			sessionId: session.id,
			stripeEnvironment,
		};
	});

const createTopUpCheckoutContract = os.createTopUpCheckout
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ context, input }) => {
		requireManagedSettlement(context);
		requireOrganizationBillingAuthority(context);
		const { env, organizationId } = context;
		if (!organizationId) {
			throw baseErrorConstructors.FORBIDDEN({ message: "No organization" });
		}
		const stripeEnvironment = resolveStripeEnvironment(env);
		const now = new Date();
		const pack = (
			await listActiveTopUpPacks(context.db, {
				stripeEnvironment,
				now: now.toISOString(),
			})
		).find((candidate) => candidate.packKey === input.packKey);
		if (!pack) {
			throw baseErrorConstructors.NOT_FOUND({
				message: "Credit top-up pack is not available",
			});
		}
		const entitlement = await getBillingEntitlement(context.db, organizationId);
		if (
			!entitlement ||
			!["trial", "active"].includes(entitlement.account.status)
		) {
			throw baseErrorConstructors.FORBIDDEN({
				message: "An active billing account is required to buy credits",
			});
		}
		const stripeConfig = getStripeEnvironmentConfig(env, stripeEnvironment);
		const stripe = await getStripe(stripeConfig.secretKey);
		const priceId = await requireStripePriceByLookupKey(
			stripe,
			pack.stripeLookupKey,
		);
		const successUrl =
			input.successUrl ??
			buildBillingSettingsUrl({ osUrl: env.OS_URL, state: "topup-success" });
		const cancelUrl =
			input.cancelUrl ??
			buildBillingSettingsUrl({ osUrl: env.OS_URL, state: "topup-cancelled" });
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
		const idempotencyKey = await topUpCheckoutIdempotencyKey({
			organizationId,
			packVersionId: pack.id,
			priceId,
			stripeEnvironment,
			successUrl,
			cancelUrl,
			nowMs,
		});
		const topUpMetadata = {
			checkoutKind: "credit_top_up",
			organizationId,
			packVersionId: pack.id,
			stripeEnvironment,
		};
		const session = await stripe.checkout.sessions.create(
			{
				mode: "payment",
				allowed_payment_method_types: ["card"],
				...customerParams,
				...checkoutBusinessTermsParams({
					hasExistingCustomer: "customer" in customerParams,
				}),
				client_reference_id: organizationId,
				line_items: [{ price: priceId, quantity: 1 }],
				success_url: successUrl,
				cancel_url: cancelUrl,
				expires_at: (bucket + 2) * 30 * 60,
				metadata: topUpMetadata,
				payment_intent_data: { metadata: topUpMetadata },
			},
			{ idempotencyKey },
		);
		if (!session.url) {
			throw baseErrorConstructors.INTERNAL_SERVER_ERROR({
				message: "Failed to create credit top-up checkout session",
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
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ context, input }) => {
		requireManagedSettlement(context);
		requireOrganizationBillingAuthority(context);
		const { env, organizationId } = context;
		if (!organizationId) {
			throw baseErrorConstructors.FORBIDDEN({ message: "No organization" });
		}

		const stripeEnvironment = resolveStripeEnvironment(env);
		const stripeConfig = getStripeEnvironmentConfig(env, stripeEnvironment);
		const entitlement = await getBillingEntitlement(context.db, organizationId);
		if (
			!entitlement?.account.stripeCustomerId ||
			entitlement.account.stripeEnvironment !== stripeEnvironment
		) {
			throw baseErrorConstructors.BAD_REQUEST({
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

// =============================================================================
// CREDITS
// =============================================================================

function billingOrganization(context: BaseContext): string {
	requireManagedSettlement(context);
	if (!context.organizationId) {
		throw baseErrorConstructors.FORBIDDEN({ message: "No organization" });
	}
	return context.organizationId;
}

const DAY_MS = 86_400_000;

const getDailyUsageContract = os.getDailyUsage
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:read", "billing:read"))
	.handler(async ({ context, input }) => {
		const organizationId = billingOrganization(context);
		const now = new Date();
		const midnight = Date.UTC(
			now.getUTCFullYear(),
			now.getUTCMonth(),
			now.getUTCDate(),
		);
		const nowIso = now.toISOString();
		const snapshot = await requireCreditPool(context, organizationId, nowIso);
		const from =
			input.window === "month"
				? snapshot.periodStart
				: new Date(
						Math.max(
							Date.parse(snapshot.periodStart),
							midnight - (input.window === "30d" ? 29 : 6) * DAY_MS,
						),
					).toISOString();
		const to = snapshot.periodEnd < nowIso ? snapshot.periodEnd : nowIso;
		if (from >= to) return [];

		const rows = await listDailyCreditUsage(context.db, {
			organizationId,
			from,
			to,
			periodStart: snapshot.periodStart,
		});
		const allowance = monthlyAllowanceCredits(snapshot);
		const days = new Map<
			string,
			{
				day: string;
				aiPercent: number;
				codeRunPercent: number;
				toolPercent: number;
			}
		>();
		for (
			let at = Date.parse(from.slice(0, 10));
			at < Date.parse(to);
			at += DAY_MS
		) {
			const day = new Date(at).toISOString().slice(0, 10);
			days.set(day, { day, aiPercent: 0, codeRunPercent: 0, toolPercent: 0 });
		}
		for (const row of rows) {
			const day = days.get(row.day);
			if (!day || allowance === 0) continue;
			const key =
				row.kind === "ai"
					? "aiPercent"
					: row.kind === "code_run"
						? "codeRunPercent"
						: "toolPercent";
			day[key] = (row.credits * 100) / allowance;
		}
		return [...days.values()];
	});

const listTopUpPurchasesContract = os.listTopUpPurchases
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ context }) => {
		return listPurchasedCreditPacks(context.db, billingOrganization(context));
	});

async function getStripeBillingCustomer(context: BaseContext) {
	const organizationId = billingOrganization(context);
	const environment = resolveStripeEnvironment(context.env);
	const entitlement = await getBillingEntitlement(context.db, organizationId);
	const account = entitlement?.account;
	if (!account?.stripeCustomerId || account.stripeEnvironment !== environment)
		return null;
	const stripe = await getStripe(
		getStripeEnvironmentConfig(context.env, environment).secretKey,
	);
	return {
		stripe,
		customerId: account.stripeCustomerId,
		subscriptionId: account.stripeSubscriptionId,
	};
}

const getPaymentDetailsContract = os.getPaymentDetails
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ context }) => {
		const billing = await getStripeBillingCustomer(context);
		if (!billing) return { email: null, method: null };
		const { stripe, customerId, subscriptionId } = billing;
		const [customer, subscription] = await Promise.all([
			stripe.customers.retrieve(customerId, {
				expand: ["invoice_settings.default_payment_method"],
			}),
			subscriptionId
				? stripe.subscriptions.retrieve(subscriptionId, {
						expand: ["default_payment_method"],
					})
				: null,
		]);
		if (customer.deleted) return { email: null, method: null };
		const method =
			subscription?.default_payment_method ??
			customer.invoice_settings.default_payment_method;
		const paymentMethod = typeof method === "object" ? method : null;
		const card = paymentMethod?.card;
		const bankAccount =
			paymentMethod?.sepa_debit ??
			paymentMethod?.us_bank_account ??
			paymentMethod?.bacs_debit;
		return {
			email: customer.email,
			method: card
				? `${card.brand.toUpperCase()} ending in ${card.last4}`
				: bankAccount?.last4
					? `Bank account ending in ${bankAccount.last4}`
					: method || customer.default_source
						? "Payment method on file"
						: null,
		};
	});

const listInvoicesContract = os.listInvoices
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ context, input }) => {
		const billing = await getStripeBillingCustomer(context);
		if (!billing) return { invoices: [], nextCursor: null };
		const page = await billing.stripe.invoices.list({
			customer: billing.customerId,
			limit: 25,
			starting_after: input.cursor,
		});
		return {
			invoices: page.data
				.filter((invoice) => invoice.status !== "draft")
				.map((invoice) => ({
					id: invoice.id,
					number: invoice.number,
					issuedAt: new Date(
						(invoice.status_transitions.finalized_at ?? invoice.created) * 1000,
					).toISOString(),
					amountMinor: invoice.total,
					currency: invoice.currency,
					url: invoice.hosted_invoice_url ?? null,
				})),
			nextCursor: page.has_more ? (page.data.at(-1)?.id ?? null) : null,
		};
	});

const getOverviewContract = os.getOverview
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:read", "billing:read"))
	.handler(async ({ context }) => {
		requireManagedSettlement(context);
		const { env, organizationId } = context;
		if (!organizationId) {
			throw baseErrorConstructors.FORBIDDEN({ message: "No organization" });
		}
		const now = new Date().toISOString();
		const snapshot = await requireCreditPool(context, organizationId, now);
		const [credits, workstationCostCoverage] = await Promise.all([
			readBillingCredits(context, organizationId, snapshot),
			getWorkstationCostCoverage(context.db, {
				organizationId,
				periodStart: snapshot.periodStart,
				periodEnd: snapshot.periodEnd,
			}),
		]);
		// Same rule as the admission gate, asked about one typical turn.
		const blockingReason = creditRefusalReason(snapshot, {
			now,
			credits: NOMINAL_TURN_CREDITS,
		});
		const stripeEnvironment = resolveStripeEnvironment(env);
		const usesStripe = snapshot.stripeEnvironment === stripeEnvironment;
		return {
			stripeEnvironment,
			account: {
				status: snapshot.status,
				billingMode: snapshot.billingMode,
				periodStart: snapshot.periodStart,
				periodEnd: snapshot.periodEnd,
				hasStripeCustomer: usesStripe && snapshot.stripeCustomerId !== null,
				hasIncludedCreditsOverride: snapshot.includedCreditsOverride !== null,
				hasPaidPlan:
					(snapshot.status === "active" || snapshot.status === "past_due") &&
					(snapshot.billingMode === "invoice" ||
						(snapshot.billingMode === "stripe" &&
							usesStripe &&
							!!snapshot.stripeSubscriptionId)),
			},
			plan: {
				key: snapshot.planKey,
				name: snapshot.planName,
				priceMicros: snapshot.planPriceMicros,
				currency: "eur" as const,
				includedCredits: snapshot.includedCredits,
			},
			credits,
			admission: {
				available: blockingReason === null,
				blockingReason,
				unblockAction: unblockAction(blockingReason, snapshot),
			},
			workstationCostCoverage,
		};
	});

const listPlansContract = os.listPlans
	.use(withAuth)
	.use(withFleetAuthority)
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The plan catalog is readable by every organization member",
			},
			"billing:read",
		),
	)
	.handler(async ({ context }) => {
		requireManagedSettlement(context);
		const now = new Date().toISOString();
		const plans = await Promise.all(
			BILLING_PLAN_KEYS.map((planKey) =>
				getActiveBillingPlanByKey(context.db, planKey, now),
			),
		);
		return plans.flatMap((plan) =>
			plan
				? [
						{
							key: plan.planKey,
							name: plan.name,
							priceMicros: plan.monthlyPriceMicros,
							currency: "eur" as const,
							includedCredits: plan.includedMonthlyCredits,
						},
					]
				: [],
		);
	});

const listTopUpPacksContract = os.listTopUpPacks
	.use(withAuth)
	.use(withFleetAuthority)
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"The top-up catalog is readable by every organization member",
			},
			"billing:read",
		),
	)
	.handler(async ({ context }) => {
		requireManagedSettlement(context);
		const packs = await listActiveTopUpPacks(context.db, {
			stripeEnvironment: resolveStripeEnvironment(context.env),
			now: new Date().toISOString(),
		});
		return packs.map((pack) => ({
			packKey: pack.packKey,
			credits: pack.credits,
			priceMicros: pack.priceMicros,
			currency: "eur" as const,
			validMonths: TOP_UP_VALID_MONTHS as 12,
		}));
	});

const setCreditCapsContract = os.setCreditCaps
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ context, input }) => {
		const { organizationId } = context;
		if (!organizationId) {
			throw baseErrorConstructors.FORBIDDEN({ message: "No organization" });
		}
		const actor = requireOrganizationBillingAuthority(context);
		const tedis = new Set(
			(await getTedisByOrganization(context.db, organizationId)).map(
				(tedi) => tedi.id,
			),
		);
		const unknownTedi = (input.tediCaps ?? []).find(
			(cap) => !tedis.has(cap.tediId),
		);
		if (unknownTedi) {
			throw baseErrorConstructors.NOT_FOUND({
				message: `Tedi ${unknownTedi.tediId} is not part of this organization`,
			});
		}
		const now = new Date().toISOString();
		await setCreditCaps(context.db, {
			organizationId,
			caps: [
				...(input.tediCaps ?? []).map((cap) => ({
					subjectKind: "tedi" as const,
					subjectKey: cap.tediId,
					monthlyCapCredits: cap.monthlyCapCredits,
				})),
				...(input.memberCaps ?? []).map((cap) => ({
					subjectKind: "member" as const,
					subjectKey: cap.userId,
					monthlyCapCredits: cap.monthlyCapCredits,
				})),
			],
			updatedBy: actor,
			now,
		});
		return readBillingCredits(
			context,
			organizationId,
			await requireCreditPool(context, organizationId, now),
		);
	});

const setPayAsYouGoContract = os.setPayAsYouGo
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ context, input }) => {
		const { organizationId } = context;
		if (!organizationId) {
			throw baseErrorConstructors.FORBIDDEN({ message: "No organization" });
		}
		requireOrganizationBillingAuthority(context);
		const now = new Date().toISOString();
		const before = await requireCreditPool(context, organizationId, now);
		if (input.enabled && !before.payAsYouGo.allowed) {
			throw baseErrorConstructors.BAD_REQUEST({
				message: `The ${before.planName} plan does not offer pay-as-you-go`,
			});
		}
		await setPayAsYouGo(context.db, {
			organizationId,
			enabled: input.enabled,
			monthlyCapMicros: input.monthlyCapMicros,
			now,
		});
		return readBillingCredits(
			context,
			organizationId,
			await requireCreditPool(context, organizationId, now),
		);
	});

const setAccountCreditsContract = os.setAccountCredits
	.use(withAuth)
	.use(withFleetAuthority)
	.use(AUTHZ.platformAdmin)
	.handler(async ({ context, input }) => {
		const actor = requirePlatformBillingAuthority(context);
		const now = new Date().toISOString();
		let result: Awaited<ReturnType<typeof setAccountCredits>>;
		try {
			result = await setAccountCredits(context.db, {
				organizationId: input.organizationId,
				includedCreditsOverride: input.includedCreditsOverride,
				reason: input.reason,
				actor: { id: actor, type: context.authType ?? "user" },
				now,
			});
		} catch (error) {
			throw baseErrorConstructors.CONFLICT({
				message:
					error instanceof Error ? error.message : "Credit override failed",
			});
		}
		if (!result) {
			throw baseErrorConstructors.NOT_FOUND({
				message: "Billing account is not configured",
			});
		}
		const snapshot = await requireCreditPool(
			context,
			input.organizationId,
			now,
		);
		return {
			organizationId: input.organizationId,
			includedCredits: snapshot.includedCredits,
			includedCreditsOverride: snapshot.includedCreditsOverride,
			entitlementVersion: result.entitlementVersion,
		};
	});

const grantTopUpCreditsContract = os.grantTopUpCredits
	.use(withAuth)
	.use(withFleetAuthority)
	.use(AUTHZ.platformAdmin)
	.handler(async ({ context, input }) => {
		const actor = requirePlatformBillingAuthority(context);
		const now = new Date();
		const expires = new Date(now);
		expires.setUTCMonth(expires.getUTCMonth() + TOP_UP_VALID_MONTHS);
		const topUp = await grantTopUpCredits(context.db, {
			id: crypto.randomUUID(),
			organizationId: input.organizationId,
			credits: input.credits,
			sourceType: "operator_grant",
			sourceRef: actor,
			idempotencyKey: `operator-top-up:${input.organizationId}:${input.idempotencyKey}`,
			expiresAt: expires.toISOString(),
			metadata: { actor, reason: input.reason },
			now: now.toISOString(),
		});
		return {
			topUpId: topUp.id,
			credits: topUp.credits,
			expiresAt: topUp.expiresAt,
		};
	});

const recordVoiceProviderUsageContract = os.recordVoiceProviderUsage
	.use(withServiceAuth)
	.use(withFleetAuthority)
	.handler(async ({ context, input }) =>
		recordVoiceProviderUsage(resolveFleetAuthorityDb(context.env), input),
	);

const assignInternalPlanContract = os.assignInternalPlan
	.use(withAuth)
	.use(withFleetAuthority)
	.use(AUTHZ.platformAdmin)
	.handler(async ({ context, input }) => {
		const actor = requirePlatformBillingAuthority(context);
		const now = new Date().toISOString();
		let assignment: { alreadyAssigned: boolean };
		try {
			assignment = await assignInternalPlan(
				context.db,
				input,
				{ id: actor, type: context.authType ?? "user" },
				now,
			);
		} catch (error) {
			throw baseErrorConstructors.CONFLICT({
				message:
					error instanceof Error
						? error.message
						: "Internal plan assignment failed",
			});
		}
		const entitlement = await getBillingEntitlement(
			context.db,
			input.organizationId,
		);
		const runtime = await getRuntimeEntitlement(
			context.db,
			input.organizationId,
		);
		const features = await getOrganizationFeatures(
			context.db,
			input.organizationId,
		);
		if (
			!entitlement ||
			!runtime ||
			!features ||
			entitlement.account.billingMode !== "internal"
		) {
			throw baseErrorConstructors.CONFLICT({
				message:
					"Internal plan assignment was superseded; read current entitlement",
			});
		}
		return {
			organizationId: input.organizationId,
			planVersionId: entitlement.plan.id,
			billingMode: "internal" as const,
			...assignment,
			features,
			runtime,
			active: runtimeEntitlementIsActive(runtime, Date.parse(now)),
			settlementMode: resolveBillingSettlementMode(context.env),
			allowOverage: entitlement.plan.allowOverage,
		};
	});

const correctBillingPeriodContract = os.correctBillingPeriod
	.use(withAuth)
	.use(withFleetAuthority)
	.use(AUTHZ.platformAdmin)
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

const setServiceCreditControlsContract = os.setServiceCreditControls
	.use(withAuth)
	.use(
		withAuthorization(
			{
				handlerOwnedUserAuthorization:
					"Owner/admin billing authority is checked in the handler",
			},
			"billing:write",
		),
	)
	.handler(async ({ context, input }) => {
		const { organizationId } = context;
		if (!organizationId) {
			throw baseErrorConstructors.FORBIDDEN({ message: "No organization" });
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
			throw baseErrorConstructors.NOT_FOUND({
				message: "Service credit entitlement is not configured",
			});
		}
		return { snapshot };
	});

const recordProviderCostEvidenceContract = os.recordProviderCostEvidence
	.use(withAuth)
	.use(withFleetAuthority)
	.use(AUTHZ.platformAdmin)
	.handler(async ({ context, input }) => {
		requirePlatformBillingAuthority(context);
		const { recordProviderCostEvidence } =
			await import("../../services/provider-cost-evidence");
		return recordProviderCostEvidence(context, input);
	});

const recordProviderReconciliationContract = os.recordProviderReconciliation
	.use(withAuth)
	.use(withFleetAuthority)
	.use(AUTHZ.platformAdmin)
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
	.use(AUTHZ.platformAdmin)
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
	.use(AUTHZ.platformAdmin)
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
			throw baseErrorConstructors.CONFLICT({
				message:
					"Rate publication conflicts with an existing version, correction leaf, or publication/verification time",
			});
		return row;
	});

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
const revokeHistoricalFreshExecutionContract = os.revokeHistoricalFreshExecution
	.use(withAuth)
	.use(withFleetAuthority)
	.use(withAuthorization("billing:manage", "billing:write"))
	.handler(async ({ context, input }) =>
		(
			await import("./billing/historical-exposure")
		).revokeHistoricalFreshExecutionHandler(context, input),
	);
const getCloudflareCostsContract = os.getCloudflareCosts
	.use(withAuth)
	.use(withFleetAuthority)
	.use(AUTHZ.platformAdmin)
	.handler(async ({ context, input }) => {
		requirePlatformBillingAuthority(context);
		const { listCloudflareDailyCosts } =
			await import("@tedix/db/queries/billing/cloudflare-costs");
		return {
			rows: await listCloudflareDailyCosts(
				resolveFleetAuthorityDb(context.env),
				`${input.day.slice(0, 7)}-01`,
				input.day,
			),
		};
	});

export const billingContractRouter = os.router({
	getCloudflareCosts: getCloudflareCostsContract,
	revokeHistoricalFreshExecution: revokeHistoricalFreshExecutionContract,
	listHistoricalExposures: listHistoricalExposuresContract,
	recordHistoricalFreshDecision: recordHistoricalFreshDecisionContract,
	revokeHistoricalFreshDecision: revokeHistoricalFreshDecisionContract,
	listProviderModelRates: listProviderModelRatesContract,
	publishProviderModelRate: publishProviderModelRateContract,
	createCheckout: createCheckoutContract,
	createTopUpCheckout: createTopUpCheckoutContract,
	createPortal: createPortalContract,
	getOverview: getOverviewContract,
	getDailyUsage: getDailyUsageContract,
	listTopUpPurchases: listTopUpPurchasesContract,
	getPaymentDetails: getPaymentDetailsContract,
	listInvoices: listInvoicesContract,
	listPlans: listPlansContract,
	listTopUpPacks: listTopUpPacksContract,
	setCreditCaps: setCreditCapsContract,
	setPayAsYouGo: setPayAsYouGoContract,
	setAccountCredits: setAccountCreditsContract,
	recordVoiceProviderUsage: recordVoiceProviderUsageContract,
	grantTopUpCredits: grantTopUpCreditsContract,
	assignInternalPlan: assignInternalPlanContract,
	correctBillingPeriod: correctBillingPeriodContract,
	setServiceCreditControls: setServiceCreditControlsContract,
	recordProviderCostEvidence: recordProviderCostEvidenceContract,
	recordProviderReconciliation: recordProviderReconciliationContract,
});
