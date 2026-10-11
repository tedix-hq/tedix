import type Stripe from "stripe";
import { describe, it, expect } from "vite-plus/test";
import { stripeCreditCoverage } from "./stripe-credit-coverage";
function invoice(overrides: Record<string, unknown> = {}) {
	return {
		id: "invoice",
		status: "paid",
		billing_reason: "subscription_cycle",
		parent: { subscription_details: { subscription: "sub" } },
		lines: {
			has_more: false,
			data: [
				{
					parent: {
						subscription_item_details: {
							subscription_item: "si",
							subscription: "sub",
							proration: false,
						},
					},
					period: { start: 1790812800, end: 1793491200 },
				},
			],
		},
		...overrides,
	} as unknown as Stripe.Invoice;
}
describe("paid subscription credit coverage", () => {
	it("returns exact paid plan-item coverage, including replay", () => {
		expect(stripeCreditCoverage(invoice(), "sub", "si")).toEqual({
			invoiceId: "invoice",
			subscriptionId: "sub",
			periodStart: "2026-10-01T00:00:00.000Z",
			periodEnd: "2026-11-01T00:00:00.000Z",
		});
		expect(stripeCreditCoverage(invoice(), "sub", "si")).toEqual(
			stripeCreditCoverage(invoice(), "sub", "si"),
		);
	});
	it("rejects one-off, unpaid, other subscription, and prorated invoices", () => {
		expect(
			stripeCreditCoverage(invoice({ parent: null }), "sub", "si"),
		).toBeNull();
		expect(
			stripeCreditCoverage(invoice({ billing_reason: "manual" }), "sub", "si"),
		).toBeNull();
		expect(
			stripeCreditCoverage(invoice({ status: "open" }), "sub", "si"),
		).toBeNull();
		expect(stripeCreditCoverage(invoice(), "other", "si")).toBeNull();
		expect(
			stripeCreditCoverage(
				invoice({
					lines: {
						has_more: false,
						data: [
							{
								parent: {
									subscription_item_details: {
										subscription_item: "si",
										subscription: "sub",
										proration: true,
									},
								},
								period: { start: 1, end: 2 },
							},
						],
					},
				}),
				"sub",
				"si",
			),
		).toBeNull();
	});
});
