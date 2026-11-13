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
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import {
	type ModelCatalogEntry,
	offeredInChat,
} from "@tedix/api-contract/schemas/model-catalog";
import { repairJsonUnicode } from "@tedix/chat-transport/repair-json-unicode";

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

export interface WorkspaceModelChoice {
	id: string;
	label: string;
}

export type WorkspaceModelEnv = AzureGatewayEnv & AiGatewayTransportEnv;

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
 * What the workspace chat offers: the administrator's published catalog, in
 * its order and with its names, limited to entries this deployment can run.
 */
export function catalogWorkspaceModels(
	env: WorkspaceModelEnv,
	entries: readonly ModelCatalogEntry[],
): WorkspaceModelChoice[] {
	const runnable = new Set(configuredWorkspaceModels(env).map(({ id }) => id));
	const models: WorkspaceModelChoice[] = [];
	for (const entry of entries) {
		if (!offeredInChat(entry)) continue;
		const id =
			entry.provider === "workers-ai"
				? entry.modelId
				: entry.provider === "azure-openai"
					? entry.ref
					: null;
		if (id && runnable.has(id)) models.push({ id, label: entry.label });
	}
	return models;
}

export function createWorkspaceModel(
	env: WorkspaceModelEnv,
	metadata: GatewayMetadata,
	requestedId?: string,
): ModelPort {
	const choices = configuredWorkspaceModels(env);
	const modelId = requestedId ?? choices[0]?.id;
	if (!modelId || !choices.some((model) => model.id === modelId))
		throw new Error(
			requestedId === undefined
				? "No model is configured for workspace chat"
				: "This model is not configured for workspace chat",
		);
	return modelId.startsWith("@cf/")
		? createWorkersAiGatewayModel(env, metadata, modelId)
		: createAzureGatewayModel(env, metadata);
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
	let responseMetadata: { model?: string; usageReported: boolean } = {
		usageReported: false,
	};
	return {
		responseMetadata: () => responseMetadata,
		id: `azure-openai/${deployment}`,
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		stream(context, options) {
			responseMetadata = { usageReported: false };
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
			return streamSimple(model, requestContext(context), streamOptions);
		},
	};
}

function createWorkersAiGatewayModel(
	env: WorkspaceModelEnv,
	metadata: GatewayMetadata,
	modelId: string,
): ModelPort {
	const transport = workersAiTransport(env);
	if (!transport)
		throw new Error("Workers AI gateway transport is not configured");
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
			"cf-aig-metadata": JSON.stringify({
				surface: "workspace_object",
				workspaceId: metadata.workspaceId,
				turnId: metadata.turnId,
				actorId: metadata.actorId,
			}),
		},
	};
	let responseMetadata: { model?: string; usageReported: boolean } = {
		usageReported: false,
	};
	return {
		id: modelId,
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxTokens,
		responseMetadata: () => responseMetadata,
		stream(context, options) {
			responseMetadata = { usageReported: false };
			return streamCompletions(model, requestContext(context), {
				apiKey: "cloudflare-ai-gateway-byok",
				signal: options?.signal,
				maxTokens: options?.maxTokens ?? model.maxTokens,
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
				fetch(input, init) {
					const request = new Request(input, init);
					request.headers.delete("authorization");
					request.headers.delete("api-key");
					request.headers.delete("x-api-key");
					return transport.fetch(request);
				},
			});
		},
	};
}
