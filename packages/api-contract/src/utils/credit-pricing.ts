/**
 * Tedix credit pricing. One credit is EUR 0.01. AI use costs the provider
 * price converted to EUR at the plan's pinned reference rate, times two,
 * rounded up per call. A code run costs one credit. Service operations keep
 * the fixed credit cost of their rate card.
 */

/** 1 credit = EUR 0.01, in EUR micros. */
export const CREDIT_VALUE_EUR_MICROS = 10_000;

/** Monthly included credits plus the remaining and already-spent top-ups. */
export function monthlyAllowanceCredits(credits: {
	includedCredits: number;
	topUpCredits: number;
	usedCredits: number;
	payAsYouGo: { spentMicros: number };
}): number {
	const payAsYouGoUsed = Math.floor(
		credits.payAsYouGo.spentMicros / CREDIT_VALUE_EUR_MICROS,
	);
	const topUpUsed = Math.max(
		0,
		credits.usedCredits - credits.includedCredits - payAsYouGoUsed,
	);
	return credits.includedCredits + credits.topUpCredits + topUpUsed;
}

/** AI use is billed at twice the provider cost. */
export const AI_CREDIT_COST_MULTIPLIER = 2;

/** Every Code Mode or dynamic Worker execution costs one credit. */
export const CODE_RUN_CREDITS = 1;

/** Purchased or converted top-up credits stay usable for this many months. */
export const TOP_UP_VALID_MONTHS = 12;

/** Usage notices are raised once per billing period at these percentages. */
export const CREDIT_NOTICE_THRESHOLDS = [80, 100] as const;
export type CreditNoticeThreshold = (typeof CREDIT_NOTICE_THRESHOLDS)[number];

/** EUR micros for USD micros at an ECB reference rate (USD per EUR), rounded up. */
export function eurMicrosFromUsdMicros(
	usdMicros: number,
	microUsdPerEur: number,
): number {
	if (!Number.isSafeInteger(usdMicros) || usdMicros < 0)
		throw new Error("Provider cost must be a non-negative safe integer");
	if (!Number.isSafeInteger(microUsdPerEur) || microUsdPerEur <= 0)
		throw new Error("FX rate must be a positive safe integer");
	const eur =
		(BigInt(usdMicros) * 1_000_000n + BigInt(microUsdPerEur) - 1n) /
		BigInt(microUsdPerEur);
	if (eur > BigInt(Number.MAX_SAFE_INTEGER))
		throw new Error("Converted price exceeds safe monetary precision");
	return Number(eur);
}

/** Credits for one AI call: ceil(provider cost in EUR x 2 / EUR 0.01). */
export function aiCreditsForProviderCost(
	providerCostUsdMicros: number,
	microUsdPerEur: number,
): number {
	const eurMicros = eurMicrosFromUsdMicros(
		providerCostUsdMicros,
		microUsdPerEur,
	);
	return Math.ceil(
		(eurMicros * AI_CREDIT_COST_MULTIPLIER) / CREDIT_VALUE_EUR_MICROS,
	);
}

/** Pay-as-you-go price of credits beyond the pool, in EUR micros. */
export function payAsYouGoMicros(credits: number): number {
	return credits * CREDIT_VALUE_EUR_MICROS;
}

/** Credits used as a whole percentage of a limit; a zero limit reads as 100%. */
export function creditUsagePercent(used: number, limit: number): number {
	if (limit <= 0) return used > 0 ? 100 : 0;
	return Math.floor((used * 100) / limit);
}
