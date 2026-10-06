/**
 * AI Gateway transport resolution.
 *
 * ONE place that decides HOW an AI Gateway request leaves this Worker:
 *
 *   - BINDING (preferred) — `env.AI.fetch()` against
 *     `https://workers-binding.ai/ai-gateway/gateways/{gateway}/{provider}/…`.
 *     That is the public gateway path MINUS the account id: the binding channel
 *     already carries account identity, so there is no API token and no
 *     public-internet hop, and the request body streams through the provider's
 *     NATIVE path untouched (never spliced into a universal-endpoint JSON
 *     envelope, which would copy a multi-MB prompt inside the isolate).
 *   - HTTPS — `https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider}/…`
 *     authenticated with `cf-aig-authorization: Bearer <CF_AI_GATEWAY_TOKEN>`.
 *
 * Binding requests reach ONLY gateways in the Worker's OWN Cloudflare account,
 * and a Worker cannot discover its own account id, so it cannot check that for
 * itself. `AI_GATEWAY_BINDING_PROVIDERS` is therefore an explicit,
 * empty-by-default allowlist of the AI Gateway provider path segments whose
 * gateway is known to be in-account (ordinary Worker config, alongside
 * `AI_GATEWAY_ACCOUNT_ID`/`AI_GATEWAY_LLM_ID`). Any provider not listed resolves
 * to the HTTPS path with its token — that is how a deployment whose gateway
 * lives in a DIFFERENT account, or a provider that cannot ride the binding at
 * all, is configured.
 *
 * Shared by every Worker that talks to an AI Gateway (the kernel in `apps/api`
 * and the Agent runtime in `apps/tedi-runtime`). Resolution is pure env →
 * transport: nothing here knows or tests which app is calling.
 */

/** Private caller closure, never serialized as attribution or request configuration. */
export type ProviderBeforeDispatch = () => void;
/** Refusal before the wire is neither a provider failure nor a provider usage receipt. */
export class ProviderDispatchGuardError extends Error {
	readonly phase = "before_dispatch";
	readonly providerRequestSent = false;
	constructor(cause: unknown) {
		super("Provider dispatch authority rejected", { cause });
		this.name = "ProviderDispatchGuardError";
	}
}
/** No await may separate this check from the actual provider send. */
export function assertProviderDispatchReady(
	beforeDispatch?: ProviderBeforeDispatch,
): void {
	if (beforeDispatch === undefined) return;
	try {
		const result: unknown = beforeDispatch();
		if (result !== undefined) {
			// TS permits async functions where void is expected. Deny them without awaiting;
			// consume an eventual rejection so invalid async guards cannot leak unhandled errors.
			if (
				result !== null &&
				(typeof result === "object" || typeof result === "function") &&
				typeof (result as { then?: unknown }).then === "function"
			)
				void Promise.resolve(result).catch(() => {});
			throw new Error(
				"Provider dispatch guard must return synchronously without a value",
			);
		}
	} catch (cause) {
		throw new ProviderDispatchGuardError(cause);
	}
}

/** AI Gateway provider path segments this deployment routes through. */
export type AiGatewayProvider =
	| "workers-ai"
	| "azure-openai"
	| "google-ai-studio";

/** Env surface the transport reads. Every field is optional and read defensively. */
export interface AiGatewayTransportEnv {
	/**
	 * Workers AI binding. Also the gateway transport — see the note at
	 * {@link resolveAiGatewayTransport}'s binding-resolution site.
	 */
	AI?: Ai;
	AI_GATEWAY_ACCOUNT_ID?: string;
	CF_AI_GATEWAY_TOKEN?: string;
	/**
	 * Comma-separated allowlist of {@link AiGatewayProvider} segments served by
	 * an in-account gateway, which may therefore ride the Workers AI binding.
	 * Unset/empty → every provider stays on the HTTPS + token path.
	 */
	AI_GATEWAY_BINDING_PROVIDERS?: string;
	/** Deployment-owned Auto Router candidate restrictions; never caller input. */
	AI_GATEWAY_AUTO_ALLOWED_PROVIDERS?: string;
	AI_GATEWAY_AUTO_ALLOWED_MODELS?: string;
	AI_GATEWAY_AUTO_ALLOWED_IMAGE_MODELS?: string;
}

/**
 * AI Gateway rejects a request carrying no recognized auth header before
 * dispatch. Binding calls are pre-authenticated in-account, so this sentinel
 * satisfies that check; the gateway recognizes and strips it rather than
 * treating it as a BYOK provider key.
 */
export const AI_GATEWAY_BINDING_AUTH = "cloudflare-gateway-binding";

export interface AiGatewayTransport {
	kind: "binding" | "https";
	/** Provider root for this gateway, without a trailing slash. */
	providerRoot: string;
	/** Bearer value for `cf-aig-authorization`. */
	authorization: string;
	/** The fetch the request must be sent with. */
	fetch: typeof fetch;
}

export interface CloudflareAutoRouterRequest {
	body: string;
	attribution?: Record<string, string>;
	sessionId?: string;
	turnId?: string;
	signal?: AbortSignal;
}

export interface CloudflareAutoRouterResult {
	body: unknown;
	routedModel: string | null;
	routingReason: string | null;
	routingDecisionId: string | null;
	requestId: string | null;
}

/** Validate deployment-owned candidate policy before reserving paid inference. */
export function cloudflareAutoRouterCandidateHeaders(
	env: AiGatewayTransportEnv,
	messages: unknown,
): Record<string, string> {
	const headers: Record<string, string> = {};
	const hasImage =
		Array.isArray(messages) &&
		messages.some(
			(message) =>
				Array.isArray(message?.content) &&
				message.content.some(
					(part: { type?: unknown } | null) => part?.type === "image_url",
				),
		);
	if (hasImage && !env.AI_GATEWAY_AUTO_ALLOWED_IMAGE_MODELS?.trim())
		throw new Error("Auto Router image candidate pool is not configured");
	const modelPool = hasImage
		? env.AI_GATEWAY_AUTO_ALLOWED_IMAGE_MODELS
		: env.AI_GATEWAY_AUTO_ALLOWED_MODELS;
	for (const [header, raw] of [
		["cf-aig-allowed-providers", env.AI_GATEWAY_AUTO_ALLOWED_PROVIDERS],
		["cf-aig-allowed-models", modelPool],
	] as const) {
		if (raw === undefined) continue;
		const entries = raw.split(",").map((entry) => entry.trim());
		if (
			entries.some(
				(entry) => !/^[a-zA-Z0-9@][a-zA-Z0-9@/_.:-]*$/.test(entry),
			) ||
			/[\r\n]/.test(raw)
		) {
			throw new Error(`Invalid deployment configuration for ${header}`);
		}
		headers[header] = entries.join(",");
	}
	return headers;
}

/**
 * Call Auto Router through its documented authenticated `compat` endpoint.
 * The binding provider path is intentionally not guessed here: Cloudflare's
 * Auto Router documentation currently specifies the HTTPS endpoint exactly.
 */
export async function openCloudflareAutoRouterResponse(
	env: AiGatewayTransportEnv,
	gatewayId: string,
	request: CloudflareAutoRouterRequest,
	beforeDispatch?: ProviderBeforeDispatch,
): Promise<Response> {
	request.signal?.throwIfAborted();
	const account = env.AI_GATEWAY_ACCOUNT_ID?.trim();
	const gateway = gatewayId.trim();
	const token = env.CF_AI_GATEWAY_TOKEN?.trim();
	if (!account || !gateway || !token) {
		throw new Error(
			"cloudflare auto router requires AI_GATEWAY_ACCOUNT_ID, AI_GATEWAY_LLM_ID, and CF_AI_GATEWAY_TOKEN",
		);
	}
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		"cf-aig-authorization": `Bearer ${token}`,
	};
	Object.assign(
		headers,
		cloudflareAutoRouterCandidateHeaders(
			env,
			JSON.parse(request.body).messages,
		),
	);
	if (request.attribution && Object.keys(request.attribution).length > 0) {
		headers["cf-aig-metadata"] = JSON.stringify(request.attribution);
	}
	if (request.sessionId?.trim()) {
		headers["cf-aig-session-id"] = request.sessionId.trim();
	}
	if (request.turnId?.trim()) headers["cf-aig-turn-id"] = request.turnId.trim();

	assertProviderDispatchReady(beforeDispatch);
	const response = await fetch(
		`https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(account)}/${encodeURIComponent(gateway)}/compat/chat/completions`,
		{
			method: "POST",
			headers,
			body: request.body,
			signal: request.signal,
		},
	);
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`cloudflare auto router: ${response.status} ${response.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ""}`,
		);
	}
	return response;
}

export async function callCloudflareAutoRouter(
	env: AiGatewayTransportEnv,
	gatewayId: string,
	request: CloudflareAutoRouterRequest,
	beforeDispatch?: ProviderBeforeDispatch,
): Promise<CloudflareAutoRouterResult> {
	const response = await openCloudflareAutoRouterResponse(
		env,
		gatewayId,
		request,
		beforeDispatch,
	);
	return {
		body: await response.json(),
		routedModel: response.headers.get("cf-aig-routed-model"),
		routingReason: response.headers.get("cf-aig-routing-reason"),
		routingDecisionId: response.headers.get("cf-aig-routing-decision-id"),
		requestId: response.headers.get("cf-aig-request-id"),
	};
}

/**
 * `Ai#fetch` exists at runtime but `@cloudflare/workers-types`' `Ai` does not
 * declare it, so the binding is reached structurally.
 */
interface AiFetchBinding {
	fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

/**
 * The URL already names the gateway route on the binding's host, so the
 * binding's fetch passes input and init straight through — no rewriting, no
 * body copy.
 */
function bindingFetch(
	binding: Ai,
	beforeDispatch?: ProviderBeforeDispatch,
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		assertProviderDispatchReady(beforeDispatch);
		return (binding as unknown as AiFetchBinding).fetch(input, init);
	}) as typeof fetch;
}

/** Parse the allowlist once; a stray blank entry never enables a provider. */
function aiGatewayBindingProviders(raw?: string): Set<string> {
	return new Set(
		(raw ?? "")
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0),
	);
}

/**
 * Resolve the transport for one provider on one gateway, or `null` when neither
 * transport is configured.
 */
export function resolveAiGatewayTransport(
	env: AiGatewayTransportEnv,
	gatewayId: string,
	provider: AiGatewayProvider,
	beforeDispatch?: ProviderBeforeDispatch,
): AiGatewayTransport | null {
	const gateway = gatewayId.trim();
	if (!gateway) return null;

	// Binding-resolution site. A deployment opts a provider OUT of the binding
	// transport by leaving it out of AI_GATEWAY_BINDING_PROVIDERS — NEVER by
	// removing the `AI` binding from wrangler.jsonc. The binding is not only
	// this transport: `env.AI.toMarkdown()` backs PDF/document content
	// ingestion elsewhere in this Worker, and unbinding would break that too.
	const binding = env.AI;
	if (
		binding &&
		aiGatewayBindingProviders(env.AI_GATEWAY_BINDING_PROVIDERS).has(provider)
	) {
		return {
			kind: "binding",
			providerRoot: `https://workers-binding.ai/ai-gateway/gateways/${gateway}/${provider}`,
			authorization: AI_GATEWAY_BINDING_AUTH,
			fetch: bindingFetch(binding, beforeDispatch),
		};
	}

	const accountId = env.AI_GATEWAY_ACCOUNT_ID?.trim();
	const token = env.CF_AI_GATEWAY_TOKEN?.trim();
	if (!accountId || !token) return null;
	return {
		kind: "https",
		providerRoot: `https://gateway.ai.cloudflare.com/v1/${accountId}/${gateway}/${provider}`,
		authorization: token,
		fetch:
			beforeDispatch === undefined
				? fetch
				: ((async (input: RequestInfo | URL, init?: RequestInit) => {
						assertProviderDispatchReady(beforeDispatch);
						return fetch(input, init);
					}) as typeof fetch),
	};
}
