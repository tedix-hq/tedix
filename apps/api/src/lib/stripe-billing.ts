import {
	BILLING_PLAN_KEYS,
	type BillingPlanKey,
	type BillingPlanVersion,
} from "@tedix/db/schema/billing";
import type Stripe from "stripe";

/**
 * Stripe prices are resolved by lookup key, never by a stored price id, so an
 * installation only needs a Stripe account whose active prices carry these
 * keys (`scripts/billing/reconcile-stripe.ts` creates them).
 */
const STRIPE_CATALOG_VERSION = 3;

export const STRIPE_TOKEN_OVERAGE_LOOKUP_KEY = `tedix_token_overage_v${STRIPE_CATALOG_VERSION}`;

export function stripePlanPriceLookupKey(
	planKey: BillingPlanKey,
	interval: "month" | "year",
): string {
	return `tedix_${planKey}_${interval}_v${STRIPE_CATALOG_VERSION}`;
}

const PLAN_PRICE_LOOKUP_KEY = new RegExp(
	`^tedix_(${BILLING_PLAN_KEYS.join("|")})_(?:month|year)_v\\d+$`,
);

/** The plan a licensed Stripe price sells, read from its lookup key. */
export function planKeyFromStripePriceLookupKey(
	lookupKey: string | null | undefined,
): BillingPlanKey | null {
	const match = lookupKey ? PLAN_PRICE_LOOKUP_KEY.exec(lookupKey) : null;
	return (match?.[1] as BillingPlanKey | undefined) ?? null;
}

/**
 * A plan sells metered overage only when it both allows overage and prices it.
 * Enterprise allows overage at a zero unit price (internal metering), so it
 * must not get the paid overage line item.
 */
export function planSellsStripeOverage(
	plan: Pick<BillingPlanVersion, "allowOverage" | "overageUnitPriceMicros">,
): boolean {
	return plan.allowOverage && plan.overageUnitPriceMicros > 0;
}

export interface ResolvedStripePlan {
	plan: BillingPlanVersion;
	item: Stripe.SubscriptionItem;
}

/**
 * Resolve the licensed plan item without depending on Stripe's item order.
 * Metered overage and licensed plan items can arrive in either order; only
 * the licensed plan price carries a plan lookup key.
 */
export async function resolveStripeSubscriptionPlan(
	subscription: Stripe.Subscription,
	findPlan: (planKey: BillingPlanKey) => Promise<BillingPlanVersion | null>,
): Promise<ResolvedStripePlan | null> {
	for (const item of subscription.items.data) {
		const planKey = planKeyFromStripePriceLookupKey(item.price.lookup_key);
		if (!planKey) continue;
		const plan = await findPlan(planKey);
		if (plan) return { plan, item };
	}
	return null;
}

export function stripeSubscriptionPeriod(
	item: Stripe.SubscriptionItem | undefined,
	now = new Date(),
): { start: string; end: string } {
	const startSeconds = item?.current_period_start;
	const endSeconds = item?.current_period_end;
	return {
		start: startSeconds
			? new Date(startSeconds * 1_000).toISOString()
			: now.toISOString(),
		end: endSeconds
			? new Date(endSeconds * 1_000).toISOString()
			: new Date(
					Date.UTC(
						now.getUTCFullYear(),
						now.getUTCMonth() + 1,
						now.getUTCDate(),
					),
				).toISOString(),
	};
}

export function stripeInvoiceSubscriptionId(
	invoice: Stripe.Invoice,
): string | null {
	const parent = invoice.parent as {
		subscription_details?: {
			subscription?: string | Stripe.Subscription | null;
		} | null;
	} | null;
	const subscription = parent?.subscription_details?.subscription;
	if (!subscription) return null;
	return typeof subscription === "string" ? subscription : subscription.id;
}

export async function stripeCheckoutIdempotencyKey(input: {
	organizationId: string;
	planVersionId: string;
	priceId: string;
	overagePriceId: string | null;
	interval: "month" | "year";
	successUrl: string;
	cancelUrl: string;
	nowMs?: number;
}): Promise<string> {
	const bucket = Math.floor((input.nowMs ?? Date.now()) / (30 * 60 * 1_000));
	const payload = [
		input.organizationId,
		input.planVersionId,
		input.priceId,
		input.overagePriceId ?? "",
		input.interval,
		input.successUrl,
		input.cancelUrl,
		String(bucket),
	].join("\n");
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(payload),
	);
	const suffix = Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `tedix:checkout:${suffix}`;
}
