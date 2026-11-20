/**
 * Tedix credits: the one unit customers see and are limited by.
 *
 * 1 credit = €0.01 = 10,000 EUR micros. Every limit is monthly. The types
 * below name the `billing.getOverview().credits`, `billing.listPlans`,
 * `billing.listTopUpPacks`, `billing.setCreditCaps` and
 * `billing.setPayAsYouGo` shapes from `@tedix/api-contract`; components take
 * these props so the screen code stays independent of the rest of the
 * overview.
 */

import type {
	BillingCredits,
	BillingPlan,
	BillingTopUpPack,
	SetPayAsYouGoInput,
} from "@tedix/api-contract/schemas/billing";
import { formatCount } from "@/lib/format";

export const CREDIT_VALUE_MICROS = 10_000;

export type CreditUsage = BillingCredits;
export type CreditPlan = BillingPlan;
export type CreditPlanKey = BillingPlan["key"];
export type CreditTopUpPack = BillingTopUpPack;
export type PayAsYouGoInput = SetPayAsYouGoInput;
export type CreditNotice = BillingCredits["notices"][number];
export type CreditNoticeThreshold = CreditNotice["threshold"];
export type CreditPayAsYouGo = BillingCredits["payAsYouGo"];

/** "1,234 credits"; "1 credit". Credits are whole numbers. */
export function formatCredits(credits: number): string {
	const whole = Math.round(credits);
	return `${formatCount(whole)} ${whole === 1 ? "credit" : "credits"}`;
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

/**
 * Whole percent of a limit used, rounded down and capped at 100, so 100%
 * only shows once the limit is actually reached. Usage under 1% is 0 here;
 * `formatUsagePercent` shows it as "<1%".
 */
export function usagePercent(used: number, limit: number): number {
	if (used <= 0) return 0;
	if (limit <= 0) return 100;
	// Integer math: (29 / 100) * 100 is 28.999… in floating point.
	return Math.min(100, Math.floor((used * 100) / limit));
}

/** "23%", "<1%" for small non-zero usage, "100%" once the limit is reached. */
export function formatUsagePercent(used: number, limit: number): string {
	if (used > 0 && limit > 0 && used * 100 < limit) return "<1%";
	return `${usagePercent(used, limit)}%`;
}

/**
 * This month's allowance: the plan's included credits plus the top-up
 * credits available this period. `topUpCredits` is what is still unused, so
 * the top-up credits this month already drew on are added back; otherwise
 * the share would jump as top-ups are spent. Pay-as-you-go is not part of
 * the allowance.
 */
export function monthlyAllowanceCredits(credits: CreditUsage): number {
	const payAsYouGoUsed = microsToCredits(credits.payAsYouGo.spentMicros);
	const topUpUsedThisMonth = Math.max(
		0,
		credits.usedCredits - credits.includedCredits - payAsYouGoUsed,
	);
	return credits.includedCredits + credits.topUpCredits + topUpUsedThisMonth;
}

export type AllowanceUsage = {
	/** Whole percent for meters, 0–100. */
	percent: number;
	/** "23%", "<1%" or "100%". */
	label: string;
};

/** How much of this month's allowance a part of the usage (one conversation) is. */
export function allowanceShare(
	credits: CreditUsage,
	used: number,
): AllowanceUsage {
	const allowance = monthlyAllowanceCredits(credits);
	return {
		percent: usagePercent(used, allowance),
		label: formatUsagePercent(used, allowance),
	};
}

/**
 * How much of this month's allowance the organization has used. When it is
 * out of credits this reads 100%, whatever the counts say.
 */
export function allowanceUsage(credits: CreditUsage): AllowanceUsage {
	if (creditsPaused(credits)) return { percent: 100, label: "100%" };
	return allowanceShare(credits, credits.usedCredits);
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
