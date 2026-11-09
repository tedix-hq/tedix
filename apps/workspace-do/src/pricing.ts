/**
 * Prices one workspace chat turn against the governed provider rate table, so
 * the chat can show what a turn cost or say exactly why it cannot.
 */
import { resolveDirectProviderUsagePrice } from "@tedix/db/queries/billing/provider-model-rates";
import { type AzureGatewayEnv, configured } from "./model";
import type { TurnResult } from "./turn-loop";
import type { TurnUsage } from "./wire";

/** The rate-table identity for a workspace model, matching `providerDeploymentScope`. */
export function turnPricingIdentity(
	env: AzureGatewayEnv,
	modelId: string,
): { provider: string; modelId: string; deploymentScope: string } | null {
	const account = configured(env.AI_GATEWAY_ACCOUNT_ID);
	if (!account) return null;
	if (modelId.startsWith("@cf/"))
		return {
			provider: "workers-ai",
			modelId,
			deploymentScope: JSON.stringify(["workers-ai", account]),
		};
	const resource = configured(env.AZURE_OPENAI_RESOURCE);
	const deployment = configured(env.AZURE_CHAT_DEPLOYMENT);
	const gateway = configured(env.AI_GATEWAY_LLM_ID);
	if (!resource || !deployment || !gateway) return null;
	return {
		provider: "azure-openai",
		modelId: deployment,
		deploymentScope: JSON.stringify([
			"azure-openai",
			account,
			gateway,
			`https://${resource.toLowerCase()}.openai.azure.com`,
			deployment,
		]),
	};
}

const REASONS: Record<string, string> = {
	missing_rate: "no price for this model",
	ambiguous_rate: "price is ambiguous",
	invalid_usage: "usage incomplete",
	partial_usage: "usage incomplete",
	not_configured: "model not priced here",
	lookup_failed: "price lookup failed",
};

/** Cost fields for a finished turn; never a fabricated zero. */
export async function priceTurn(
	db: D1Database | undefined,
	env: AzureGatewayEnv,
	modelId: string | undefined,
	usage: NonNullable<TurnResult["usage"]>,
	occurredAt: string,
): Promise<Pick<TurnUsage, "costUsd" | "costUnavailable">> {
	if (usage.partial) return { costUnavailable: REASONS.partial_usage };
	const identity = modelId ? turnPricingIdentity(env, modelId) : null;
	if (!db || !identity) return { costUnavailable: REASONS.not_configured };
	try {
		const priced = await resolveDirectProviderUsagePrice(
			db,
			{ ...identity, occurredAt },
			{
				inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
				outputTokens: usage.output,
				cacheReadTokens: usage.cacheRead,
				cacheWriteTokens: usage.cacheWrite,
			},
		);
		return priced.costUsd === null
			? {
					costUnavailable:
						REASONS[priced.reason ?? "missing_rate"] ?? REASONS.missing_rate,
				}
			: { costUsd: priced.costUsd };
	} catch {
		return { costUnavailable: REASONS.lookup_failed };
	}
}
