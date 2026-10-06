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

import { createDbClient } from "@tedix/db/client";
import { grantBillingCredit } from "@tedix/db/queries/billing/credits";
import {
	findCapacityAllocationByPaymentIntent,
	reconcileCapacityRefund,
	recordCapacityAllocation,
} from "@tedix/db/queries/billing/capacity-allocations";
import { getInferenceCapacityPackVersionById } from "@tedix/db/queries/billing/capacity-packs";
import {
	getActiveBillingPlanByKey,
	getBillingEntitlement,
	getBillingEntitlementByStripeCustomerId,
	linkBillingAccountStripeCustomerIfUnbound,
	provisionBillingAccount,
} from "@tedix/db/queries/billing/plans";
import {
	claimStripeWebhookEvent,
	hasNewerProcessedStripeWebhookEvent,
	markStripeWebhookEventFailed,
	markStripeWebhookEventProcessed,
} from "@tedix/db/queries/billing/stripe-webhooks";
import { applyOrganizationPlanFeatures } from "@tedix/db/queries/organizations";
import type { Context } from "hono";
import type Stripe from "stripe";
import {
	assertFleetAuthorityAvailable,
	FleetAuthorityUnavailableError,
	resolveFleetAuthorityBinding,
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
		if (session.metadata?.checkoutKind === "inference_capacity") {
			return `capacity:${session.id}`;
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
		return `capacity-refund:${(event.data.object as Stripe.Charge).id}`;
	}
	return object.id ?? event.id;
}

export async function handleStripeWebhook(
	c: Context<{ Bindings: CloudflareEnv }>,
	stripeEnvironment: StripeEnvironment,
): Promise<Response> {
	const env = c.env;
	let fleetBinding: D1Database;
	try {
		assertFleetAuthorityAvailable(env);
		fleetBinding = resolveFleetAuthorityBinding(env);
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

	const db = createDbClient(fleetBinding);
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
			await markStripeWebhookEventProcessed(db, {
				eventId: receipt.event.eventId,
				outcome: "skipped_stale",
				now: new Date().toISOString(),
			});
			return c.json({ received: true, stale: true });
		}

		let outcome = "applied";
		switch (event.type) {
			case "checkout.session.completed": {
				const session = event.data.object as Stripe.Checkout.Session;
				if (session.metadata?.checkoutKind === "inference_capacity") {
					await handleInferenceCapacityCheckoutCompleted(
						db,
						stripe,
						session,
						stripeEnvironment,
					);
				} else {
					await handleCheckoutCompleted(db, stripe, session, stripeEnvironment);
				}
				break;
			}
			case "charge.refunded": {
				const charge = event.data.object as Stripe.Charge;
				const paymentIntentId =
					typeof charge.payment_intent === "string"
						? charge.payment_intent
						: charge.payment_intent?.id;
				if (!paymentIntentId) {
					outcome = "ignored_non_capacity_refund";
					break;
				}
				const allocation = await findCapacityAllocationByPaymentIntent(db, {
					paymentIntentId,
					stripeEnvironment,
				});
				if (!allocation) {
					outcome = "ignored_non_capacity_refund";
					break;
				}
				await reconcileCapacityRefund(db, {
					organizationId: allocation.organizationId,
					allocation,
					chargeId: charge.id,
					paymentIntentId,
					amount: charge.amount,
					amountRefunded: charge.amount_refunded,
					eventId: receipt.event.eventId,
					createdAt: new Date().toISOString(),
				});
				break;
			}
			case "customer.subscription.created":
			case "customer.subscription.updated": {
				const subscription = event.data.object as Stripe.Subscription;
				await handleSubscriptionUpdated(
					db,
					stripe,
					subscription,
					stripeEnvironment,
				);
				break;
			}
			case "customer.subscription.deleted": {
				const subscription = event.data.object as Stripe.Subscription;
				await handleSubscriptionDeleted(db, subscription, stripeEnvironment);
				break;
			}
			case "invoice.payment_failed": {
				const invoice = event.data.object as Stripe.Invoice;
				await handlePaymentFailed(db, stripe, invoice, stripeEnvironment);
				break;
			}
			case "invoice.paid": {
				const invoice = event.data.object as Stripe.Invoice;
				await handleInvoicePaid(db, stripe, invoice, stripeEnvironment);
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
		await markStripeWebhookEventProcessed(db, {
			eventId: receipt.event.eventId,
			outcome,
			now: new Date().toISOString(),
		});
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

export function assertInferenceCapacityCheckoutPayment(input: {
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
		throw new Error("Inference capacity pack has an invalid price");
	}
	if (input.pack.priceMicros % 10_000 !== 0) {
		throw new Error(
			"Inference capacity pack price must resolve to whole cents",
		);
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

async function handleInferenceCapacityCheckoutCompleted(
	db: ReturnType<typeof createDbClient>,
	stripe: Stripe,
	session: Stripe.Checkout.Session,
	stripeEnvironment: StripeEnvironment,
): Promise<void> {
	const organizationId = session.metadata?.organizationId;
	const packVersionId = session.metadata?.packVersionId;
	if (!organizationId || !packVersionId) {
		throw new Error(
			`Checkout session ${session.id} is missing capacity metadata`,
		);
	}
	if (session.metadata?.stripeEnvironment !== stripeEnvironment) {
		throw new Error(`Checkout session ${session.id} environment mismatch`);
	}
	const pack = await getInferenceCapacityPackVersionById(db, {
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
	assertInferenceCapacityCheckoutPayment({
		session,
		pack,
		lineItems,
	});
	const now = new Date();
	const budgetDay = now.toISOString().slice(0, 10);
	const expiresAt = new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
	).toISOString();
	const paymentIntent =
		typeof session.payment_intent === "string"
			? session.payment_intent
			: session.payment_intent?.id;
	await recordCapacityAllocation(db, {
		id: crypto.randomUUID(),
		organizationId,
		packVersionId: pack.id,
		budgetDay,
		tokenAmount: pack.tokenAmount,
		spendAmountMicros: pack.spendAmountMicros,
		sourceType: "stripe_checkout",
		sourceRef: session.id,
		idempotencyKey: `stripe-inference-capacity:${stripeEnvironment}:${session.id}`,
		stripeEnvironment,
		expiresAt,
		metadata: {
			checkoutSessionId: session.id,
			...(paymentIntent ? { paymentIntentId: paymentIntent } : {}),
			amountPaid: session.amount_total ?? pack.priceMicros / 10_000,
			currency: session.currency ?? pack.currency,
		},
		createdAt: now.toISOString(),
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
	db: ReturnType<typeof createDbClient>,
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
	const syncedOrganizationId = await syncSubscriptionState(
		db,
		subscription,
		resolved.plan.planKey,
		resolved.item,
		stripeEnvironment,
		orgId,
	);
	if (syncedOrganizationId !== orgId) {
		throw new Error(
			`Checkout session ${session.id} could not bind its intended billing account`,
		);
	}
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
	db: ReturnType<typeof createDbClient>,
	subscription: Stripe.Subscription,
	tier: "starter" | "growth" | "business" | "enterprise",
	planItem?: Stripe.SubscriptionItem,
	stripeEnvironment: StripeEnvironment = "live",
	metadataOrganizationId?: string,
): Promise<string | null> {
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
	const organizationId = entitlement.account.organizationId;
	const period = stripeSubscriptionPeriod(planItem);
	await applyOrganizationPlanFeatures(db, organizationId, tier);
	await provisionBillingAccount(db, {
		organizationId,
		planKey: tier,
		status: billingSubscriptionStatus(subscription.status),
		billingMode: "stripe",
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
	return organizationId;
}

async function handleSubscriptionUpdated(
	db: ReturnType<typeof createDbClient>,
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
	await syncSubscriptionState(
		db,
		subscription,
		resolved.plan.planKey,
		resolved.item,
		stripeEnvironment,
		metadataOrgId,
	);
}

async function handleSubscriptionDeleted(
	db: ReturnType<typeof createDbClient>,
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

	await applyOrganizationPlanFeatures(
		db,
		entitlement.account.organizationId,
		"starter",
	);
	const now = new Date();
	await provisionBillingAccount(db, {
		organizationId: entitlement.account.organizationId,
		planKey: "starter",
		status: "cancelled",
		billingMode: "stripe",
		stripeEnvironment,
		stripeCustomerId: customerId,
		stripeSubscriptionId: subscription.id,
		stripeCancelAtPeriodEnd: false,
		periodStart: entitlement.account.periodStart,
		periodEnd: entitlement.account.periodEnd,
		now: now.toISOString(),
		metadata: { stripeStatus: subscription.status, stripeEnvironment },
	});
}

async function handlePaymentFailed(
	db: ReturnType<typeof createDbClient>,
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
		await provisionBillingAccount(db, {
			organizationId: entitlement.account.organizationId,
			planKey: entitlement.plan.planKey,
			status: "past_due",
			billingMode: "stripe",
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
	db: ReturnType<typeof createDbClient>,
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
	const subscriptionId =
		stripeInvoiceSubscriptionId(invoice) ??
		currentEntitlement?.account.stripeSubscriptionId;
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
	const organizationId = await syncSubscriptionState(
		db,
		subscription,
		tier,
		resolved.item,
		stripeEnvironment,
		subscription.metadata.organizationId,
	);
	if (!organizationId) return;
	const entitlement = await getBillingEntitlement(db, organizationId);
	const includedCredits = entitlement?.plan.includedMonthlyCreditMicros ?? 0;
	if (includedCredits > 0) {
		await grantBillingCredit(db, {
			id: crypto.randomUUID(),
			organizationId,
			amountMicros: includedCredits,
			sourceType: "plan_period",
			sourceRef: invoice.id,
			idempotencyKey: `stripe-invoice-credit:${invoice.id}`,
			expiresAt: entitlement?.account.periodEnd,
			description: `${tier} included monthly credits`,
			metadata: { stripeInvoiceId: invoice.id, stripeEnvironment },
			createdAt: new Date().toISOString(),
		});
	}
}
