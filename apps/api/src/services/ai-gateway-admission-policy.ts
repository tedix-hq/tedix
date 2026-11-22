import {
	findCatalogEntry,
	CLOUDFLARE_AUTO_MODEL_REF,
	type ModelCatalogEntry,
} from "@tedix/api-contract/schemas/model-catalog";
import { DecisionModelSchema } from "@tedix/api-contract/schemas/jev";
import { JEV_DIRECT_MODEL } from "@tedix/workers-ai/jev";
import type { AiGatewayAdmissionPolicy } from "@tedix/api-contract/schemas/tedi";

export interface EffectiveAiGatewayAdmissionPolicy {
	organization?: AiGatewayAdmissionPolicy;
	tedi?: AiGatewayAdmissionPolicy;
}

export function resolveAiGatewayAdmissionPolicy(input: {
	organization: AiGatewayAdmissionPolicy;
	tedi?: AiGatewayAdmissionPolicy;
}): EffectiveAiGatewayAdmissionPolicy {
	return { organization: input.organization, tedi: input.tedi };
}

/**
 * Platform decision models (the closed Jev/Clef set, including the pinned
 * direct-TypeSafe wire id) are invoked by platform features, never selected
 * from the catalog, so catalog membership cannot gate them. Org and tedi tier
 * policy constrains selectable models only; credit reservation still applies.
 */
function isPlatformDecisionModel(model: string): boolean {
	return (
		DecisionModelSchema.safeParse(model).success || model === JEV_DIRECT_MODEL
	);
}

/** Registered models must satisfy every configured scope's tier policy. */
export function aiGatewayModelTierAllowed(
	provider: string,
	model: string,
	policy: EffectiveAiGatewayAdmissionPolicy,
	catalog: readonly ModelCatalogEntry[] = [],
): boolean {
	if (isPlatformDecisionModel(model)) return true;
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
