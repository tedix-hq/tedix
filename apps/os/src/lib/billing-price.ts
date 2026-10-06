/**
 * Catalog prices are stored in micros. Whole-dollar subscription prices render
 * compact ("$249"), while sub-dollar metered unit prices keep the precision
 * micros can express instead of rounding to "$0".
 */
export function formatBillingPrice(micros: number, currency = "usd") {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: currency.toUpperCase(),
		minimumFractionDigits: 0,
		maximumFractionDigits: 6,
	}).format(micros / 1_000_000);
}

/**
 * Human-facing balances and totals should never expose storage precision.
 * Render at most cents and omit trailing zeroes ("$45.26", "$25", "$0").
 */
export function formatCurrencyAmount(
	amount: number,
	currency = "usd",
	maximumFractionDigits = 2,
) {
	return new Intl.NumberFormat("en-US", {
		style: "currency",
		currency: currency.toUpperCase(),
		minimumFractionDigits: 0,
		maximumFractionDigits,
	}).format(amount);
}

export function formatBillingAmount(micros: number, currency = "usd") {
	return formatCurrencyAmount(micros / 1_000_000, currency);
}
