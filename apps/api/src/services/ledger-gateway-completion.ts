import { azureExecutionIdentity } from "@tedix/api-contract/schemas/provider-execution";
import type { RuntimeEntitlementUsageSourceSchema } from "@tedix/api-contract/schemas/runtime-entitlements";
import {
	aiGatewayCustomCost,
	resolveAiGatewayTransport,
	type AiGatewayTransportEnv,
} from "@tedix/workers-ai/gateway-transport";
import type { z } from "zod";
import {
	kernelProviderRate,
	kernelRegionalExecution,
	reserveKernelBilling,
} from "../rpc/routers/kernel/billing-reservation";
import { kernelGatewayMetadata } from "../rpc/routers/kernel/gateway-attribution";

export type LedgerGatewayEnv = AiGatewayTransportEnv & {
	DB?: D1Database;
	TEDIX_BILLING_SETTLEMENT_MODE?: string;
	SECRETS_MASTER_KEY?: string;
	AI_GATEWAY_LLM_ID?: string;
	AZURE_OPENAI_RESOURCE?: string;
};

/**
 * The caller owns organization egress admission before invoking this transport.
 * Each call is admitted as a provider execution so Gateway cost ingestion can
 * attribute and price its log from that record.
 */
export async function fetchLedgerGatewayCompletion(
	env: LedgerGatewayEnv,
	input: {
		organizationId: string;
		/** Gateway `source` label for this call. */
		source: string;
		billingSource: z.infer<typeof RuntimeEntitlementUsageSourceSchema>;
		model: string;
		system: string;
		prompt: string;
		/** Member whose own agent session this call reads; billed to them. */
		userId?: string;
		/** `<harness>:<session key>` of that session. */
		sessionKey?: string;
		/**
		 * Characters at the start of `prompt` that repeat across calls (the
		 * ledger rows). Cached with an explicit breakpoint; the rest is not.
		 */
		stablePrefixLength?: number;
	},
): Promise<Response | null> {
	const gatewayId = env.AI_GATEWAY_LLM_ID ?? "";
	const transport = resolveAiGatewayTransport(env, gatewayId, "azure-openai");
	const resource = env.AZURE_OPENAI_RESOURCE?.trim().toLowerCase();
	if (!transport || !resource || !/^[a-z0-9-]+$/.test(resource)) return null;
	const url = `${transport.providerRoot}/${resource}/openai/v1/responses`;
	// GPT-6.1 deployments write the whole prompt to the cache by default and
	// charge 25% over plain input for it. Ledger prompts end in a new turn every
	// time, so that write was almost never read (7% of input on 15-22 Nov).
	// Explicit mode caches only the stable rows prefix.
	const split = Math.min(input.stablePrefixLength ?? 0, input.prompt.length);
	const content = [
		...(split > 0
			? [
					{
						type: "input_text",
						text: input.prompt.slice(0, split),
						prompt_cache_breakpoint: { mode: "explicit" },
					},
				]
			: []),
		...(split < input.prompt.length
			? [{ type: "input_text", text: input.prompt.slice(split) }]
			: []),
	];
	const request = {
		model: input.model,
		instructions: input.system,
		input: [{ type: "message", role: "user", content }],
		max_output_tokens: 6000,
		reasoning: { effort: "low" },
	};
	const send = async (body: string) => {
		const admitted = await reserveKernelBilling(env, {
			context: {
				organizationId: input.organizationId,
				source: input.source,
				...(input.userId ? { userId: input.userId } : {}),
				...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
			},
			source: input.billingSource,
			execution: azureExecutionIdentity({
				url,
				model: input.model,
				accountId: env.AI_GATEWAY_ACCOUNT_ID,
				gatewayId,
				transportKind: transport.kind,
			}),
			body,
		});
		if (kernelRegionalExecution(admitted))
			throw new Error("Ledger model calls have no regional provider route");
		const rate = kernelProviderRate(admitted);
		return transport.fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-aig-authorization": `Bearer ${transport.authorization}`,
				"cf-aig-no-wholesale": "true",
				"cf-aig-metadata": JSON.stringify(kernelGatewayMetadata(admitted)),
				...(rate ? { "cf-aig-custom-cost": aiGatewayCustomCost(rate) } : {}),
			},
			body,
			signal: AbortSignal.timeout(24_000),
		});
	};
	const cached = await send(
		JSON.stringify({
			...request,
			prompt_cache_options: { mode: "explicit" },
			...(input.sessionKey
				? { prompt_cache_key: `ledger:${input.source}:${input.sessionKey}` }
				: {}),
		}),
	);
	// A deployment without cache breakpoints answers 400; keep the ledger working.
	if (cached.status !== 400) return cached;
	console.warn({
		event: "ledger_gateway.cache_options_rejected",
		model: input.model,
	});
	return send(
		JSON.stringify({
			...request,
			input: input.prompt,
		}),
	);
}
