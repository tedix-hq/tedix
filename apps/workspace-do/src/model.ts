/**
 * The one way the loop talks to a model. Production streams the Azure
 * OpenAI Responses API through the authenticated AI Gateway (same vars and
 * headers as the tedi runtime); tests plug in pi's faux provider.
 */
import type {
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

export interface ModelPort {
	/** Model id for the prompt-cache key and telemetry. */
	id: string;
	contextWindow: number;
	maxOutputTokens: number;
	stream(
		context: Context,
		options?: { signal?: AbortSignal; maxTokens?: number },
	): AssistantMessageEventStream;
}

export interface AzureGatewayEnv {
	AZURE_OPENAI_RESOURCE?: string;
	AZURE_OPENAI_API_VERSION?: string;
	AZURE_CHAT_DEPLOYMENT?: string;
	AI_GATEWAY_ACCOUNT_ID?: string;
	AI_GATEWAY_LLM_ID?: string;
	CF_AI_GATEWAY_TOKEN?: string;
}

/** Placeholder that an unconfigured local checkout carries. */
const PLACEHOLDER = "configured-via-private-overlay";

function configured(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed && trimmed !== PLACEHOLDER ? trimmed : undefined;
}

export function azureGatewayConfigured(env: AzureGatewayEnv): boolean {
	return Boolean(
		configured(env.AZURE_OPENAI_RESOURCE) &&
		configured(env.AZURE_CHAT_DEPLOYMENT) &&
		configured(env.AI_GATEWAY_ACCOUNT_ID) &&
		configured(env.AI_GATEWAY_LLM_ID) &&
		configured(env.CF_AI_GATEWAY_TOKEN),
	);
}

/** Per-request attribution; the gateway caps this at five flat entries. */
export interface GatewayMetadata {
	workspaceId: string;
	turnId: string;
	actorId: string;
}

export function createAzureGatewayModel(
	env: AzureGatewayEnv,
	metadata: GatewayMetadata,
): ModelPort {
	const resource = configured(env.AZURE_OPENAI_RESOURCE);
	const deployment = configured(env.AZURE_CHAT_DEPLOYMENT);
	const account = configured(env.AI_GATEWAY_ACCOUNT_ID);
	const gateway = configured(env.AI_GATEWAY_LLM_ID);
	const token = configured(env.CF_AI_GATEWAY_TOKEN);
	if (!resource || !deployment || !account || !gateway || !token) {
		throw new Error(
			"Workspace model is not configured: AZURE_OPENAI_RESOURCE, AZURE_CHAT_DEPLOYMENT, AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_LLM_ID and CF_AI_GATEWAY_TOKEN are required",
		);
	}
	// https://developers.cloudflare.com/ai-gateway/providers/azureopenai/
	const baseUrl = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/azure-openai/${resource}/openai/v1`;
	const model: Model<"azure-openai-responses"> = {
		id: deployment,
		name: deployment,
		api: "azure-openai-responses",
		provider: "azure-openai-responses",
		baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 16_000,
		headers: {
			"cf-aig-authorization": `Bearer ${token}`,
			// Stored BYOK credentials are authoritative; never fall back to wholesale.
			"cf-aig-no-wholesale": "true",
			"cf-aig-metadata": JSON.stringify({
				surface: "workspace_object",
				workspaceId: metadata.workspaceId,
				turnId: metadata.turnId,
				actorId: metadata.actorId,
			}),
		},
	};
	return {
		id: `azure-openai/${deployment}`,
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		stream(context, options) {
			const streamOptions: SimpleStreamOptions = {
				apiKey: "cloudflare-ai-gateway-byok",
				fetch: (input, init) => {
					const request = new Request(input, init);
					const url = new URL(request.url);
					// This endpoint uses the GA v1 path, not a dated preview version.
					url.searchParams.delete("api-version");
					// Provider credentials override the Gateway's stored BYOK key.
					request.headers.delete("api-key");
					request.headers.delete("authorization");
					return fetch(new Request(url, request));
				},
				signal: options?.signal,
				maxTokens: options?.maxTokens ?? model.maxTokens,
				azureBaseUrl: baseUrl,
				azureDeploymentName: deployment,
				azureApiVersion: configured(env.AZURE_OPENAI_API_VERSION) ?? "v1",
			} as SimpleStreamOptions;
			return streamSimple(model, normalizeContext(context), streamOptions);
		},
	};
}
