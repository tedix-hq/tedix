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
