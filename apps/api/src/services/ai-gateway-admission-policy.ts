import {
	findCatalogEntry,
	CLOUDFLARE_AUTO_MODEL_REF,
	type ModelCatalogEntry,
} from "@tedix/api-contract/schemas/model-catalog";
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

/** Registered models must satisfy every configured scope's tier policy. */
export function aiGatewayModelTierAllowed(
	provider: string,
	model: string,
	policy: EffectiveAiGatewayAdmissionPolicy,
	catalog: readonly ModelCatalogEntry[] = [],
): boolean {
	const constrained = [policy.organization, policy.tedi].filter(
		(scope) => scope?.allowedModelTiers !== undefined,
	);
	const ref =
		provider === "workers-ai" && model === CLOUDFLARE_AUTO_MODEL_REF
			? model
			: `${provider}/${model}`;
	const entry = findCatalogEntry(ref, catalog);
	if (!entry) return false;
	return constrained.every((scope) =>
		scope?.allowedModelTiers?.includes(entry.tier),
	);
}
