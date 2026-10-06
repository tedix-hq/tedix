/**
 * Stale-suppression ordering keys for Stripe webhook events.
 *
 * Stripe delivery is at-least-once and unordered. The regression these tests
 * pin: invoice.* events used to share an entity key with
 * customer.subscription.* events, so a processed newer invoice event
 * permanently suppressed an older unprocessed subscription change (dropped
 * tier change, `processed` receipt, no retry), and two different invoices for
 * one subscription could suppress each other's idempotent side effects.
 */

import type Stripe from "stripe";
import { describe, expect, it } from "vite-plus/test";
import {
	assertInferenceCapacityCheckoutPayment,
	handleStripeWebhook,
	stripeEventEntityKey,
	stripeSubscriptionHasActiveEntitlement,
} from "./stripe";

function paidCapacityCheckout(
	overrides: Partial<Stripe.Checkout.Session> = {},
): Stripe.Checkout.Session {
	return {
		id: "cs_capacity",
		mode: "payment",
		payment_status: "paid",
		amount_total: 2_500,
		currency: "usd",
		...overrides,
	} as Stripe.Checkout.Session;
}

function capacityLineItems(
	overrides: Partial<Stripe.LineItem> = {},
): Stripe.ApiList<Stripe.LineItem> {
	return {
		object: "list",
		url: "/v1/checkout/sessions/cs_capacity/line_items",
		has_more: false,
		data: [
			{
				id: "li_capacity",
				object: "item",
				quantity: 1,
				amount_total: 2_500,
				price: {
					id: "price_capacity",
					lookup_key: "tedix_inference_capacity_daily_5m_v1",
				} as Stripe.Price,
				...overrides,
			} as Stripe.LineItem,
		],
	};
}

describe("inference capacity checkout verification", () => {
	const pack = {
		priceMicros: 25_000_000,
		currency: "usd",
		stripeLookupKey: "tedix_inference_capacity_daily_5m_v1",
	};

	it("accepts a paid pack whose price carries its lookup key", () => {
		expect(() =>
			assertInferenceCapacityCheckoutPayment({
				session: paidCapacityCheckout(),
				pack,
				lineItems: capacityLineItems(),
			}),
		).not.toThrow();
	});

	it("rejects unpaid, amount-mismatched, and wrong-price sessions", () => {
		expect(() =>
			assertInferenceCapacityCheckoutPayment({
				session: paidCapacityCheckout({ payment_status: "unpaid" }),
				pack,
				lineItems: capacityLineItems(),
			}),
		).toThrow(/not paid/);
		expect(() =>
			assertInferenceCapacityCheckoutPayment({
				session: paidCapacityCheckout({ amount_total: 2_499 }),
				pack,
				lineItems: capacityLineItems(),
			}),
		).toThrow(/amount mismatch/);
		expect(() =>
			assertInferenceCapacityCheckoutPayment({
				session: paidCapacityCheckout(),
				pack,
				lineItems: capacityLineItems({
					price: {
						id: "price_wrong",
						lookup_key: "wrong",
					} as Stripe.Price,
				}),
			}),
		).toThrow(/price mismatch/);
	});

	it("matches the pack by lookup key, not by price id", () => {
		expect(() =>
			assertInferenceCapacityCheckoutPayment({
				session: paidCapacityCheckout(),
				pack,
				lineItems: capacityLineItems({
					price: {
						id: "price_capacity",
						lookup_key: null,
					} as Stripe.Price,
				}),
			}),
		).toThrow(/price mismatch/);
	});
});

describe("Stripe settlement mode", () => {
	it("rejects disabled webhooks before reading Stripe secrets", async () => {
		const response = await handleStripeWebhook(
			{
				env: {
					TEDIX_BILLING_SETTLEMENT_MODE: "disabled",
					TEDIX_FLEET_AUTHORITY_MODE: "disabled",
				},
				json: (body: unknown, status: number) =>
					Response.json(body, { status }),
			} as never,
			"live",
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			error: "Fleet authority is disabled for this installation",
		});
	});

	it("fails closed when webhook settlement mode is missing", async () => {
		await expect(
			handleStripeWebhook(
				{
					env: {
						DB: {} as D1Database,
						TEDIX_FLEET_AUTHORITY_MODE: "co-located",
					},
					json: (body: unknown) => Response.json(body),
				} as never,
				"live",
			),
		).rejects.toThrow(/TEDIX_BILLING_SETTLEMENT_MODE/);
	});
});

function event(type: string, object: Record<string, unknown>): Stripe.Event {
	return {
		id: `evt_${type}`,
		type,
		created: 1_753_750_000,
		data: { object },
	} as unknown as Stripe.Event;
}

describe("stripeEventEntityKey", () => {
	it("keeps every subscription-entitlement event in one sub: stream", () => {
		const checkout = event("checkout.session.completed", {
			id: "cs_1",
			subscription: "sub_123",
		});
		const updated = event("customer.subscription.updated", { id: "sub_123" });
		const deleted = event("customer.subscription.deleted", { id: "sub_123" });
		expect(stripeEventEntityKey(checkout)).toBe("sub:sub_123");
		expect(stripeEventEntityKey(updated)).toBe("sub:sub_123");
		expect(stripeEventEntityKey(deleted)).toBe("sub:sub_123");
	});

	it("never lets an invoice event share a stream with subscription events", () => {
		const subscriptionUpdate = event("customer.subscription.updated", {
			id: "sub_123",
		});
		const paymentFailed = event("invoice.payment_failed", {
			id: "in_9",
			subscription: "sub_123",
		});
		expect(stripeEventEntityKey(paymentFailed)).not.toBe(
			stripeEventEntityKey(subscriptionUpdate),
		);
		expect(stripeEventEntityKey(paymentFailed)).toBe("invoice:in_9");
	});

	it("keys invoices per invoice, not per subscription", () => {
		const january = event("invoice.paid", {
			id: "in_jan",
			subscription: "sub_123",
		});
		const february = event("invoice.payment_failed", {
			id: "in_feb",
			subscription: "sub_123",
		});
		expect(stripeEventEntityKey(january)).toBe("invoice:in_jan");
		expect(stripeEventEntityKey(february)).toBe("invoice:in_feb");
		expect(stripeEventEntityKey(january)).not.toBe(
			stripeEventEntityKey(february),
		);
	});

	it("falls back to the checkout session id when no subscription exists yet", () => {
		const checkout = event("checkout.session.completed", { id: "cs_1" });
		expect(stripeEventEntityKey(checkout)).toBe("sub:cs_1");
	});

	it("isolates one-time inference-capacity checkout from subscription streams", () => {
		const checkout = event("checkout.session.completed", {
			id: "cs_capacity",
			metadata: { checkoutKind: "inference_capacity" },
		});
		expect(stripeEventEntityKey(checkout)).toBe("capacity:cs_capacity");
	});

	it("serializes capacity refunds by Stripe charge", () => {
		const refunded = event("charge.refunded", { id: "ch_capacity" });
		expect(stripeEventEntityKey(refunded)).toBe("capacity-refund:ch_capacity");
	});

	it("uses the object id for unmapped event types", () => {
		const other = event("customer.updated", { id: "cus_1" });
		expect(stripeEventEntityKey(other)).toBe("cus_1");
	});
});

describe("stripeSubscriptionHasActiveEntitlement", () => {
	it("allows paid invoices to project only an active entitlement", () => {
		expect(stripeSubscriptionHasActiveEntitlement("active")).toBe(true);
		expect(stripeSubscriptionHasActiveEntitlement("trialing")).toBe(true);
	});

	it("does not let a final paid invoice restore a cancelled plan", () => {
		expect(stripeSubscriptionHasActiveEntitlement("canceled")).toBe(false);
		expect(stripeSubscriptionHasActiveEntitlement("incomplete_expired")).toBe(
			false,
		);
		expect(stripeSubscriptionHasActiveEntitlement("past_due")).toBe(false);
	});
});
