import type Stripe from "stripe";
import { stripeInvoiceSubscriptionId } from "./stripe-billing";
/** An invoice funds only its explicit subscription plan-item service period. */
export function stripeCreditCoverage(
	invoice: Stripe.Invoice,
	subscriptionId: string,
	planItemId: string,
) {
	if (
		invoice.status !== "paid" ||
		stripeInvoiceSubscriptionId(invoice) !== subscriptionId ||
		!["subscription_create", "subscription_cycle"].includes(
			invoice.billing_reason ?? "",
		) ||
		invoice.lines.has_more
	)
		return null;
	const lines = invoice.lines.data.filter((line) => {
		const details = line.parent?.subscription_item_details;
		return (
			details?.subscription_item === planItemId &&
			details.subscription === subscriptionId &&
			!details.proration
		);
	});
	if (lines.length !== 1) return null;
	const period = lines[0]!.period;
	if (
		!Number.isSafeInteger(period.start) ||
		!Number.isSafeInteger(period.end) ||
		period.end <= period.start
	)
		return null;
	return {
		subscriptionId,
		invoiceId: invoice.id,
		periodStart: new Date(period.start * 1000).toISOString(),
		periodEnd: new Date(period.end * 1000).toISOString(),
	};
}
