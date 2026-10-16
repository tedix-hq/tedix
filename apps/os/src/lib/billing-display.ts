import type {
	BillingOverview,
	BillingPlanCatalogItem,
} from "@tedix/api-contract/schemas/billing";

type BillingSnapshot = BillingOverview["snapshot"];
type BillingPlan = BillingOverview["plan"];

/**
 * Enterprise v4 is represented as zero included tokens plus zero-priced
 * overage. Treating the zero as an allowance denominator produces a false
 * exhausted state; the combination is an unlimited customer-usage contract.
 */
export function hasUnlimitedTokenUsage(
	snapshot: Pick<BillingSnapshot, "includedTokens" | "allowOverage">,
	plan: Pick<BillingPlan, "overageUnitPriceMicros">,
): boolean {
	return (
		snapshot.includedTokens < 0 ||
		(snapshot.includedTokens === 0 &&
			snapshot.allowOverage &&
			plan.overageUnitPriceMicros === 0)
	);
}

export function formatPlanTokenAllowance(
	plan: Pick<
		BillingPlanCatalogItem,
		"includedMonthlyTokens" | "overageUnitPriceMicros"
	>,
): string {
	if (
		plan.includedMonthlyTokens < 0 ||
		(plan.includedMonthlyTokens === 0 && plan.overageUnitPriceMicros === 0)
	) {
		return "Unlimited tokens";
	}
	if (plan.includedMonthlyTokens >= 1_000_000) {
		return `${plan.includedMonthlyTokens / 1_000_000}M tokens/mo`;
	}
	if (plan.includedMonthlyTokens >= 1_000) {
		return `${plan.includedMonthlyTokens / 1_000}K tokens/mo`;
	}
	return `${plan.includedMonthlyTokens} tokens/mo`;
}

export function formatPlanLimit(value: number): string {
	return value < 0 ? "Unlimited" : value.toLocaleString();
}

/** Share of an allowance or limit left (or used) at which the sidebar speaks up. */
const LOW_SHARE = 0.2;
const MIN_LOW_CREDIT_MICROS = 1_000_000;

/**
 * Whether the plan balance needs the owner's attention: billing action
 * required, an inference gate closed, a limit nearly reached, or a low
 * balance. A healthy or unlimited plan stays reachable from settings instead
 * of occupying the sidebar. Display only; it never changes what is billed.
 */
export function billingNeedsAttention(
	overview: Pick<
		BillingOverview,
		"snapshot" | "plan" | "credits" | "inferenceCapacity"
	>,
): boolean {
	const { snapshot, plan, credits, inferenceCapacity } = overview;
	if (
		snapshot.status === "past_due" ||
		snapshot.status === "suspended" ||
		snapshot.status === "cancelled"
	)
		return true;
	if (
		inferenceCapacity.blockingReason !== null ||
		inferenceCapacity.unblockAction !== "none"
	)
		return true;
	if (
		snapshot.hardSpendLimitMicros !== null &&
		snapshot.hardSpendLimitMicros > 0 &&
		snapshot.customerChargeMicros >=
			snapshot.hardSpendLimitMicros * (1 - LOW_SHARE)
	)
		return true;
	if (credits?.billingMode === "monetary") {
		if (
			credits.monthlyCapMicros !== null &&
			credits.monthlyCapMicros > 0 &&
			credits.spentMicros >= credits.monthlyCapMicros * (1 - LOW_SHARE)
		)
			return true;
		return (
			credits.availableMicros <
			Math.max(credits.includedMicros * LOW_SHARE, MIN_LOW_CREDIT_MICROS)
		);
	}
	if (hasUnlimitedTokenUsage(snapshot, plan)) return false;
	return (
		snapshot.includedTokens > 0 &&
		snapshot.remainingIncludedTokens < snapshot.includedTokens * LOW_SHARE
	);
}
