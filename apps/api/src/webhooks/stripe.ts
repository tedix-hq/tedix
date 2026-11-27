/**
 * Stripe Webhook Handler
 * Processes Stripe subscription lifecycle events
 *
 * Security: Stripe signature verification (required)
 * Events handled:
 * - checkout.session.completed: Link Stripe customer, activate subscription
 * - customer.subscription.updated: Tier changes, status changes
 * - customer.subscription.deleted: Subscription cancelled
 * - invoice.payment_failed: Mark subscription as suspended
 */

import type { DbClient } from "@tedix/db/client";
import {
	forfeitRefundedTopUp,
	getTopUpPackVersion,
	grantTopUpCredits,
} from "@tedix/db/queries/billing/credit-pool";
import { TOP_UP_VALID_MONTHS } from "@tedix/api-contract/utils/credit-pricing";
import {
	getActiveBillingPlanByKey,
	getBillingEntitlement,
	getBillingEntitlementByStripeCustomerId,
	linkBillingAccountStripeCustomerIfUnbound,
} from "@tedix/db/queries/billing/plans";
import {
	applyStripeBillingWebhook,
	claimStripeWebhookEvent,
	hasNewerProcessedStripeWebhookEvent,
	markStripeWebhookEventFailed,
	markStripeWebhookEventProcessed,
	type StripeBillingWebhookOutcome,
} from "@tedix/db/queries/billing/stripe-webhooks";
import type { Context } from "hono";
import type Stripe from "stripe";
import {
	assertFleetAuthorityAvailable,
	FleetAuthorityUnavailableError,
	resolveFleetAuthorityDb,
} from "../lib/fleet-authority";
import { getStripe } from "../lib/stripe";
import {
	getStripeEnvironmentConfig,
	resolveStripeEnvironment,
	type StripeEnvironment,
} from "../lib/stripe-environment";
import { resolveBillingSettlementMode } from "../lib/billing-settlement-mode";
import { safeErrorMetadata } from "../lib/safe-log-metadata";
import {
	resolveStripeSubscriptionPlan,
	stripeInvoiceSubscriptionId,
	stripeSubscriptionPeriod,
} from "../lib/stripe-billing";

type StripeBillingReceipt = Parameters<typeof applyStripeBillingWebhook>[1];

const STRIPE_WEBHOOK_LEASE_MS = 5 * 60 * 1_000;

async function safeWebhookException(
	error: unknown,
): Promise<Record<string, unknown>> {
	try {
		return await safeErrorMetadata(error);
	} catch {
		return { metadataUnavailable: true };
	}
}

function safeStripeEventType(type: string): string {
	return /^[a-z][a-z0-9_.]{0,79}$/.test(type) ? type : "unknown";
}

function stripeFailureReceipt(exception: Record<string, unknown>): string {
	// This D1 receipt is read by operators. Keep it short and content-free even
	// when the Stripe SDK or a downstream query embeds customer data in an error.
	return JSON.stringify({
		kind: exception.kind,
		name: exception.name,
		code: exception.code,
		message: exception.message,
		metadataUnavailable: exception.metadataUnavailable,
	});
}

/**
 * Ordering key for stale-event suppression. Staleness only means anything
 * WITHIN one entity-state stream — events whose handlers write the same
 * state. Subscription-entitlement events (checkout completion + every
 * customer.subscription.*) share the `sub:` stream, so an old subscription
 * snapshot cannot overwrite a newer one. Invoice events are keyed per
 * INVOICE (`invoice:`), never per subscription: a newer invoice event must
 * not suppress an older unprocessed subscription change (Stripe delivery is
 * unordered), and two different invoices for one subscription must never
 * suppress each other (each carries its own idempotent side effects, e.g.
 * plan-period credit grants).
 */
export function stripeEventEntityKey(event: Stripe.Event): string {
	const object = event.data.object as { id?: string };
	if (event.type === "checkout.session.completed") {
		const session = event.data.object as Stripe.Checkout.Session;
		if (session.metadata?.checkoutKind === "credit_top_up") {
			return `top-up:${session.id}`;
		}
		const subscriptionId =
			typeof session.subscription === "string"
				? session.subscription
				: session.subscription?.id;
		return `sub:${subscriptionId ?? session.id}`;
	}
	if (event.type.startsWith("customer.subscription.")) {
		return `sub:${(event.data.object as Stripe.Subscription).id}`;
	}
	if (event.type.startsWith("invoice.")) {
		const invoice = event.data.object as Stripe.Invoice;
		return `invoice:${invoice.id}`;
	}
	if (event.type === "charge.refunded") {
		return `top-up-refund:${(event.data.object as Stripe.Charge).id}`;
	}
	return object.id ?? event.id;
}

export async function handleStripeWebhook(
	c: Context<{ Bindings: CloudflareEnv }>,
	stripeEnvironment: StripeEnvironment,
): Promise<Response> {
	const env = c.env;
	try {
		assertFleetAuthorityAvailable(env);
	} catch (error) {
		if (error instanceof FleetAuthorityUnavailableError) {
			return c.json(
				{ error: error.message },
				error.reason === "disabled" ? 404 : 503,
			);
		}
		throw error;
	}
	if (resolveBillingSettlementMode(env) !== "managed") {
		return c.json({ error: "Stripe settlement is disabled" }, 404);
	}
	const stripeConfig = getStripeEnvironmentConfig(env, stripeEnvironment);
	const stripe = await getStripe(stripeConfig.secretKey);

	// Verify webhook signature
	const sig = c.req.header("stripe-signature");
	if (!sig) {
		return c.json({ error: "Missing stripe-signature header" }, 400);
	}

	const rawBody = await c.req.text();
	let event: Stripe.Event;

	try {
		event = await stripe.webhooks.constructEventAsync(
			rawBody,
			sig,
			stripeConfig.webhookSecret,
		);
	} catch (err) {
		console.error(
			JSON.stringify({
				event: "stripe.webhook.signature_failed",
				stripeEnvironment,
				exception: await safeWebhookException(err),
			}),
		);
		return c.json({ error: "Invalid signature" }, 400);
	}

	const activeEnvironment = resolveStripeEnvironment(env);
	if (activeEnvironment !== stripeEnvironment) {
		return c.json({
			received: true,
			ignoredInactiveEnvironment: stripeEnvironment,
		});
	}

	const db = resolveFleetAuthorityDb(env);
	const nowMs = Date.now();
	const now = new Date(nowMs).toISOString();
	const receipt = await claimStripeWebhookEvent(db, {
		eventId: stripeEnvironment === "live" ? event.id : `test:${event.id}`,
		eventType: event.type,
		entityKey:
			stripeEnvironment === "live"
				? stripeEventEntityKey(event)
				: `test:${stripeEventEntityKey(event)}`,
		eventCreatedAt: event.created,
		now,
		leaseExpiresAt: new Date(nowMs + STRIPE_WEBHOOK_LEASE_MS).toISOString(),
	});
	if (!receipt.claimed) {
		if (receipt.event.status === "processing") {
			return c.json(
				{
					error: "Webhook event is already processing",
					retry: true,
				},
				500,
			);
		}
		return c.json({
			received: true,
			duplicate: true,
			status: receipt.event.status,
		});
	}

	try {
		if (
			await hasNewerProcessedStripeWebhookEvent(db, {
				entityKey: receipt.event.entityKey,
				eventCreatedAt: event.created,
				eventId: receipt.event.eventId,
			})
		) {
			const processed = await markStripeWebhookEventProcessed(db, {
				eventId: receipt.event.eventId,
				attemptCount: receipt.event.attemptCount,
				outcome: "skipped_stale",
				now: new Date().toISOString(),
			});
			if (!processed) throw new Error("Stripe webhook lease expired");
			return c.json({ received: true, stale: true });
		}

		let outcome = "applied";
		let billingOutcome: StripeBillingWebhookOutcome | null | undefined;
		switch (event.type) {
			case "checkout.session.completed": {
				const session = event.data.object as Stripe.Checkout.Session;
				if (session.metadata?.checkoutKind === "credit_top_up") {
					await handleCreditTopUpCheckoutCompleted(
						db,
						stripe,
						session,
						stripeEnvironment,
					);
				} else {
					billingOutcome = await handleCheckoutCompleted(
						db,
						receipt.event,
						stripe,
						session,
						stripeEnvironment,
					);
				}
				break;
			}
			case "charge.refunded": {
				const charge = event.data.object as Stripe.Charge;
				const paymentIntentId =
					typeof charge.payment_intent === "string"
						? charge.payment_intent
						: charge.payment_intent?.id;
				if (
					!paymentIntentId ||
					!(await forfeitRefundedTopUp(db, {
						paymentIntentId,
						amount: charge.amount,
						amountRefunded: charge.amount_refunded,
						now: new Date().toISOString(),
					}))
				)
					outcome = "ignored_non_top_up_refund";
				break;
			}
			case "customer.subscription.created":
			case "customer.subscription.updated": {
				const subscription = event.data.object as Stripe.Subscription;
				billingOutcome = await handleSubscriptionUpdated(
					db,
					receipt.event,
					stripe,
					subscription,
					stripeEnvironment,
				);
				break;
			}
			case "customer.subscription.deleted": {
				const subscription = event.data.object as Stripe.Subscription;
				billingOutcome = await handleSubscriptionDeleted(
					db,
					receipt.event,
					subscription,
					stripeEnvironment,
				);
				break;
			}
			case "invoice.payment_failed": {
				const invoice = event.data.object as Stripe.Invoice;
				billingOutcome = await handlePaymentFailed(
					db,
					receipt.event,
					stripe,
					invoice,
					stripeEnvironment,
				);
				break;
			}
			case "invoice.paid": {
				const invoice = event.data.object as Stripe.Invoice;
				billingOutcome = await handleInvoicePaid(
					db,
					receipt.event,
					stripe,
					invoice,
					stripeEnvironment,
				);
				break;
			}
			default:
				// Handle billing meter errors (event type not in SDK's discriminated union yet)
				if ((event.type as string) === "billing_meter.error_report_triggered") {
					console.error(
						JSON.stringify({
							event: "stripe.webhook.billing_meter_error_report",
							stripeEnvironment,
						}),
					);
					outcome = "observed_meter_error";
					break;
				}
				outcome = "ignored";
				if (env.ENVIRONMENT === "development") {
					console.log(`Unhandled Stripe event: ${event.type}`);
				}
		}
		if (billingOutcome) {
			return c.json(
				billingOutcome === "skipped_stale"
					? { received: true, stale: true }
					: { received: true },
			);
		}
		const processed = await markStripeWebhookEventProcessed(db, {
			eventId: receipt.event.eventId,
			attemptCount: receipt.event.attemptCount,
			outcome,
			now: new Date().toISOString(),
		});
		if (!processed) throw new Error("Stripe webhook lease expired");
	} catch (err) {
		const exception = await safeWebhookException(err);
		console.error(
			JSON.stringify({
				event: "stripe.webhook.processing_failed",
				stripeEnvironment,
				eventType: safeStripeEventType(event.type),
				exception,
			}),
		);
		await markStripeWebhookEventFailed(db, {
			eventId: receipt.event.eventId,
			attemptCount: receipt.event.attemptCount,
			error: stripeFailureReceipt(exception),
			now: new Date().toISOString(),
		});
		return c.json({ error: "Webhook processing failed" }, 500);
	}

	return c.json({ received: true });
}

// =============================================================================
// EVENT HANDLERS
// =============================================================================

export function assertTopUpCheckoutPayment(input: {
	session: Stripe.Checkout.Session;
	pack: {
		priceMicros: number;
		currency: string;
		stripeLookupKey: string | null;
	};
	lineItems: Stripe.ApiList<Stripe.LineItem>;
}): void {
	if (
		input.session.mode !== "payment" ||
		input.session.payment_status !== "paid"
	) {
		throw new Error(`Checkout session ${input.session.id} is not paid`);
	}
	if (
		!Number.isSafeInteger(input.pack.priceMicros) ||
		input.pack.priceMicros < 0
	) {
		throw new Error("Credit top-up pack has an invalid price");
	}
	if (input.pack.priceMicros % 10_000 !== 0) {
		throw new Error("Credit top-up pack price must resolve to whole cents");
	}
	const expectedAmount = input.pack.priceMicros / 10_000;
	if (
		input.session.amount_total !== expectedAmount ||
		input.session.currency?.toLowerCase() !== input.pack.currency.toLowerCase()
	) {
		throw new Error(`Checkout session ${input.session.id} amount mismatch`);
	}
	if (input.lineItems.data.length !== 1) {
		throw new Error(
			`Checkout session ${input.session.id} must contain one line item`,
		);
	}
	const item = input.lineItems.data[0];
	const price = item?.price;
	const priceMatches = Boolean(
		input.pack.stripeLookupKey &&
		price?.lookup_key === input.pack.stripeLookupKey,
	);
	if (
		item?.quantity !== 1 ||
		!priceMatches ||
		item.amount_total !== expectedAmount
	) {
		throw new Error(`Checkout session ${input.session.id} price mismatch`);
	}
}

async function handleCreditTopUpCheckoutCompleted(
	db: DbClient,
	stripe: Stripe,
	session: Stripe.Checkout.Session,
	stripeEnvironment: StripeEnvironment,
): Promise<void> {
	const organizationId = session.metadata?.organizationId;
	const packVersionId = session.metadata?.packVersionId;
	if (!organizationId || !packVersionId) {
		throw new Error(
			`Checkout session ${session.id} is missing top-up metadata`,
		);
	}
	if (session.metadata?.stripeEnvironment !== stripeEnvironment) {
		throw new Error(`Checkout session ${session.id} environment mismatch`);
	}
	const pack = await getTopUpPackVersion(db, {
		id: packVersionId,
		stripeEnvironment,
	});
	if (!pack) {
		throw new Error(
			`Checkout session ${session.id} references an unknown pack`,
		);
	}
	const lineItems = await stripe.checkout.sessions.listLineItems(session.id, {
		limit: 2,
	});
	assertTopUpCheckoutPayment({ session, pack, lineItems });
	const now = new Date();
	const expiresAt = new Date(now);
	expiresAt.setUTCMonth(expiresAt.getUTCMonth() + TOP_UP_VALID_MONTHS);
	const paymentIntent =
		typeof session.payment_intent === "string"
			? session.payment_intent
			: session.payment_intent?.id;
	await grantTopUpCredits(db, {
		id: crypto.randomUUID(),
		organizationId,
		credits: pack.credits,
		sourceType: "stripe_checkout",
		sourceRef: session.id,
		packVersionId: pack.id,
		idempotencyKey: `stripe-credit-top-up:${stripeEnvironment}:${session.id}`,
		expiresAt: expiresAt.toISOString(),
		metadata: {
			checkoutSessionId: session.id,
			paymentIntentId: paymentIntent ?? null,
			amountPaid: session.amount_total ?? pack.priceMicros / 10_000,
			currency: session.currency ?? pack.currency,
		},
		now: now.toISOString(),
	});
	const customerId =
		typeof session.customer === "string"
			? session.customer
			: session.customer?.id;
	if (customerId) {
		await linkBillingAccountStripeCustomerIfUnbound(db, {
			organizationId,
			stripeCustomerId: customerId,
			stripeEnvironment,
			now: now.toISOString(),
		});
	}
}

async function handleCheckoutCompleted(
	db: DbClient,
	receipt: StripeBillingReceipt,
	stripe: Stripe,
	session: Stripe.Checkout.Session,
	stripeEnvironment: StripeEnvironment,
) {
	const orgId = session.metadata?.organizationId;
	if (!orgId) {
		console.error("Checkout session missing organizationId metadata");
		return;
	}

	const customerId =
		typeof session.customer === "string"
			? session.customer
			: session.customer?.id;
	if (!customerId) {
		throw new Error(`Checkout session ${session.id} has no customer`);
	}

	const subscriptionId =
		typeof session.subscription === "string"
			? session.subscription
			: session.subscription?.id;
	if (!subscriptionId) {
		throw new Error(`Checkout session ${session.id} has no subscription`);
	}
	const subscription = await stripe.subscriptions.retrieve(subscriptionId);
	const resolved = await resolveStripeSubscriptionPlan(
		subscription,
		(planKey) =>
			getActiveBillingPlanByKey(db, planKey, new Date().toISOString()),
	);
	if (!resolved) {
		throw new Error(`Checkout session ${session.id} has no Tedix plan price`);
	}
	const outcome = await syncSubscriptionState(
		db,
		receipt,
		subscription,
		resolved.plan.planKey,
		resolved.item,
		stripeEnvironment,
		orgId,
		true,
	);
	if (!outcome) {
		throw new Error(
			`Checkout session ${session.id} could not bind its intended billing account`,
		);
	}
	return outcome;
}

function billingSubscriptionStatus(
	status: Stripe.Subscription.Status,
): "trial" | "active" | "past_due" | "cancelled" | "suspended" {
	if (status === "trialing") return "trial";
	if (status === "active") return "active";
	if (status === "past_due") return "past_due";
	if (status === "canceled" || status === "incomplete_expired") {
		return "cancelled";
	}
	return "suspended";
}

export function stripeSubscriptionHasActiveEntitlement(
	status: Stripe.Subscription.Status,
): boolean {
	return status === "active" || status === "trialing";
}

async function syncSubscriptionState(
	db: DbClient,
	receipt: StripeBillingReceipt,
	subscription: Stripe.Subscription,
	tier: "starter" | "growth" | "business" | "enterprise",
	planItem: Stripe.SubscriptionItem | undefined,
	stripeEnvironment: StripeEnvironment,
	metadataOrganizationId: string | undefined,
	requireMetadataOrganization = false,
) {
	const customerId =
		typeof subscription.customer === "string"
			? subscription.customer
			: subscription.customer?.id;
	if (!customerId) return null;
	let entitlement = await getBillingEntitlementByStripeCustomerId(
		db,
		customerId,
		stripeEnvironment,
	);
	if (!entitlement && metadataOrganizationId) {
		entitlement = await getBillingEntitlement(db, metadataOrganizationId);
		if (
			entitlement?.account.stripeCustomerId &&
			entitlement.account.stripeCustomerId !== customerId
		) {
			throw new Error(
				`Billing account ${metadataOrganizationId} is already bound to a different Stripe customer`,
			);
		}
	}
	if (!entitlement) return null;
	if (
		entitlement.account.stripeSubscriptionId &&
		entitlement.account.stripeSubscriptionId !== subscription.id &&
		["active", "trial", "past_due"].includes(entitlement.account.status)
	) {
		return null;
	}
	if (
		requireMetadataOrganization &&
		entitlement.account.organizationId !== metadataOrganizationId
	)
		return null;
	const period = stripeSubscriptionPeriod(planItem);
	// An annual provider subscription still has monthly included-credit windows.
	if (
		entitlement.plan.metadata.monetaryInference &&
		planItem?.price.recurring?.interval === "year"
	) {
		if (
			entitlement.account.periodStart >= period.start &&
			entitlement.account.periodEnd <= period.end
		) {
			period.start = entitlement.account.periodStart;
			period.end = entitlement.account.periodEnd;
		} else {
			const monthlyEnd = new Date(period.start);
			monthlyEnd.setUTCMonth(monthlyEnd.getUTCMonth() + 1);
			period.end = monthlyEnd.toISOString();
		}
	}

	return applyStripeBillingWebhook(db, receipt, {
		account: entitlement.account,
		applyPlanFeatures: true,
		planKey: tier,
		status: billingSubscriptionStatus(subscription.status),
		stripeEnvironment,
		stripeCustomerId: customerId,
		stripeSubscriptionId: subscription.id,
		stripeCancelAtPeriodEnd: subscription.cancel_at_period_end,
		periodStart: period.start,
		periodEnd: period.end,
		now: new Date().toISOString(),
		metadata: {
			stripeStatus: subscription.status,
			stripeEnvironment,
		},
	});
}

async function handleSubscriptionUpdated(
	db: DbClient,
	receipt: StripeBillingReceipt,
	stripe: Stripe,
	eventSubscription: Stripe.Subscription,
	stripeEnvironment: StripeEnvironment,
) {
	const subscription = await stripe.subscriptions.retrieve(
		eventSubscription.id,
	);
	const metadataOrgId = subscription.metadata.organizationId;
	const resolved = await resolveStripeSubscriptionPlan(
		subscription,
		(planKey) =>
			getActiveBillingPlanByKey(db, planKey, new Date().toISOString()),
	);
	if (!resolved) {
		if (metadataOrgId) {
			throw new Error(
				`Tedix subscription ${subscription.id} has no Tedix plan price`,
			);
		}
		return;
	}
	return syncSubscriptionState(
		db,
		receipt,
		subscription,
		resolved.plan.planKey,
		resolved.item,
		stripeEnvironment,
		metadataOrgId,
	);
}

async function handleSubscriptionDeleted(
	db: DbClient,
	receipt: StripeBillingReceipt,
	subscription: Stripe.Subscription,
	stripeEnvironment: StripeEnvironment,
) {
	const customerId =
		typeof subscription.customer === "string"
			? subscription.customer
			: subscription.customer?.id;
	if (!customerId) return;

	const entitlement = await getBillingEntitlementByStripeCustomerId(
		db,
		customerId,
		stripeEnvironment,
	);
	if (!entitlement) return;
	if (
		entitlement.account.stripeSubscriptionId &&
		entitlement.account.stripeSubscriptionId !== subscription.id
	) {
		return;
	}

	return applyStripeBillingWebhook(db, receipt, {
		account: entitlement.account,
		applyPlanFeatures: true,
		planKey: "starter",
		status: "cancelled",
		stripeEnvironment,
		stripeCustomerId: customerId,
		stripeSubscriptionId: subscription.id,
		stripeCancelAtPeriodEnd: false,
		periodStart: entitlement.account.periodStart,
		periodEnd: entitlement.account.periodEnd,
		now: new Date().toISOString(),
		metadata: { stripeStatus: subscription.status, stripeEnvironment },
	});
}

async function handlePaymentFailed(
	db: DbClient,
	receipt: StripeBillingReceipt,
	stripe: Stripe,
	eventInvoice: Stripe.Invoice,
	stripeEnvironment: StripeEnvironment,
) {
	const invoice = await stripe.invoices.retrieve(eventInvoice.id);
	if (invoice.status === "paid") return;
	const customerId =
		typeof invoice.customer === "string"
			? invoice.customer
			: invoice.customer?.id;
	if (!customerId) return;

	const entitlement = await getBillingEntitlementByStripeCustomerId(
		db,
		customerId,
		stripeEnvironment,
	);
	if (!entitlement) return;

	// Only suspend if this isn't the first attempt (Stripe retries)
	if ((invoice.attempt_count ?? 0) >= 2) {
		const subscriptionId =
			stripeInvoiceSubscriptionId(invoice) ??
			entitlement.account.stripeSubscriptionId;
		if (subscriptionId) {
			const subscription = await stripe.subscriptions.retrieve(subscriptionId);
			if (
				subscription.status === "active" ||
				subscription.status === "trialing"
			) {
				return;
			}
		}
		return applyStripeBillingWebhook(db, receipt, {
			account: entitlement.account,
			applyPlanFeatures: false,
			planKey: entitlement.plan.planKey,
			status: "past_due",
			stripeEnvironment,
			stripeCustomerId: customerId,
			stripeSubscriptionId: subscriptionId,
			periodStart: entitlement.account.periodStart,
			periodEnd: entitlement.account.periodEnd,
			now: new Date().toISOString(),
			metadata: {
				stripeInvoiceId: invoice.id,
				paymentFailed: true,
				stripeEnvironment,
			},
		});
	}
}

async function handleInvoicePaid(
	db: DbClient,
	receipt: StripeBillingReceipt,
	stripe: Stripe,
	invoice: Stripe.Invoice,
	stripeEnvironment: StripeEnvironment,
) {
	const customerId =
		typeof invoice.customer === "string"
			? invoice.customer
			: invoice.customer?.id;
	if (!customerId) return;
	const currentEntitlement = await getBillingEntitlementByStripeCustomerId(
		db,
		customerId,
		stripeEnvironment,
	);
	const subscriptionId = stripeInvoiceSubscriptionId(invoice);
	// Never treat a top-up/one-off invoice as the current subscription invoice.
	if (
		currentEntitlement?.account.stripeSubscriptionId &&
		subscriptionId !== currentEntitlement.account.stripeSubscriptionId
	)
		return;
	if (!subscriptionId) return;
	const subscription = await stripe.subscriptions.retrieve(subscriptionId);
	// A final zero-dollar or prorated invoice can be paid after
	// customer.subscription.deleted. The invoice stream is deliberately separate
	// from the subscription stream, so guard the canonical subscription status
	// before re-projecting its former paid plan over the cancellation downgrade.
	if (!stripeSubscriptionHasActiveEntitlement(subscription.status)) return;
	const resolved = await resolveStripeSubscriptionPlan(
		subscription,
		(planKey) =>
			getActiveBillingPlanByKey(db, planKey, new Date().toISOString()),
	);
	if (!resolved) {
		throw new Error(`Paid Tedix invoice ${invoice.id} has no Tedix plan price`);
	}
	const tier = resolved.plan.planKey;
	// Included credits come with the active period itself; a paid invoice
	// only keeps the subscription state current.
	return syncSubscriptionState(
		db,
		receipt,
		subscription,
		tier,
		resolved.item,
		stripeEnvironment,
		subscription.metadata.organizationId,
	);
}
