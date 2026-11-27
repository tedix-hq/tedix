/**
 * Prices one workspace chat turn against the governed provider rate table, so
 * the chat can show what a turn cost or say exactly why it cannot.
 */
import { resolveDirectProviderUsagePrice } from "@tedix/db/queries/billing/provider-model-rates";
import type { DbQueryClient } from "@tedix/db/query-client";
import { type AzureGatewayEnv, turnPricingIdentity } from "./model";
import type { TurnResult } from "./turn-loop";
import type { TurnUsage } from "./wire";

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
	db: DbQueryClient | D1Database | undefined,
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
