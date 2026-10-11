import { formatBillingAmount } from "@/lib/billing-price";

/** Read-only denomination. Billing rounds once in the ledger, never here. */
export function formatUsageCredits(
	micros: number,
	creditValueMicros = 10_000,
): string {
	const count = micros / creditValueMicros;
	if (count > 0 && count < 0.01) return "<0.01 credits";
	if (count < 0 && count > -0.01) return ">−0.01 credits";
	return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(count)} credits`;
}

export function formatCreditWorth(micros: number, currency = "usd"): string {
	if (micros !== 0 && Math.abs(micros) < 10_000) {
		return new Intl.NumberFormat("en-US", {
			style: "currency",
			currency: currency.toUpperCase(),
			maximumFractionDigits: 6,
		}).format(micros / 1_000_000);
	}
	return formatBillingAmount(micros, currency);
}
