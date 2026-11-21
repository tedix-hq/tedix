import type { LanguageModel } from "ai";
import { parseModelRef } from "@tedix/api-contract/schemas/model-catalog";
import type { ProviderBeforeDispatch } from "@tedix/workers-ai/gateway-transport";
import { workersAiGatewayTransport } from "@tedix/workers-ai/transport";
import { cloudflareAutoRouterModel } from "@tedix/workers-ai/model-select";
import { azureModel } from "./ai-sdk-adapter";
import {
	azureBaseUrl,
	azureGatewayTransport,
	aigMetadataRecord,
	type AigMetadata,
	type AzureChatEnv,
} from "./llm";
import {
	workersAiClient,
	workersAiRuntimeModel,
	type WorkersAiEnv,
} from "./workers-ai-client";
import type { ModelRequestTelemetry } from "./model-request-telemetry";

/** Private execution value; never serialize its environment or credentials into a run. */
export interface ResolvedModelRoute {
	apiType: "azure-responses" | "workers-ai" | "cloudflare-auto";
	baseUrl: string;
	auth: "gateway-byok" | "account-binding" | "gateway-token";
	credentialRef: string;
	modelRef: string;
	modelId: string;
	environment: Readonly<AzureChatEnv>;
}

/** Resolve platform wiring once for either a primary or a fallback selection. */
export function resolveModelRoute(
	env: AzureChatEnv,
	modelRef: string,
): ResolvedModelRoute {
	const parsed = parseModelRef(modelRef);
	if (!parsed) throw new Error("Invalid model route");
	const environment = Object.freeze({ ...env });
	if (parsed.provider === "azure-openai") {
		const transport = azureGatewayTransport(environment);
		if (!transport)
			throw new Error("Azure OpenAI requires authenticated AI Gateway BYOK");
		return {
			apiType: "azure-responses",
			baseUrl: azureBaseUrl(environment),
			auth: "gateway-byok",
			credentialRef: "gateway-stored:azure-openai",
			modelRef,
			modelId: parsed.modelId,
			environment,
		};
	}
	if (modelRef === "cloudflare/auto") {
		const account = environment.AI_GATEWAY_ACCOUNT_ID?.trim() ?? "";
		const gateway = environment.AI_GATEWAY_LLM_ID?.trim() ?? "";
		return {
			apiType: "cloudflare-auto",
			baseUrl: `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(account)}/${encodeURIComponent(gateway)}/compat`,
			auth: "gateway-token",
			credentialRef: "env:CF_AI_GATEWAY_TOKEN",
			modelRef,
			modelId: parsed.modelId,
			environment,
		};
	}
	if (parsed.provider !== "workers-ai")
		throw new Error("Unsupported model route API");
	const transport = workersAiGatewayTransport(environment);
	return {
		apiType: "workers-ai",
		baseUrl: transport?.providerRoot ?? "binding://workers-ai",
		auth:
			!transport || transport.kind === "binding"
				? "account-binding"
				: "gateway-byok",
		credentialRef:
			transport?.kind === "https" ? "env:CF_WORKERS_AI_TOKEN" : "binding:AI",
		modelRef,
		modelId: parsed.modelId,
		environment,
	};
}

/** Both candidates keep the existing admission and billing adapters. */
export function modelForRoute(
	route: ResolvedModelRoute,
	metadata?: AigMetadata,
	onRequest?: (request: ModelRequestTelemetry) => void,
	beforeDispatch?: ProviderBeforeDispatch,
	promptCacheKey?: string | null,
): Exclude<LanguageModel, string> {
	if (route.apiType === "azure-responses")
		return azureModel(
			{ ...route.environment, AZURE_OPENAI_BASE_URL: route.baseUrl },
			metadata,
			onRequest,
			beforeDispatch,
		).responses(route.modelId);
	if (route.apiType === "workers-ai")
		return workersAiRuntimeModel(
			route.environment as WorkersAiEnv,
			route.modelId,
			metadata,
			beforeDispatch,
		);
	return cloudflareAutoRouterModel(
		workersAiClient(
			route.environment as WorkersAiEnv,
			beforeDispatch,
			metadata?.actingUserId,
		),
		{
			gatewayId: route.environment.AI_GATEWAY_LLM_ID?.trim() ?? "",
			...(metadata
				? { attribution: aigMetadataRecord(metadata) ?? undefined }
				: {}),
			...(metadata?.sessionKeyHash
				? { sessionId: metadata.sessionKeyHash }
				: {}),
			...(promptCacheKey ? { affinityKey: promptCacheKey } : {}),
		},
	);
}
