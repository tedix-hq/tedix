import { requestInferenceOriginGuard } from "./runtime-inference-origin";
import { azureExecutionIdentity } from "@tedix/api-contract/schemas/provider-execution";
/**
 * Azure OpenAI LLM client wrapper for the isolate tedi runtime.
 *
 * Matches the deployments/api-version/auth header used by the observer path.
 * Chat path streams SSE deltas; observer path is a single non-streaming
 * JSON-mode call (handled in do.ts directly).
 *
 * Endpoint shape:
 *   `${baseUrl}/openai/deployments/${deployment}/chat/completions?api-version=...`
 * where baseUrl = AZURE_OPENAI_BASE_URL || `https://${RESOURCE}.openai.azure.com`
 *
 * NOTE: AZURE_OPENAI_BASE_URL is expected to be the RESOURCE ROOT (no
 * `/openai/v1` suffix), matching the observer contract.
 */

import {
	type AiGatewayTransport,
	type ProviderBeforeDispatch,
	resolveAiGatewayTransport,
} from "@tedix/workers-ai/gateway-transport";
import { assertAiRequestSize } from "./ai-request-guard";
import { authorizeInferenceEntitlement } from "./billing-reservation-client";

export interface ChatToolSpec {
	type: "function";
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface AzureChatEnv {
	SECRETS_MASTER_KEY?: string;
	API_SERVICE?: Fetcher;
	AZURE_OPENAI_RESOURCE?: string;
	AZURE_OPENAI_BASE_URL?: string;
	AZURE_OPENAI_API_VERSION: string;
	AZURE_CHAT_DEPLOYMENT: string;
	/**
	 * AI Gateway attribution/observability. When both are set (they are, in every
	 * isolate env block) the chat fetches route through
	 * the gateway's `azure-openai` provider path instead of the Azure
	 * resource root, so chat spend is counted and attributable per tedi via
	 * `cf-aig-metadata`. Azure requests are disabled when this configuration is
	 * incomplete; provider credentials never live in the Worker.
	 */
	AI_GATEWAY_ACCOUNT_ID?: string;
	/** Shared Gateway for chat, cognition, and voice. */
	AI_GATEWAY_LLM_ID?: string;
	/**
	 * Authenticated-gateway token. When set, sent as `cf-aig-authorization:
	 * Bearer <token>` so an authenticated AI Gateway accepts the request. A CF
	 * API token with "AI Gateway Run". Required for every Azure request.
	 */
	CF_AI_GATEWAY_TOKEN?: string;
	/**
	 * Workers AI binding. Also the AI Gateway transport for every provider listed
	 * in `AI_GATEWAY_BINDING_PROVIDERS` — see `@tedix/workers-ai/gateway-transport`.
	 */
	AI?: Ai;
	/**
	 * Comma-separated allowlist of AI Gateway provider segments served by an
	 * in-account gateway, which therefore ride the Workers AI binding instead of
	 * public HTTPS. Listing `azure-openai` routes isolate chat over the binding.
	 */
	AI_GATEWAY_BINDING_PROVIDERS?: string;
	/**
	 * TEMPORARY Azure-outage kill-switch. When `"true"`, the isolate builds its
	 * model from the token-free Cloudflare Workers AI binding instead of Azure
	 * (see `workers-ai-client.ts`). Clear it to return to Azure.
	 */
	/** Workers AI model id for the fallback; defaults to Llama 3.3 70B fp8-fast. */
	TEDI_WORKERS_AI_MODEL?: string;
	/**
	 * Optional exact `provider/model-id` pin for blind evidence-judge turns.
	 * Unlike the ordinary chat path, a configured judge never crosses providers
	 * through the circuit breaker: an unavailable pinned verifier fails closed so
	 * calibration and sealed verdict identity cannot silently change together.
	 */
	TEDI_JUDGE_MODEL_REF?: string;
	/**
	 * When `"true"`, MCP `run_tedi_turn` runs its chat turn on the durable
	 * CHAT_TURN_WORKFLOW with a bounded in-band settle await instead of the
	 * inline AI-SDK call, so a DO eviction / deploy / hung provider mid-turn
	 * no longer loses the reply (see `durable-messages-send.ts`). Any other
	 * value ⇒ legacy inline path.
	 */
	/**
	 * Workers-AI BYOK API token (CF token with Workers AI access). When present
	 * alongside the AI Gateway vars, the Workers AI transport routes through the
	 * authenticated AI Gateway (`…/workers-ai/v1/chat/completions`) for unified
	 * billing/observability; absent → the token-free `env.AI` binding fallback.
	 */
	CF_WORKERS_AI_TOKEN?: string;
	/** Maximum serialized Azure chat request body. Cost circuit breaker; defaults
	 * to 750KB when unset or invalid. */
	TEDI_MAX_AI_REQUEST_BYTES?: string;
	/** Per-request AI Gateway timeout. Each model round gets this independent
	 * ceiling so one hung upstream stream cannot consume the entire durable
	 * workflow wall clock. */
	TEDI_AI_REQUEST_TIMEOUT_MS?: string;
}

/**
 * Per-request attribution forwarded to AI Gateway as `cf-aig-metadata`.
 * AI Gateway caps this at 5 string|number|boolean entries (no nested objects).
 * We keep tedi, org, purpose, and hashed session filterable, then pack run/work
 * correlation into the versioned `attribution` string.
 * Attribution only — the enforceable spend ceiling is a gateway-side spending
 * limit (dashboard/API), not this header.
 */
export interface AigMetadata {
	tediId?: string;
	orgId?: string;
	/** One-way hash of the content-bearing session key. */
	sessionKeyHash?: string;
	/** Compact, server-derived trigger class (`cron:<name>`, `operator`, `mcp`,
	 * `email`, `ci`, etc.) so spend can be traced to the initiating surface. */
	source?: string;
	/** Versioned JSON string containing run id and work-item id (or explicit
	 * system purpose). */
	attribution?: string;
}

/** OpenAI-shaped token usage (final SSE chunk / JSON body). */
export interface ChatCompletionUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
}

interface ChatCompletionResponse {
	choices?: Array<{
		message?: ChatCompletionMessage;
		finish_reason?: string | null;
	}>;
	usage?: ChatCompletionUsage;
}

interface ChatCompletionToolCall {
	id: string;
	type: "function";
	function?: {
		name?: string;
		arguments?: string;
	};
}

interface ChatCompletionMessage {
	role?: "assistant";
	content?: string | null;
	tool_calls?: ChatCompletionToolCall[];
}

export function azureBaseUrl(env: AzureChatEnv): string {
	const explicit = env.AZURE_OPENAI_BASE_URL?.trim();
	if (explicit) return explicit.replace(/\/+$/, "");
	const resource = env.AZURE_OPENAI_RESOURCE?.trim();
	if (!resource)
		throw new Error(
			"Azure OpenAI not configured: set AZURE_OPENAI_BASE_URL or AZURE_OPENAI_RESOURCE",
		);
	return `https://${resource}.openai.azure.com`;
}

/**
 * Resolve the Azure OpenAI resource name for the AI Gateway path
 * (`…/azure-openai/{resource}/…`), from `AZURE_OPENAI_RESOURCE` or an explicit
 * `https://{resource}.openai.azure.com` base URL.
 */
function azureResourceName(env: AzureChatEnv): string | null {
	const resource = env.AZURE_OPENAI_RESOURCE?.trim();
	if (resource) return resource;
	const explicit = env.AZURE_OPENAI_BASE_URL?.trim();
	const match = explicit?.match(/^https:\/\/([^.]+)\.openai\.azure\.com/i);
	return match?.[1] ?? null;
}

/**
 * Chat-completions URL. When `AI_GATEWAY_ACCOUNT_ID` + `AI_GATEWAY_LLM_ID` and a
 * resolvable resource name are all present, route through the AI Gateway Azure
 * provider path so the call is counted and attributable. Missing configuration
 * is an error; there is no direct provider route.
 * https://developers.cloudflare.com/ai-gateway/providers/azureopenai/
 */
/**
 * True when chat routes through the AI Gateway: account + gateway id + a
 * resolvable resource AND a `CF_AI_GATEWAY_TOKEN`. The gateway is an Authenticated
 * Gateway, so without the token a request would 401. Authenticated Gateway
 * requests omit provider credentials so Cloudflare's stored BYOK key is authoritative.
 */
export function azureGatewayTransport(
	env: AzureChatEnv,
	beforeDispatch?: ProviderBeforeDispatch,
): AiGatewayTransport | null {
	const gatewayId = env.AI_GATEWAY_LLM_ID?.trim();
	if (!gatewayId || !azureResourceName(env)) return null;
	return resolveAiGatewayTransport(
		env,
		gatewayId,
		"azure-openai",
		beforeDispatch,
	);
}

export function usingAzureGateway(env: AzureChatEnv): boolean {
	return azureGatewayTransport(env) !== null;
}

/**
 * The fetch an Azure gateway request must be sent with: the Workers AI
 * binding's when `azure-openai` is allowlisted, otherwise the global one.
 */
export function azureGatewayFetch(
	env: AzureChatEnv,
	beforeDispatch?: ProviderBeforeDispatch,
): typeof fetch {
	const transport = azureGatewayTransport(env, beforeDispatch);
	if (!transport)
		throw new Error("Azure OpenAI requires authenticated AI Gateway BYOK");
	return transport.fetch;
}

/**
 * The gateway's `azure-openai/` provider prefix (binding host or public HTTPS,
 * per `AI_GATEWAY_BINDING_PROVIDERS`) —
 * shared with `ai-sdk-adapter.ts`'s `gatewayFetch`, which rewrites the AI-SDK's
 * own Azure URL onto this same prefix rather than rebuilding the full
 * URL (it never sees `deployment` directly, only the SDK's finished request).
 */
export function azureGatewayPrefix(env: AzureChatEnv): string {
	const transport = azureGatewayTransport(env);
	if (!transport) {
		throw new Error("Azure OpenAI requires authenticated AI Gateway BYOK");
	}
	return `${transport.providerRoot}/`;
}

export function azureChatUrl(env: AzureChatEnv, deployment: string): string {
	const resource = azureResourceName(env);
	if (!resource) {
		throw new Error("Azure OpenAI requires authenticated AI Gateway BYOK");
	}
	return `${azureGatewayPrefix(env)}${resource}/${deployment}/chat/completions?api-version=${env.AZURE_OPENAI_API_VERSION}`;
}

/**
 * Request headers for an Azure chat fetch. Attaches bounded
 * `cf-aig-metadata` for per-tedi/run/work/session attribution when metadata is
 * provided. Empty values are dropped so we never emit blank tags.
 */
/**
 * Normalize {@link AigMetadata} to the five-entry AI Gateway contract.
 * Exceeding the cap is a programming error: silently truncating would destroy
 * the exact cost attribution this header exists to preserve.
 */
export function aigMetadataRecord(
	metadata?: AigMetadata,
): Record<string, string> | null {
	if (!metadata) return null;
	const entries = Object.entries(metadata).filter(
		([, v]) => typeof v === "string" && v.length > 0,
	);
	if (entries.length > 5) {
		throw new Error(
			`AI Gateway metadata exceeds the 5-entry limit (${entries.length})`,
		);
	}
	return entries.length > 0
		? (Object.fromEntries(entries) as Record<string, string>)
		: null;
}

/** Serialize {@link AigMetadata} into the `cf-aig-metadata` header value. */
export function aigMetadataHeader(metadata?: AigMetadata): string | null {
	const record = aigMetadataRecord(metadata);
	return record ? JSON.stringify(record) : null;
}

export function azureChatHeaders(
	env: AzureChatEnv,
	metadata?: AigMetadata,
): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	const transport = azureGatewayTransport(env);
	if (!transport) {
		throw new Error("Azure OpenAI requires authenticated AI Gateway BYOK");
	}
	const meta = aigMetadataHeader(metadata);
	if (meta) headers["cf-aig-metadata"] = meta;
	// On the binding transport this is the pre-authenticated sentinel, not a
	// token: the binding channel already carries account identity.
	headers["cf-aig-authorization"] = `Bearer ${transport.authorization}`;
	// Keep the provider-owned billing lane when stored credentials are unavailable.
	headers["cf-aig-no-wholesale"] = "true";
	return headers;
}

/**
 * Non-streaming Azure OpenAI chat call used by the Observer path.
 * Returns the raw `choices[0].message.content` string (or empty).
 */
export interface ObserverCallOptions {
	env: AzureChatEnv & { AZURE_OBSERVER_DEPLOYMENT: string };
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
	temperature?: number;
	maxCompletionTokens?: number;
	signal?: AbortSignal;
	metadata?: AigMetadata;
	/** Private verified caller guard; never part of prompt or attribution. */
	beforeDispatch?: ProviderBeforeDispatch;
	/**
	 * Azure deployment for this observer call. Omitted (the default and only
	 * pre-existing path) → `env.AZURE_OBSERVER_DEPLOYMENT` verbatim. Set by the
	 * runtime when the tedi's runtime profile carries an `observerModelRef`, so
	 * background observation can run on a cheaper model than the chat turn it
	 * observes.
	 */
	deployment?: string;
}

/**
 * Azure rejects `json_object` mode with a 400 unless some message mentions
 * "json"; reflector prompts that only describe the shape lost every call.
 */
export function withJsonInstruction(
	messages: ObserverCallOptions["messages"],
): ObserverCallOptions["messages"] {
	if (messages.some((message) => /json/i.test(message.content)))
		return messages;
	return [
		...messages,
		{ role: "system", content: "Respond with a single JSON object." },
	];
}

export async function observerCompletion(
	opts: ObserverCallOptions,
): Promise<string> {
	const deployment = opts.deployment || opts.env.AZURE_OBSERVER_DEPLOYMENT;
	const url = azureChatUrl(opts.env, deployment);
	const body = JSON.stringify({
		messages: withJsonInstruction(opts.messages),
		// GPT-5 reasoning deployments reject `temperature`. Observer quality is
		// schema-constrained, so use the provider default across Azure models.
		max_completion_tokens: opts.maxCompletionTokens ?? 4000,
		response_format: { type: "json_object" },
	});
	assertAiRequestSize(body, opts.env.TEDI_MAX_AI_REQUEST_BYTES);
	const requestGuard = requestInferenceOriginGuard(opts.beforeDispatch);
	const metadata = await authorizeInferenceEntitlement(opts.env, {
		metadata: opts.metadata,
		execution: azureExecutionIdentity({
			url,
			model: deployment,
			accountId: opts.env.AI_GATEWAY_ACCOUNT_ID,
			gatewayId: opts.env.AI_GATEWAY_LLM_ID,
			transportKind: azureGatewayTransport(opts.env)?.kind ?? "https",
		}),
		body,
		beforeDispatch: requestGuard,
		signal: opts.signal,
	});
	opts.signal?.throwIfAborted();
	const response = await azureGatewayFetch(opts.env, metadata.beforeDispatch)(
		url,
		{
			method: "POST",
			signal: opts.signal,
			headers: azureChatHeaders(opts.env, metadata.attribution),
			body,
		},
	);
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`Azure OpenAI observer ${deployment}: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 2000)}` : ""}`,
		);
	}
	const data = (await response.json()) as ChatCompletionResponse;
	return data.choices?.[0]?.message?.content ?? "";
}
