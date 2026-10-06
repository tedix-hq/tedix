import { findCatalogEntry } from "@tedix/api-contract/schemas/model-catalog";
import type { AiGatewayAdmissionPolicy } from "@tedix/api-contract/schemas/tedi";

export interface EffectiveAiGatewayAdmissionPolicy {
	organization?: AiGatewayAdmissionPolicy;
	tedi?: AiGatewayAdmissionPolicy;
}

export interface AiGatewayReservationLimits {
	organizationDailyTokenLimit?: number;
	organizationDailySpendLimitMicros?: number;
	tediDailyTokenLimit?: number;
	tediDailySpendLimitMicros?: number;
}

export function aiGatewayReservationLimits(
	policy: EffectiveAiGatewayAdmissionPolicy,
): AiGatewayReservationLimits | undefined {
	const limits: AiGatewayReservationLimits = {
		organizationDailyTokenLimit: policy.organization?.dailyTokenLimit,
		organizationDailySpendLimitMicros:
			policy.organization?.dailySpendLimitMicros,
		tediDailyTokenLimit: policy.tedi?.dailyTokenLimit,
		tediDailySpendLimitMicros: policy.tedi?.dailySpendLimitMicros,
	};
	return Object.values(limits).some((value) => value !== undefined)
		? limits
		: undefined;
}

export function resolveAiGatewayAdmissionPolicy(input: {
	organization: AiGatewayAdmissionPolicy;
	tedi?: AiGatewayAdmissionPolicy;
}): EffectiveAiGatewayAdmissionPolicy {
	return { organization: input.organization, tedi: input.tedi };
}

/** Every configured scope must allow the selected catalog tier. */
export function aiGatewayModelTierAllowed(
	provider: string,
	model: string,
	policy: EffectiveAiGatewayAdmissionPolicy,
): boolean {
	const constrained = [policy.organization, policy.tedi].filter(
		(scope) => scope?.allowedModelTiers !== undefined,
	);
	if (constrained.length === 0) return true;
	const entry = findCatalogEntry(`${provider}/${model}`);
	if (!entry) return false;
	return constrained.every((scope) =>
		scope?.allowedModelTiers?.includes(entry.tier),
	);
}
