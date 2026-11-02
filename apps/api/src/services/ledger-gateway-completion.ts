import {
	resolveAiGatewayTransport,
	type AiGatewayTransportEnv,
} from "@tedix/workers-ai/gateway-transport";

/** The caller owns organization egress admission before invoking this transport. */
export function fetchLedgerGatewayCompletion(
	env: AiGatewayTransportEnv & {
		AI_GATEWAY_LLM_ID?: string;
		AZURE_OPENAI_RESOURCE?: string;
	},
	input: {
		model: string;
		system: string;
		prompt: string;
		metadata: Record<string, string>;
	},
): Promise<Response> | null {
	const transport = resolveAiGatewayTransport(
		env,
		env.AI_GATEWAY_LLM_ID ?? "",
		"azure-openai",
	);
	const resource = env.AZURE_OPENAI_RESOURCE?.trim();
	if (!transport || !resource || !/^[a-zA-Z0-9-]+$/.test(resource)) return null;
	return transport.fetch(
		`${transport.providerRoot}/${resource}/openai/v1/responses`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-aig-authorization": `Bearer ${transport.authorization}`,
				"cf-aig-no-wholesale": "true",
				"cf-aig-metadata": JSON.stringify(input.metadata),
			},
			body: JSON.stringify({
				model: input.model,
				instructions: input.system,
				input: input.prompt,
				max_output_tokens: 6000,
				reasoning: { effort: "low" },
			}),
			signal: AbortSignal.timeout(24_000),
		},
	);
}
