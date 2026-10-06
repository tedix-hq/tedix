import type { BillingPlanVersion } from "@tedix/db/schema/billing";
import type Stripe from "stripe";
import { describe, expect, it } from "vite-plus/test";
import {
	planKeyFromStripePriceLookupKey,
	planSellsStripeOverage,
	resolveStripeSubscriptionPlan,
	stripeCheckoutIdempotencyKey,
	stripeInvoiceSubscriptionId,
	stripeSubscriptionPeriod,
} from "./stripe-billing";

function item(
	id: string,
	lookupKey: string | null,
	start: number,
	end: number,
): Stripe.SubscriptionItem {
	return {
		id,
		current_period_start: start,
		current_period_end: end,
		price: { id: `price_${id}`, lookup_key: lookupKey },
	} as Stripe.SubscriptionItem;
}

describe("Stripe billing helpers", () => {
	it("resolves the licensed plan even when the metered item is first", async () => {
		const metered = item("si_metered", "tedix_token_overage_v3", 1, 2);
		const licensed = item("si_plan", "tedix_growth_year_v3", 100, 200);
		const subscription = {
			items: { data: [metered, licensed] },
		} as Stripe.Subscription;
		const plan = {
			id: "growth-v2",
			planKey: "growth",
		} as BillingPlanVersion;

		const resolved = await resolveStripeSubscriptionPlan(
			subscription,
			async (planKey) => (planKey === "growth" ? plan : null),
		);

		expect(resolved).toEqual({ plan, item: licensed });
	});

	it("reads the plan only from a plan price lookup key", () => {
		expect(planKeyFromStripePriceLookupKey("tedix_business_month_v3")).toBe(
			"business",
		);
		expect(
			planKeyFromStripePriceLookupKey("tedix_token_overage_v3"),
		).toBeNull();
		expect(planKeyFromStripePriceLookupKey("tedix_growth_week_v3")).toBeNull();
		expect(planKeyFromStripePriceLookupKey(null)).toBeNull();
	});

	it("sells overage only on plans that allow and price it", () => {
		// Seeded rows: growth/business carry a paid unit price; enterprise v4
		// allows zero-priced internal overage; starter allows none.
		expect(
			planSellsStripeOverage({
				allowOverage: true,
				overageUnitPriceMicros: 50_000,
			}),
		).toBe(true);
		expect(
			planSellsStripeOverage({ allowOverage: true, overageUnitPriceMicros: 0 }),
		).toBe(false);
		expect(
			planSellsStripeOverage({
				allowOverage: false,
				overageUnitPriceMicros: 0,
			}),
		).toBe(false);
	});

	it("uses the resolved plan item's period", () => {
		const period = stripeSubscriptionPeriod(
			item("si_plan", "tedix_growth_month_v3", 100, 200),
		);
		expect(period).toEqual({
			start: "1970-01-01T00:01:40.000Z",
			end: "1970-01-01T00:03:20.000Z",
		});
	});

	it("extracts the invoice subscription from the current Stripe parent shape", () => {
		const invoice = {
			parent: {
				subscription_details: { subscription: "sub_123" },
			},
		} as Stripe.Invoice;
		expect(stripeInvoiceSubscriptionId(invoice)).toBe("sub_123");
	});

	it("deduplicates identical checkout requests within a 30-minute bucket", async () => {
		const input = {
			organizationId: "org-1",
			planVersionId: "growth-v2",
			priceId: "price_monthly",
			overagePriceId: "price_overage",
			interval: "month" as const,
			successUrl: "https://acme.os.tedix.dev/success",
			cancelUrl: "https://acme.os.tedix.dev/cancel",
			nowMs: 1_800_001,
		};
		const first = await stripeCheckoutIdempotencyKey(input);
		const duplicate = await stripeCheckoutIdempotencyKey(input);
		const nextBucket = await stripeCheckoutIdempotencyKey({
			...input,
			nowMs: input.nowMs + 30 * 60 * 1_000,
		});
		expect(duplicate).toBe(first);
		expect(nextBucket).not.toBe(first);
	});
});
