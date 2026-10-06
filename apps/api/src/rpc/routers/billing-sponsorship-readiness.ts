import type { InferenceCapacityDailyOverview } from "@tedix/db/queries/billing/capacity-allocations";

export type SponsorshipReadinessStatus =
	| "disabled"
	| "customer_funded"
	| "ready"
	| "allowance_exhausted"
	| "provider_capacity_insufficient";

export function resolveSponsorshipReadiness(input: {
	policy: {
		enabled: boolean;
		maxTransfersPerBudgetDay: number;
		lowWatermarkTokens: number;
		lowWatermarkSpendMicros: number;
		transferTokens: number;
		transferSpendMicros: number;
	} | null;
	provider: InferenceCapacityDailyOverview;
	customer: InferenceCapacityDailyOverview;
	providerPolicyAvailable: boolean;
	providerDailyTokenLimit: number | null;
	providerDailySpendLimitMicros: number | null;
	transfersUsed: number;
}): {
	budgetDay: string;
	status: SponsorshipReadinessStatus;
	transfersUsed: number;
	transfersRemaining: number;
	resetsAt: string;
} {
	const { policy } = input;
	const transfersRemaining = Math.max(
		0,
		(policy?.maxTransfersPerBudgetDay ?? 0) - input.transfersUsed,
	);
	let status: SponsorshipReadinessStatus = "disabled";
	if (policy?.enabled && !input.providerPolicyAvailable) {
		status = "provider_capacity_insufficient";
	} else if (policy?.enabled) {
		const customerFunded =
			input.customer.allocatedTokens - input.customer.usedTokens > 0 &&
			input.customer.allocatedSpendMicros - input.customer.usedSpendMicros > 0;
		const transferableTokens =
			input.providerDailyTokenLimit === null
				? Number.POSITIVE_INFINITY
				: input.providerDailyTokenLimit +
					input.provider.allocatedTokens -
					input.provider.usedTokens;
		const transferableSpend =
			input.providerDailySpendLimitMicros === null
				? Number.POSITIVE_INFINITY
				: input.providerDailySpendLimitMicros +
					input.provider.allocatedSpendMicros -
					input.provider.usedSpendMicros;
		if (customerFunded) status = "customer_funded";
		else if (transfersRemaining === 0) status = "allowance_exhausted";
		else if (
			transferableTokens >= policy.transferTokens &&
			transferableSpend >= policy.transferSpendMicros
		)
			status = "ready";
		else status = "provider_capacity_insufficient";
	}
	const resetsAt = new Date(
		Date.parse(`${input.customer.budgetDay}T00:00:00.000Z`) + 86_400_000,
	).toISOString();
	return {
		budgetDay: input.customer.budgetDay,
		status,
		transfersUsed: input.transfersUsed,
		transfersRemaining,
		resetsAt,
	};
}
