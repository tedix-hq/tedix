/**
 * The model port streams configured Azure or Workers AI deployments through
 * the authenticated AI Gateway; tests can substitute a scripted provider.
 */
import type {
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/azure-openai-responses";
import { streamSimple as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import {
	resolveAiGatewayTransport,
	type AiGatewayTransportEnv,
} from "@tedix/workers-ai/gateway-transport";
import {
	azureExecutionIdentity,
	ProviderExecutionIdentitySchema,
} from "@tedix/api-contract/schemas/provider-execution";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
	type ModelCatalogEntry,
	offeredInChat,
} from "@tedix/api-contract/schemas/model-catalog";
import { repairJsonUnicode } from "@tedix/chat-transport/repair-json-unicode";
import {
	admittedProviderFetch,
	type InferenceAdmissionPort,
	type InferenceRefusedError,
	type WorkspaceModelCall,
} from "./admission";

function requestContext(context: Context) {
	const normalized = normalizeContext(context);
	return {
		...normalized,
		messages: normalized.messages.map((message) =>
			message.role === "assistant"
				? {
						...message,
						content: message.content.map((part) =>
							part.type === "toolCall"
								? { ...part, arguments: repairJsonUnicode(part.arguments) }
								: part,
						),
					}
				: message,
		),
	};
}

export interface ModelPort {
	/** Model id for the prompt-cache key and telemetry. */
	id: string;
	contextWindow: number;
	maxOutputTokens: number;
	responseMetadata?(): { model?: string; usageReported: boolean };
	/**
	 * Why credit admission refused the last stream's model call, in words the
	 * person reads in the chat; null when it was admitted. The provider SDK
	 * replaces a refused fetch with its own connection error, so the loop asks.
	 */
	admissionRefusal?(): string | null;
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

export function configured(value: string | undefined): string | undefined {
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
	const deployment = azureDeploymentOf(modelId);
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

const AZURE_PREFIX = "azure-openai/";

/** The Azure deployment a model id names, or undefined for another provider. */
function azureDeploymentOf(modelId: string): string | undefined {
	return modelId.startsWith(AZURE_PREFIX)
		? modelId.slice(AZURE_PREFIX.length) || undefined
		: undefined;
}

export interface WorkspaceModelChoice {
	id: string;
	label: string;
}

export type WorkspaceModelEnv = AzureGatewayEnv &
	AiGatewayTransportEnv & { DB?: D1Database };

function workersAiTransport(env: WorkspaceModelEnv) {
	const gateway = configured(env.AI_GATEWAY_LLM_ID);
	return gateway
		? resolveAiGatewayTransport(
				{
					...env,
					AI_GATEWAY_ACCOUNT_ID: configured(env.AI_GATEWAY_ACCOUNT_ID),
					CF_AI_GATEWAY_TOKEN: configured(env.CF_AI_GATEWAY_TOKEN),
				},
				gateway,
				"workers-ai",
			)
		: null;
}

function workersAiModels(env: WorkspaceModelEnv): string[] {
	const raw = env.AI_GATEWAY_AUTO_ALLOWED_MODELS;
	if (!raw || !configured(raw) || !workersAiTransport(env)) return [];
	const ids = raw.split(",").map((id) => id.trim());
	if (
		/[\r\n]/.test(raw) ||
		ids.some(
			(id) => !/^@cf\/[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(id),
		)
	)
		throw new Error("Invalid Workers AI workspace model allowlist");
	return [...new Set(ids)];
}

/** Models this deployment can execute; labels name only where they run. */
export function configuredWorkspaceModels(
	env: WorkspaceModelEnv,
): WorkspaceModelChoice[] {
	const models: WorkspaceModelChoice[] = [];
	if (azureGatewayConfigured(env)) {
		const deployment = configured(env.AZURE_CHAT_DEPLOYMENT)!;
		models.push({
			id: `azure-openai/${deployment}`,
			label: `Azure deployment: ${deployment}`,
		});
	}
	for (const id of workersAiModels(env))
		models.push({ id, label: `Workers AI: ${id}` });
	return models;
}

/**
 * The model of a turn that names none: the first one offered, or for a turn a
 * picked tedi answers the administrator's default for a person's chat, when
 * this deployment offers it. `chatDefaultRef` is a catalog ref.
 */
export function defaultWorkspaceModelId(
	offered: readonly WorkspaceModelChoice[],
	chatDefaultRef: string | undefined,
): string | undefined {
	const preferred = chatDefaultRef
		? offered.find(
				({ id }) =>
					id === chatDefaultRef || `workers-ai/${id}` === chatDefaultRef,
			)
		: undefined;
	return (preferred ?? offered[0])?.id;
}

/**
 * What the workspace chat offers: the administrator's published catalog, in
 * its order and with its names, limited to entries this deployment can run.
 * Every Azure entry is offered when the Azure gateway is configured: an entry
 * names its own deployment on the one configured resource.
 */
export function catalogWorkspaceModels(
	env: WorkspaceModelEnv,
	entries: readonly ModelCatalogEntry[],
): WorkspaceModelChoice[] {
	const runnable = new Set(configuredWorkspaceModels(env).map(({ id }) => id));
	const azure = azureGatewayConfigured(env);
	const models: WorkspaceModelChoice[] = [];
	for (const entry of entries) {
		if (!offeredInChat(entry)) continue;
		const id =
			entry.provider === "workers-ai"
				? entry.modelId
				: entry.provider === "azure-openai"
					? entry.ref
					: null;
		if (!id) continue;
		if (entry.provider === "azure-openai" ? azure : runnable.has(id))
			models.push({ id, label: entry.label });
	}
	return models;
}

export function createWorkspaceModel(
	env: WorkspaceModelEnv,
	call: WorkspaceModelCall,
	admission: InferenceAdmissionPort,
	requestedId?: string,
): ModelPort {
	const choices = configuredWorkspaceModels(env);
	const modelId = requestedId ?? choices[0]?.id;
	// A catalog entry's Azure deployment runs on the configured resource.
	const deployment =
		modelId && azureGatewayConfigured(env)
			? azureDeploymentOf(modelId)
			: undefined;
	if (
		!modelId ||
		(!deployment && !choices.some((model) => model.id === modelId))
	)
		throw new Error(
			requestedId === undefined
				? "No model is configured for workspace chat"
				: "This model is not configured for workspace chat",
		);
	return modelId.startsWith("@cf/")
		? createWorkersAiGatewayModel(env, call, admission, modelId)
		: createAzureGatewayModel(env, call, admission, deployment);
}

export function createAzureGatewayModel(
	env: AzureGatewayEnv,
	call: WorkspaceModelCall,
	admission: InferenceAdmissionPort,
	/** The deployment this call runs on; the configured one when not named. */
	deploymentName?: string,
): ModelPort {
	const resource = configured(env.AZURE_OPENAI_RESOURCE);
	const deployment = deploymentName ?? configured(env.AZURE_CHAT_DEPLOYMENT);
	const account = configured(env.AI_GATEWAY_ACCOUNT_ID);
	const gateway = configured(env.AI_GATEWAY_LLM_ID);
	const token = configured(env.CF_AI_GATEWAY_TOKEN);
	if (!resource || !deployment || !account || !gateway || !token) {
		throw new Error(
			"Workspace model is not configured: AZURE_OPENAI_RESOURCE, AZURE_CHAT_DEPLOYMENT, AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_LLM_ID and CF_AI_GATEWAY_TOKEN are required",
		);
	}
	// https://developers.cloudflare.com/ai-gateway/providers/azureopenai/
	// Lowercase, so the logged path matches the admitted execution's resource.
	const baseUrl = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}/azure-openai/${resource.toLowerCase()}/openai/v1`;
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
		},
	};
	let responseMetadata: { model?: string; usageReported: boolean } = {
		usageReported: false,
	};
	let refusal: InferenceRefusedError | null = null;
	return {
		responseMetadata: () => responseMetadata,
		admissionRefusal: () => refusal?.message ?? null,
		id: `azure-openai/${deployment}`,
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		stream(context, options) {
			responseMetadata = { usageReported: false };
			refusal = null;
			const maxTokens = options?.maxTokens ?? model.maxTokens;
			const streamOptions: SimpleStreamOptions = {
				apiKey: "cloudflare-ai-gateway-byok",
				onProviderStreamEvent: (data) => {
					const event = data as {
						response?: {
							model?: string;
							usage?: { input_tokens?: number; output_tokens?: number };
						};
					};
					if (typeof event.response?.model === "string")
						responseMetadata.model = event.response.model;
					const usage = event.response?.usage;
					if (
						usage &&
						[usage.input_tokens, usage.output_tokens].every(
							(count) =>
								typeof count === "number" &&
								Number.isFinite(count) &&
								count >= 0,
						)
					)
						responseMetadata.usageReported = true;
				},
				fetch: async (input, init) => {
					// The SDK retries a failed fetch; a refusal stands for the stream.
					if (refusal) throw refusal;
					const request = new Request(input, init);
					const url = new URL(request.url);
					// This endpoint uses the GA v1 path, not a dated preview version.
					url.searchParams.delete("api-version");
					// Provider credentials override the Gateway's stored BYOK key.
					request.headers.delete("api-key");
					request.headers.delete("authorization");
					return admittedProviderFetch({
						admission,
						call,
						execution: azureExecutionIdentity({
							url: url.href,
							model: deployment,
							accountId: account,
							gatewayId: gateway,
							transportKind: "https",
						}),
						request: new Request(url, request),
						maxOutputTokens: maxTokens,
						send: (admitted) => fetch(admitted),
						onRefused: (error) => {
							refusal = error;
						},
					});
				},
				signal: options?.signal,
				maxTokens,
				azureBaseUrl: baseUrl,
				azureDeploymentName: deployment,
				azureApiVersion: configured(env.AZURE_OPENAI_API_VERSION) ?? "v1",
			} as SimpleStreamOptions;
			return streamSimple(model, requestContext(context), streamOptions);
		},
	};
}

function createWorkersAiGatewayModel(
	env: WorkspaceModelEnv,
	call: WorkspaceModelCall,
	admission: InferenceAdmissionPort,
	modelId: string,
): ModelPort {
	const transport = workersAiTransport(env);
	if (!transport)
		throw new Error("Workers AI gateway transport is not configured");
	const execution = ProviderExecutionIdentitySchema.parse({
		provider: "workers-ai",
		requestModel: modelId,
		gatewayAccountId: configured(env.AI_GATEWAY_ACCOUNT_ID) ?? null,
		gatewayId: configured(env.AI_GATEWAY_LLM_ID) ?? null,
		transportKind:
			transport.kind === "binding" ? "gateway-binding" : "gateway-https",
		apiKind: "workers-ai-chat",
		providerResource: null,
		providerOrigin: null,
		deployment: null,
	});
	const model: Model<"openai-completions"> = {
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: "cloudflare-workers-ai",
		baseUrl: `${transport.providerRoot}/v1`,
		input: ["text"],
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 16_000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsLongCacheRetention: false,
		},
		headers: {
			"cf-aig-authorization": `Bearer ${transport.authorization}`,
			"cf-aig-no-wholesale": "true",
		},
	};
	let responseMetadata: { model?: string; usageReported: boolean } = {
		usageReported: false,
	};
	let refusal: InferenceRefusedError | null = null;
	return {
		id: modelId,
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		responseMetadata: () => responseMetadata,
		admissionRefusal: () => refusal?.message ?? null,
		stream(context, options) {
			responseMetadata = { usageReported: false };
			refusal = null;
			const maxTokens = options?.maxTokens ?? model.maxTokens;
			return streamCompletions(model, requestContext(context), {
				apiKey: "cloudflare-ai-gateway-byok",
				signal: options?.signal,
				maxTokens,
				onProviderStreamEvent(data) {
					const event = data as {
						model?: unknown;
						usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
						choices?: Array<{
							usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
						}>;
					};
					if (typeof event.model === "string")
						responseMetadata.model = event.model;
					for (const usage of [
						event.usage,
						...(event.choices ?? []).map((choice) => choice.usage),
					]) {
						if (
							usage &&
							[usage.prompt_tokens, usage.completion_tokens].every(
								(count) =>
									typeof count === "number" &&
									Number.isFinite(count) &&
									count >= 0,
							)
						)
							responseMetadata.usageReported = true;
					}
				},
				async fetch(input, init) {
					// The SDK retries a failed fetch; a refusal stands for the stream.
					if (refusal) throw refusal;
					const request = new Request(input, init);
					request.headers.delete("authorization");
					request.headers.delete("api-key");
					request.headers.delete("x-api-key");
					return admittedProviderFetch({
						admission,
						call,
						execution,
						request,
						maxOutputTokens: maxTokens,
						send: (admitted) => transport.fetch(admitted),
						onRefused: (error) => {
							refusal = error;
						},
					});
				},
			});
		},
	};
}
