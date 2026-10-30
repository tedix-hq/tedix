import { createDbClient } from "@tedix/db/client";
import { getModelCatalogConfig } from "@tedix/db/queries/model-catalog";
import type { ModelCatalogConfig } from "@tedix/api-contract/schemas/model-catalog-config";
import { regionalAzureGatewayUrl } from "@tedix/workers-ai/gateway-transport";
import { withModelFallback } from "@tedix/workers-ai/model-fallback";
import { kernelFallbackHooks } from "./model-fallback";
import {
	azureExecutionIdentity,
	type ProviderExecutionIdentity,
} from "@tedix/api-contract/schemas/provider-execution";
/** Kernel selections require a published model entry and a configured provider. */

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
	selectWorkersAiModel,
} from "@tedix/workers-ai/model-select";
import { usingWorkersAiGateway } from "@tedix/workers-ai/transport";
import {
	defaultSettingsMiddleware,
	wrapLanguageModel,
	type LanguageModel,
} from "ai";
import {
	reserveKernelBilling,
	applyKernelProviderCredential,
	kernelRegionalExecution,
} from "./billing-reservation";
import {
	type KernelGatewayContext,
	captureKernelAttemptUsage,
	kernelGatewayMetadata,
} from "./gateway-attribution";
import {
	type KernelWorkersAiEnv,
	kernelWorkersAiClient,
} from "./workers-ai-client";

/** Fixed Workers AI selection uses its own adapter branch below. */
const KERNEL_AVAILABLE_PROVIDERS: ReadonlySet<ModelProviderId> = new Set([
	"azure-openai",
	"cloudflare",
]);

/** Load one immutable publication before the synchronous provider adapter is selected. */
export async function configuredKernelModel(
	env: KernelEnv,
	override?: ModelOverride | { modelRef?: unknown } | null,
	context?: KernelGatewayContext | string,
) {
	if (!env.DB) return null;
	const config = await getModelCatalogConfig(createDbClient(env.DB));
	return kernelModel(env, override, context, config);
}

export async function configuredKernelRouteModel(
	env: KernelEnv,
	context?: KernelGatewayContext | string,
) {
	if (!env.DB) return null;
	const config = await getModelCatalogConfig(createDbClient(env.DB));
	const ref = config.defaults?.kernelRouteModelRef;
	return (
		(ref ? kernelModel(env, { modelRef: ref }, context, config) : null) ??
		kernelModel(env, undefined, context, config)
	);
}

export interface KernelEnv {
	MCP_SERVICE?: CloudflareEnv["MCP_SERVICE"];
	MCP_URL?: string;
	PLATFORM_SERVICE_TOKEN?: string;
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
	/** Authenticated Workers AI binding used by the provider transport. */
	AI?: Ai;
	/** Explicit Workers AI model ID; otherwise use the published installation default. */
	KERNEL_WORKERS_AI_MODEL?: string;
	/** Explicit provider/model ref; absent selects cloudflare/auto. */
	KERNEL_MODEL_REF?: string;
	/**
	 * Route-pass hedge deadline (ms without a first partial before one identical
	 * second request starts; `route-planner.ts`). Unset → 5000; `0` disables.
	 */
	KERNEL_ROUTE_HEDGE_AFTER_MS?: string;
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
		const regionalExecution = kernelRegionalExecution(reservedContext);
		const providerUrl = regionalExecution
			? regionalAzureGatewayUrl(rewritten, regionalExecution)
			: rewritten;
		if (applyKernelProviderCredential(reservedContext, headers))
			init = { ...init, redirect: "error" };
		// Unrestricted requests keep Gateway BYOK; regional requests use the organization key.
		if (typeof input === "string" || input instanceof URL) {
			return send(providerUrl, {
				...init,
				headers,
				body,
			});
		}
		return send(new Request(providerUrl, input), { ...init, headers, body });
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
	/** Route planning owns its single fallback and deadline. */
	forRouteOperation?: () => SelectedKernelModel;
	retryModel?: () => Promise<SelectedKernelModel | null>;
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
	catalog?: ModelCatalogConfig,
): SelectedKernelModel | null {
	const selected = selectKernelModel(
		env,
		override,
		gatewayContext,
		undefined,
		catalog,
	);
	if (
		!selected ||
		typeof selected.model === "string" ||
		!env.DB ||
		!catalog ||
		typeof gatewayContext !== "object" ||
		!gatewayContext?.runId ||
		!gatewayContext.organizationId
	)
		return selected;
	const primaryRef =
		typeof override?.modelRef === "string"
			? override.modelRef
			: env.KERNEL_MODEL_REF?.trim() || CLOUDFLARE_AUTO_MODEL_REF;
	const hooks = kernelFallbackHooks(
		env.DB,
		{
			organizationId: gatewayContext.organizationId,
			runId: gatewayContext.runId,
		},
		catalog,
	);
	selected.forRouteOperation = () => {
		const route = selectKernelModel(
			env,
			override,
			gatewayContext,
			undefined,
			catalog,
		);
		if (!route) throw new Error("Kernel model became unavailable");
		route.retryModel = async () => {
			const policy = await hooks.load();
			if (policy.maxTransitions < 1) return null;
			for (const ref of policy.ladder[primaryRef] ?? []) {
				if (ref === primaryRef) continue;
				const next = selectKernelModel(
					env,
					{ modelRef: ref },
					gatewayContext,
					undefined,
					catalog,
				);
				if (!next) continue;
				await hooks.record({
					from: primaryRef,
					to: ref,
					reason: "provider_unavailable",
					ordinal: 1,
					policyVersion: policy.version,
				});
				return next;
			}
			return null;
		};
		return route;
	};
	selected.model = withModelFallback(
		wrapLanguageModel({ model: selected.model, middleware: [] }),
		{
			primaryRef,
			...kernelFallbackHooks(
				env.DB,
				{
					organizationId: gatewayContext.organizationId,
					runId: gatewayContext.runId,
				},
				catalog,
			),
			resolve: (modelRef) => {
				const candidate = selectKernelModel(
					env,
					{ modelRef },
					gatewayContext,
					selected.attempts,
					catalog,
				);
				return candidate && typeof candidate.model !== "string"
					? wrapLanguageModel({ model: candidate.model, middleware: [] })
					: null;
			},
		},
	);
	return selected;
}

function selectKernelModel(
	env: KernelEnv,
	override?: ModelOverride | { modelRef?: unknown } | null,
	gatewayContext?: KernelGatewayContext | string,
	executionAttempts?: SelectedKernelModel["attempts"],
	catalog?: ModelCatalogConfig,
): SelectedKernelModel | null {
	const operationContext = gatewayContext;
	const forOperation = () => {
		const operation = kernelModel(env, override, operationContext, catalog);
		if (!operation) throw new Error("Kernel model became unavailable");
		return operation;
	};
	const attempts: SelectedKernelModel["attempts"] = executionAttempts ?? [];
	gatewayContext = {
		...(typeof gatewayContext === "string"
			? { organizationId: gatewayContext }
			: gatewayContext),
		executionAttempts: attempts,
	};
	const effectiveOverride = override ?? {
		modelRef: env.KERNEL_MODEL_REF?.trim() || CLOUDFLARE_AUTO_MODEL_REF,
	};
	const registered =
		typeof effectiveOverride.modelRef === "string"
			? findCatalogEntry(effectiveOverride.modelRef, catalog?.entries)
			: undefined;
	if (
		!registered ||
		!["azure-openai", "workers-ai", "cloudflare"].includes(registered.provider)
	)
		return null;
	// Explicit fixed provider choices are preserved; failures do not change authority.
	if (
		typeof effectiveOverride.modelRef === "string" &&
		effectiveOverride.modelRef.startsWith("workers-ai/")
	) {
		const workersAiEnv = env as KernelWorkersAiEnv;
		if (workersAiEnv.AI || usingWorkersAiGateway(workersAiEnv)) {
			const modelId = resolveKernelWorkersAiModel(
				{
					...env,
					KERNEL_MODEL_REF: effectiveOverride.modelRef,
				},
				catalog,
			);
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
	if (registered.provider !== "azure-openai") return null;
	const gatewayFetch = kernelGatewayFetch(env, gatewayContext);
	if (!gatewayFetch) return null;

	const baseURL = resolveAzureBaseUrl(env);
	if (!baseURL) return null;

	const envDeployment = env.AZURE_CHAT_DEPLOYMENT?.trim();
	if (!envDeployment) return null;

	let deployment = envDeployment;
	if (effectiveOverride) {
		const selection = resolveModelSelection({
			defaultRef: buildModelRef("azure-openai", envDeployment),
			override: effectiveOverride,
			availableProviders: KERNEL_AVAILABLE_PROVIDERS,
			catalog: catalog?.entries,
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

	// Responses supports tool-enabled GPT-6 with model-specific reasoning settings.
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
									// Luna supports none; Sol/Astra require reasoning.
									...(deployment === "gpt-6-luna"
										? { reasoningEffort: "none" }
										: {}),
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

/** Resolve a registered Workers AI ref using the installation default when needed. */
export function resolveKernelWorkersAiModel(
	env: KernelEnv,
	catalog?: ModelCatalogConfig,
): string {
	return selectWorkersAiModel(
		env.KERNEL_WORKERS_AI_MODEL?.trim() ||
			catalog?.defaults?.workersAiModelRef?.slice("workers-ai/".length) ||
			"",
		env.KERNEL_MODEL_REF,
		catalog?.entries,
	);
}
