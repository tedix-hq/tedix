/**
 * Tedix credits: the one unit customers see and are limited by.
 *
 * 1 credit = €0.01 = 10,000 EUR micros. Every limit is monthly. The shapes
 * below mirror `billing.getOverview().credits`, `billing.listPlans`,
 * `billing.listTopUpPacks`, `billing.setCreditCaps` and
 * `billing.setPayAsYouGo` in `@tedix/api-contract`; components take these
 * props so the screen code stays independent of the rest of the overview.
 */

import { formatBillingAmount } from "@/lib/billing-price";
import { formatCount } from "@/lib/format";

export const CREDIT_VALUE_MICROS = 10_000;

export type CreditPlanKey = "starter" | "growth" | "business" | "enterprise";
export type CreditNoticeThreshold = 80 | 100;

export type CreditBreakdown = {
	ai: number;
	codeRuns: number;
	services: number;
};

export type CreditNotice = {
	threshold: CreditNoticeThreshold;
	reachedAt: string;
};

export type CreditPayAsYouGo = {
	enabled: boolean;
	monthlyCapMicros: number | null;
	spentMicros: number;
};

export type CreditTediUsage = {
	tediId: string;
	name: string;
	usedCredits: number;
	monthlyCapCredits: number | null;
};

export type CreditMemberUsage = {
	userId: string;
	name: string;
	usedCredits: number;
	monthlyCapCredits: number | null;
};

export type CreditUsage = {
	periodStart: string;
	periodEnd: string;
	includedCredits: number;
	usedCredits: number;
	remainingIncludedCredits: number;
	topUpCredits: number;
	breakdown: CreditBreakdown;
	notices: CreditNotice[];
	payAsYouGo: CreditPayAsYouGo;
	tedis: CreditTediUsage[];
	members: CreditMemberUsage[];
};

export type CreditPlan = {
	key: CreditPlanKey;
	name: string;
	priceMicros: number;
	currency: "eur";
	includedCredits: number;
};

export type CreditTopUpPack = {
	packKey: string;
	credits: number;
	priceMicros: number;
	currency: "eur";
	validMonths: 12;
};

export type CreditCapInput = {
	tediCaps?: Array<{ tediId: string; monthlyCapCredits: number | null }>;
	memberCaps?: Array<{ userId: string; monthlyCapCredits: number | null }>;
};

export type PayAsYouGoInput = {
	enabled: boolean;
	monthlyCapMicros: number | null;
};

/** "1,234 credits"; "1 credit". Credits are whole numbers. */
export function formatCredits(credits: number): string {
	const whole = Math.round(credits);
	return `${formatCount(whole)} ${whole === 1 ? "credit" : "credits"}`;
}

/** What a number of credits costs in euros: 1,000 → "€10". */
export function creditsInEuros(credits: number): string {
	return formatBillingAmount(credits * CREDIT_VALUE_MICROS, "eur");
}

/** Credits a euro amount buys, rounded down: €0.50 in micros → 50. */
export function microsToCredits(micros: number): number {
	return Math.floor(micros / CREDIT_VALUE_MICROS);
}

export type CreditLevel = "ok" | "warn" | "full";

/** Warn at 80% of a limit; at 100% the limit is reached. */
export function creditLevel(used: number, limit: number): CreditLevel {
	if (limit <= 0) return used > 0 ? "full" : "ok";
	const share = used / limit;
	if (share >= 1) return "full";
	if (share >= 0.8) return "warn";
	return "ok";
}

/** Whole-number percent of a limit, capped at 100 for meters. */
export function creditPercent(used: number, limit: number): number {
	if (limit <= 0) return used > 0 ? 100 : 0;
	return Math.min(100, Math.round((used / limit) * 100));
}

/** Pay-as-you-go room left this month, in credits. */
export function payAsYouGoRemainingCredits(payAsYouGo: CreditPayAsYouGo) {
	if (!payAsYouGo.enabled || payAsYouGo.monthlyCapMicros === null) return 0;
	return microsToCredits(
		Math.max(0, payAsYouGo.monthlyCapMicros - payAsYouGo.spentMicros),
	);
}

/**
 * Credits the organization can still use this month: what is left of the
 * plan, then top-ups, then pay-as-you-go up to its cap.
 */
export function availableCredits(credits: CreditUsage): number {
	return (
		credits.remainingIncludedCredits +
		credits.topUpCredits +
		payAsYouGoRemainingCredits(credits.payAsYouGo)
	);
}

/** True when nothing is left to spend, so new work stops until next month. */
export function creditsPaused(credits: CreditUsage): boolean {
	return availableCredits(credits) <= 0;
}

/** The highest notice raised this month, if any. */
export function latestCreditNotice(credits: CreditUsage): CreditNotice | null {
	return credits.notices.reduce<CreditNotice | null>(
		(highest, notice) =>
			highest === null || notice.threshold > highest.threshold
				? notice
				: highest,
		null,
	);
}

export const MAX_PAY_AS_YOU_GO_CAP_EUROS = 1_000_000;

/** Parse a euro cap typed by an admin into micros; null when invalid. */
export function parseEuroCapMicros(value: string): number | null {
	const euros = Number(value.trim());
	if (
		value.trim() === "" ||
		!Number.isFinite(euros) ||
		euros <= 0 ||
		euros > MAX_PAY_AS_YOU_GO_CAP_EUROS
	)
		return null;
	return Math.round(euros * 100) * CREDIT_VALUE_MICROS;
}

export type ParsedCreditCap =
	| { ok: true; monthlyCapCredits: number | null }
	| { ok: false; message: string };

/**
 * Parse a per-tedi or per-member cap. Empty means no separate cap (the
 * organization's monthly credits still apply). A cap can only be lower than
 * what the organization has this month, never a way to add credits.
 */
export function parseCreditCap(
	value: string,
	maxCredits: number,
): ParsedCreditCap {
	const trimmed = value.trim();
	if (trimmed === "") return { ok: true, monthlyCapCredits: null };
	const credits = Number(trimmed);
	if (!Number.isInteger(credits) || credits < 0) {
		return { ok: false, message: "Enter a whole number of credits." };
	}
	if (credits > maxCredits) {
		return {
			ok: false,
			message: `A cap can be at most ${formatCredits(maxCredits)}, the organization's monthly credits.`,
		};
	}
	return { ok: true, monthlyCapCredits: credits };
}
