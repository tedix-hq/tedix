import {
	azureExecutionIdentity,
	type ProviderExecutionIdentity,
} from "@tedix/api-contract/schemas/provider-execution";
/** Generative kernel selection defaults to Auto Router. Explicit fixed models
 * retain their provider; incomplete configuration fails closed. */

import { createAzure } from "@ai-sdk/azure";
import { isLocalDemoProject, isLoopbackUrl } from "@tedix/auth/local-demo";
import {
	buildModelRef,
	findCatalogEntry,
	CLOUDFLARE_AUTO_MODEL_REF,
	type ModelOverride,
	type ModelProviderId,
	resolveModelSelection,
} from "@tedix/api-contract/schemas/model-catalog";
import { resolveAiGatewayTransport } from "@tedix/workers-ai/gateway-transport";
import { workersAiModel } from "@tedix/workers-ai/model";
import {
	cloudflareAutoRouterModel,
	DEFAULT_WORKERS_AI_MODEL,
	selectWorkersAiModel,
} from "@tedix/workers-ai/model-select";
import { usingWorkersAiGateway } from "@tedix/workers-ai/transport";
import {
	defaultSettingsMiddleware,
	wrapLanguageModel,
	type LanguageModel,
} from "ai";
import { reserveKernelBilling } from "./billing-reservation";
import {
	type KernelGatewayContext,
	captureKernelAttemptUsage,
	kernelGatewayMetadata,
} from "./gateway-attribution";
import {
	type KernelWorkersAiEnv,
	kernelWorkersAiClient,
} from "./workers-ai-client";

/**
 * Providers the kernel route planner can serve. Like the isolate, the kernel
 * only builds an Azure provider from env, so `azure-openai` is the sole wired
 * provider; the shared catalog rejects any other before it can steer selection.
 */
const KERNEL_AVAILABLE_PROVIDERS: ReadonlySet<ModelProviderId> = new Set([
	"azure-openai",
	"cloudflare",
]);

/**
 * All-optional Azure chat config the Kernel reads defensively off the
 * worker env. Matches the env names the isolate uses
 * (`apps/tedi-runtime/src/llm.ts` → `AzureChatEnv`) but every field is optional
 * here so a missing secret degrades to `null` instead of a type error.
 */
export interface KernelEnv {
	DB?: D1Database;
	AGENT_MEMORY?: AgentMemoryNamespace;
	AZURE_OPENAI_RESOURCE?: string;
	AZURE_OPENAI_BASE_URL?: string;
	AZURE_CHAT_DEPLOYMENT?: string;
	/** Per-direct-read-turn hop budget (default 8). Fail-soft on bad values. */
	/** Max plan owners serialized into the LLM prompt (default 16). */
	KERNEL_MAX_PLAN_OWNERS?: string;
	/** Per-turn delegation fan-out cap (default 32). */
	KERNEL_MAX_DELEGATIONS?: string;
	/**
	 * AI Gateway attribution/observability. When both are set (they are, in the
	 * api worker env) the kernel's Azure chat calls route through
	 * the gateway's `azure-openai` provider path so kernel spend is counted
	 * and tagged `surface:kernel` (distinct from per-tedi chat). Incomplete
	 * configuration disables Azure and selects Workers AI.
	 */
	AI_GATEWAY_ACCOUNT_ID?: string;
	/** Shared Gateway for chat, cognition, and voice. */
	AI_GATEWAY_LLM_ID?: string;
	/** Authenticated-gateway token (CF API token with "AI Gateway Run"), sent as
	 * `cf-aig-authorization: Bearer <token>`. Absent → no header. */
	CF_AI_GATEWAY_TOKEN?: string;
	/**
	 * Comma-separated allowlist of AI Gateway provider segments served by an
	 * in-account gateway, which therefore ride the Workers AI binding instead of
	 * public HTTPS. Listing `azure-openai` routes kernel chat over the binding.
	 * See `@tedix/workers-ai/gateway-transport`.
	 */
	AI_GATEWAY_BINDING_PROVIDERS?: string;
	/**
	 * Loopback-only maintainer bridge used by `bun run-local --inference`.
	 * The bridge owns the Gateway token resolved from the secret provider; it is never written to
	 * generated Wrangler config or exposed to the local Worker.
	 */
	TEDIX_LOCAL_INFERENCE_PROXY_URL?: string;
	TEDIX_LOCAL_DEMO_ENABLED?: string;
	DESCOPE_PROJECT_ID?: string;
	/**
	 * Workers AI binding (token-free — authenticated by the Worker itself). Used as
	 * the route-decision FALLBACK when the Azure provider is unavailable, so a
	 * kernel turn routes via a Cloudflare-native model instead of hanging on a dead
	 * provider. Routed through the AI Gateway (gateway option) for observability.
	 */
	AI?: Ai;
	/**
	 * Workers AI model id for the explicit Workers AI route. Default:
	 * `DEFAULT_WORKERS_AI_MODEL` from `@tedix/workers-ai/model-select`. Override
	 * to swap models without a code change.
	 */
	KERNEL_WORKERS_AI_MODEL?: string;
	/** Explicit provider/model ref; absent selects cloudflare/auto. */
	KERNEL_MODEL_REF?: string;
	/**
	 * Workers-AI BYOK API token (CF token with Workers AI access). When present
	 * alongside the AI Gateway vars, the Workers AI transport routes through the
	 * authenticated AI Gateway (`…/workers-ai/v1/chat/completions`) for unified
	 * billing/observability; absent → the token-free `env.AI` binding fallback.
	 */
	CF_WORKERS_AI_TOKEN?: string;
}

/**
 * Custom fetch that routes the kernel's AI-SDK Azure calls through the
 * Cloudflare AI Gateway and tags them `surface:kernel`. Mirrors
 * `apps/tedi-runtime/src/ai-sdk-adapter.ts` `gatewayFetch`: the SDK builds the
 * SDK-produced Azure URL and we deterministically rewrite it to the proven
 * gateway provider path rather than guessing the SDK's URL builder. Fail-safe:
 * missing Gateway configuration or a non-matching URL fails closed.
 */
export function azureGatewayByokHeaders(
	source: HeadersInit | undefined,
	aigToken: string,
	gatewayContext?: KernelGatewayContext | string,
): Headers {
	const headers = new Headers(source);
	headers.set(
		"cf-aig-metadata",
		JSON.stringify(kernelGatewayMetadata(gatewayContext)),
	);
	headers.set("cf-aig-authorization", `Bearer ${aigToken}`);
	// Missing stored BYOK credentials must fail rather than change the payer.
	headers.set("cf-aig-no-wholesale", "true");
	headers.delete("api-key");
	return headers;
}

function localInferenceProxyUrl(env: KernelEnv): string | null {
	const value = env.TEDIX_LOCAL_INFERENCE_PROXY_URL?.trim();
	return value &&
		env.TEDIX_LOCAL_DEMO_ENABLED === "true" &&
		isLocalDemoProject(env.DESCOPE_PROJECT_ID) &&
		isLoopbackUrl(value)
		? value.replace(/\/+$/, "")
		: null;
}

export function kernelGatewayFetch(
	env: KernelEnv,
	gatewayContext?: KernelGatewayContext | string,
): typeof fetch | undefined {
	const accountId = env.AI_GATEWAY_ACCOUNT_ID?.trim();
	const gatewayId = env.AI_GATEWAY_LLM_ID?.trim();
	const localProxy = localInferenceProxyUrl(env);
	if (!accountId || !gatewayId) return undefined;
	// The loopback maintainer bridge terminates a public-shaped gateway URL, so
	// it is HTTPS-only by construction and never resolves a binding transport.
	const transport = localProxy
		? null
		: resolveAiGatewayTransport(env, gatewayId, "azure-openai");
	// The gateway is authenticated; no direct provider fallback is allowed.
	if (!transport && !localProxy) return undefined;
	const prefix = `${transport?.providerRoot ?? `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/azure-openai`}/`;
	const aigToken = transport?.authorization;
	const send = transport?.fetch ?? fetch;
	return async (input, init) => {
		const original =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		const url = new URL(original);
		const resource = /^([a-zA-Z0-9-]+)\.openai\.azure\.com$/.exec(
			url.hostname,
		)?.[1];
		if (
			url.protocol !== "https:" ||
			!resource ||
			url.port ||
			url.username ||
			url.password ||
			url.hash ||
			url.pathname !== "/openai/v1/responses" ||
			url.search
		) {
			throw new Error(
				"Refusing Azure request that cannot be routed through AI Gateway",
			);
		}
		const body =
			typeof input === "string" || input instanceof URL
				? init?.body
				: (init?.body ??
					(input instanceof Request && input.body
						? await input.clone().text()
						: undefined));
		const payload = typeof body === "string" ? JSON.parse(body) : null;
		if (
			!payload ||
			typeof payload.model !== "string" ||
			!payload.model.trim()
		) {
			throw new Error("Responses request is missing its deployment");
		}
		const model = payload.model;
		const gatewayUrl = `${prefix}${resource}/openai/v1/responses`;
		const rewritten = localProxy
			? `${localProxy}${new URL(gatewayUrl).pathname}`
			: gatewayUrl;
		const reservedContext = await reserveKernelBilling(env, {
			context: gatewayContext,
			execution: azureExecutionIdentity({
				url: gatewayUrl,
				model,
				accountId: env.AI_GATEWAY_ACCOUNT_ID,
				gatewayId: env.AI_GATEWAY_LLM_ID,
				transportKind: transport?.kind ?? "https",
			}),
			body,
		});
		const sourceHeaders =
			init?.headers ?? (input instanceof Request ? input.headers : undefined);
		const headers = aigToken
			? azureGatewayByokHeaders(sourceHeaders, aigToken, reservedContext)
			: new Headers(sourceHeaders);
		if (!aigToken) {
			headers.set(
				"cf-aig-metadata",
				JSON.stringify(kernelGatewayMetadata(reservedContext)),
			);
			headers.delete("api-key");
			headers.delete("cf-aig-authorization");
		}
		// Cloudflare BYOK is authoritative on the authenticated gateway path. The
		// Remove the SDK placeholder so Gateway can supply the stored provider key.
		if (typeof input === "string" || input instanceof URL) {
			return send(rewritten, {
				...init,
				headers,
				body,
			});
		}
		return send(new Request(rewritten, input), { ...init, headers, body });
	};
}

/**
 * Resolve the Azure resource root (no trailing slash, no `/openai` suffix) from
 * either an explicit base URL or a resource name. Returns `null` when neither is
 * configured — the fail-soft analogue of the isolate's throwing `azureBaseUrl`.
 */
function resolveAzureBaseUrl(env: KernelEnv): string | null {
	const explicit = env.AZURE_OPENAI_BASE_URL?.trim();
	if (explicit) return explicit.replace(/\/+$/, "");
	const resource = env.AZURE_OPENAI_RESOURCE?.trim();
	if (resource) return `https://${resource}.openai.azure.com`;
	return null;
}

/** Size the prompt for the model actually selected for this operation. */
export function kernelServesWorkersAiLane(
	model: SelectedKernelModel | null,
): boolean {
	return (
		typeof model?.model === "object" && model.model.provider === "workers-ai"
	);
}

export interface SelectedKernelModel {
	model: LanguageModel;
	pricingIdentity: ProviderExecutionIdentity | null;
	attempts: NonNullable<KernelGatewayContext["executionAttempts"]>;
	forOperation: () => SelectedKernelModel;
}

/** Each operation owns a fresh transport closure, including when callers run concurrently. */
function observeKernelModel(
	model: LanguageModel,
	attempts: SelectedKernelModel["attempts"],
): LanguageModel {
	if (typeof model === "string")
		throw new Error("Kernel requires a concrete model");
	return new Proxy(model, {
		get(target, key, receiver) {
			const value = Reflect.get(target, key, receiver);
			if (key !== "doGenerate" && key !== "doStream")
				return typeof value === "function" ? value.bind(target) : value;
			return async (...args: unknown[]) => {
				const start = attempts.length;
				const capture = (usage: unknown, providerMetadata?: unknown) => {
					if (attempts.length > start)
						captureKernelAttemptUsage(attempts, usage, providerMetadata);
				};
				try {
					const result = (await Reflect.apply(value, target, args)) as {
						usage?: unknown;
						providerMetadata?: unknown;
						stream: ReadableStream<{
							type: string;
							usage?: unknown;
							providerMetadata?: unknown;
						}>;
					};
					if (key === "doGenerate")
						capture(result.usage, result.providerMetadata);
					else
						result.stream = result.stream.pipeThrough(
							new TransformStream({
								transform(
									chunk: {
										type: string;
										usage?: unknown;
										providerMetadata?: unknown;
									},
									controller,
								) {
									if (chunk.type === "finish")
										capture(chunk.usage, chunk.providerMetadata);
									controller.enqueue(chunk);
								},
							}),
						);
					return result;
				} catch (error) {
					if (error && typeof error === "object" && "usage" in error)
						capture(error.usage);
					throw error;
				}
			};
		},
	});
}

export function kernelModel(
	env: KernelEnv,
	override?: ModelOverride | { modelRef?: unknown } | null,
	gatewayContext?: KernelGatewayContext | string,
): SelectedKernelModel | null {
	const operationContext = gatewayContext;
	const forOperation = () => {
		const operation = kernelModel(env, override, operationContext);
		if (!operation) throw new Error("Kernel model became unavailable");
		return operation;
	};
	const attempts: SelectedKernelModel["attempts"] = [];
	gatewayContext = {
		...(typeof gatewayContext === "string"
			? { organizationId: gatewayContext }
			: gatewayContext),
		executionAttempts: attempts,
	};
	const effectiveOverride = override ?? {
		modelRef: env.KERNEL_MODEL_REF?.trim() || CLOUDFLARE_AUTO_MODEL_REF,
	};
	// Explicit fixed provider choices are preserved; failures do not change authority.
	if (
		typeof effectiveOverride.modelRef === "string" &&
		effectiveOverride.modelRef.startsWith("workers-ai/")
	) {
		if (!findCatalogEntry(effectiveOverride.modelRef))
			throw new Error(`Invalid kernel model: ${effectiveOverride.modelRef}`);
		const workersAiEnv = env as KernelWorkersAiEnv;
		if (workersAiEnv.AI || usingWorkersAiGateway(workersAiEnv)) {
			const modelId = resolveKernelWorkersAiModel({
				...env,
				KERNEL_MODEL_REF: effectiveOverride.modelRef,
			});
			return {
				model: observeKernelModel(
					workersAiModel(
						kernelWorkersAiClient(workersAiEnv, gatewayContext),
						modelId,
					) as LanguageModel,
					attempts,
				),
				forOperation,
				pricingIdentity:
					env.AI_GATEWAY_ACCOUNT_ID?.trim() && env.AI_GATEWAY_LLM_ID?.trim()
						? {
								provider: "workers-ai",
								requestModel: modelId,
								gatewayAccountId: env.AI_GATEWAY_ACCOUNT_ID.trim(),
								gatewayId: env.AI_GATEWAY_LLM_ID.trim(),
								transportKind: "workers-ai-binding",
								apiKind: "workers-ai-chat",
								providerResource: null,
								providerOrigin: null,
								deployment: null,
							}
						: null,
				attempts,
			};
		}
		return null;
	}
	if (effectiveOverride.modelRef === CLOUDFLARE_AUTO_MODEL_REF) {
		const gatewayId = env.AI_GATEWAY_LLM_ID?.trim();
		const accountId = env.AI_GATEWAY_ACCOUNT_ID?.trim();
		if (gatewayId && accountId && env.CF_AI_GATEWAY_TOKEN?.trim()) {
			const model = cloudflareAutoRouterModel(
				kernelWorkersAiClient(env as KernelWorkersAiEnv, gatewayContext),
				{
					gatewayId,
					attribution: kernelGatewayMetadata(gatewayContext),
					...(typeof operationContext === "object" &&
					operationContext?.sessionKey
						? { sessionId: operationContext.sessionKey }
						: {}),
				},
			);
			return {
				model: observeKernelModel(model as LanguageModel, attempts),
				forOperation,
				pricingIdentity: {
					provider: "workers-ai",
					requestModel: CLOUDFLARE_AUTO_MODEL_REF,
					gatewayAccountId: accountId,
					gatewayId,
					transportKind: "gateway-https",
					apiKind: "workers-ai-chat",
					providerResource: null,
					providerOrigin: null,
					deployment: null,
				},
				attempts,
			};
		}
		return null;
	}
	const gatewayFetch = kernelGatewayFetch(env, gatewayContext);
	if (!gatewayFetch) return null;

	const baseURL = resolveAzureBaseUrl(env);
	if (!baseURL) return null;

	const envDeployment = env.AZURE_CHAT_DEPLOYMENT?.trim();
	if (!envDeployment) return null;

	// BYTE-FOR-BYTE default: with no override, use `envDeployment` verbatim (the
	// legacy path's `env.AZURE_CHAT_DEPLOYMENT?.trim()`), bypassing the catalog
	// parse/trim round-trip. Only a VALID, allowlisted Azure override may change
	// it; a rejected override (→ `source: "default"`) or a non-azure provider
	// falls back to `envDeployment` unchanged.
	// With no explicit per-turn override, fall back to the per-role
	// `KERNEL_MODEL_REF` (a workers-ai ref is rejected here → env deployment).
	let deployment = envDeployment;
	if (effectiveOverride) {
		const selection = resolveModelSelection({
			defaultRef: buildModelRef("azure-openai", envDeployment),
			override: effectiveOverride,
			availableProviders: KERNEL_AVAILABLE_PROVIDERS,
		});
		if (
			selection?.source === "override" &&
			selection.provider === "azure-openai"
		) {
			deployment = selection.modelId;
		}
	}

	const azure = createAzure({
		// createAzure requires a non-empty SDK credential even though gatewayFetch
		// removes it on the BYOK path before the request leaves the Worker.
		apiKey: "cloudflare-ai-gateway-byok",
		baseURL: `${baseURL}/openai/v1`,
		fetch: gatewayFetch,
	});

	// Responses supports tool-enabled GPT-6 reasoning without forcing none.
	const transport = resolveAiGatewayTransport(
		env,
		env.AI_GATEWAY_LLM_ID ?? "",
		"azure-openai",
	);
	let pricingIdentity: ProviderExecutionIdentity | null = null;
	if (transport)
		pricingIdentity = azureExecutionIdentity({
			url: `${transport.providerRoot}/${new URL(baseURL).hostname.split(".")[0]}/openai/v1/responses`,
			model: deployment,
			accountId: env.AI_GATEWAY_ACCOUNT_ID,
			gatewayId: env.AI_GATEWAY_LLM_ID,
			transportKind: transport.kind,
		});
	return {
		model: observeKernelModel(
			wrapLanguageModel({
				model: azure.responses(deployment),
				middleware: [
					{
						transformParams: async ({ params }) => ({
							...params,
							tools: params.tools?.map((entry) =>
								entry.type === "function" && entry.strict == null
									? { ...entry, strict: false }
									: entry,
							),
						}),
					},
					defaultSettingsMiddleware({
						settings: {
							providerOptions: {
								azure: {
									store: false,
									include: ["reasoning.encrypted_content"],
								},
							},
						},
					}),
				],
			}),
			attempts,
		),
		pricingIdentity,
		attempts,
		forOperation,
	};
}

/**
 * Resolve the Workers AI model id for the kernel's Workers AI route path. A
 * valid `workers-ai/<slug>` `KERNEL_MODEL_REF` (the per-role slot) selects that
 * model id; anything else falls back to `KERNEL_WORKERS_AI_MODEL` and finally
 * the shipped default. The provider CHOICE (Azure vs Workers AI) is owned by the
 * explicit model ref — this helper only selects the Workers AI model ID.
 */
export function resolveKernelWorkersAiModel(env: KernelEnv): string {
	// Env-reading wrapper only; the ref→id rule itself (and the shipped default)
	// belongs to `@tedix/workers-ai/model-select`.
	return selectWorkersAiModel(
		env.KERNEL_WORKERS_AI_MODEL?.trim() || DEFAULT_WORKERS_AI_MODEL,
		env.KERNEL_MODEL_REF,
	);
}
