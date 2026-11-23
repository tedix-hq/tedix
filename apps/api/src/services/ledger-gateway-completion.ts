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
	},
): Promise<Response | null> {
	const gatewayId = env.AI_GATEWAY_LLM_ID ?? "";
	const transport = resolveAiGatewayTransport(env, gatewayId, "azure-openai");
	const resource = env.AZURE_OPENAI_RESOURCE?.trim().toLowerCase();
	if (!transport || !resource || !/^[a-z0-9-]+$/.test(resource)) return null;
	const url = `${transport.providerRoot}/${resource}/openai/v1/responses`;
	const body = JSON.stringify({
		model: input.model,
		instructions: input.system,
		input: input.prompt,
		max_output_tokens: 6000,
		reasoning: { effort: "low" },
	});
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
}
