/**
 * Canonical clients for Tedix API calls from Workers and other trusted
 * runtimes. Both typed and dynamic calls go through oRPC's RPCLink so no
 * consumer owns the RPC wire envelope or response decoder.
 */

import type { ClientLink } from "@orpc/client";
import {
	createLink,
	createORPCClient,
	type FetchFunction,
	type RouterContractClient,
} from "@tedix/api-client/client";
import type { ApiContract } from "@tedix/api-contract/contracts/api";

export interface FetcherLike {
	fetch(input: Request): Promise<Response>;
}

/** Adapt Cloudflare's Request-only service binding to oRPC's fetch contract. */
export function serviceBindingFetch(serviceFetch: FetcherLike): FetchFunction {
	return (input, init) => {
		// Some consumer tsconfigs merge a Request-only constructor declaration
		// into the DOM/Workers overloads. Runtime Request accepts the standard
		// fetch input union; keep that ambient mismatch isolated in this adapter.
		const RequestConstructor = globalThis.Request as new (
			input: string | Request,
			init?: RequestInit,
		) => Request;
		return serviceFetch.fetch(
			new RequestConstructor(
				input instanceof URL ? input.toString() : input,
				init,
			),
		);
	};
}

export interface InternalApiEnvironment {
	API_SERVICE?: FetcherLike;
}

export interface ExternalAgentHeaders {
	principalId: string;
	sessionId: string;
	clientRecordId: string;
}

export interface InternalApiClientOptions {
	/** Override the service binding supplied by the environment. */
	serviceFetch?: FetcherLike;
	/** Additional static headers for the caller identity or authorization. */
	headers?: Record<string, string>;
	/** Additional per-call headers. Dynamic values override static values. */
	getHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
	organizationId?: string;
	tediId?: string;
	caller?: string;
	/** Exact API procedure scopes delegated to this trusted Worker caller. */
	scopes?: readonly string[];
	externalAgent?: ExternalAgentHeaders;
}

export type InternalApiClient = RouterContractClient<ApiContract>;

function internalHeaders(
	options: InternalApiClientOptions,
): Record<string, string> {
	const headers: Record<string, string> = {
		"X-Service-Binding": "true",
		...options.headers,
	};
	if (options.organizationId) {
		headers["X-Tedix-Org-Id"] = options.organizationId;
	}
	if (options.tediId) {
		headers["X-Tedix-Tedi-Id"] = options.tediId;
	}
	if (options.caller) {
		headers["X-Tedix-Caller"] = options.caller;
	}
	if (options.scopes?.length) {
		headers["X-Tedix-Tedi-Scopes"] = [...new Set(options.scopes)].join(" ");
	}
	if (options.externalAgent) {
		headers["X-Tedix-Caller-Type"] = "mcp-edge-external-agent";
		headers["X-Tedix-External-Agent-Principal-Id"] =
			options.externalAgent.principalId;
		headers["X-Tedix-External-Agent-Session-Id"] =
			options.externalAgent.sessionId;
		headers["X-Tedix-External-Agent-Client-Record-Id"] =
			options.externalAgent.clientRecordId;
	}
	return headers;
}

/**
 * Create the full typed API client over a Cloudflare service binding.
 *
 * The synthetic `https://api` origin is intentionally never sent over the
 * public network: the binding's fetch implementation owns the transport.
 */
export function getInternalApiClient(
	env: InternalApiEnvironment,
	options: InternalApiClientOptions = {},
): InternalApiClient {
	const serviceFetch = options.serviceFetch ?? env.API_SERVICE;
	if (!serviceFetch) {
		throw new Error(
			"API_SERVICE binding is required for the internal Tedix API client",
		);
	}
	const link = createLink({
		url: "https://api/rpc",
		headers: internalHeaders(options),
		getHeaders: options.getHeaders,
		fetch: serviceBindingFetch(serviceFetch),
	});
	return createORPCClient(link) as InternalApiClient;
}

export interface RpcCallOptions {
	/** Public or synthetic service-binding API origin, without `/rpc`. */
	apiUrl: string;
	/** Fetch implementation, including Cloudflare service or sandbox bindings. */
	fetch?: FetchFunction;
	headers?: Record<string, string>;
	getHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Opt in only when the procedure is read-only or carries an idempotency key. */
	retry?: number;
	retryDelayMs?: number;
}

export class RpcCallError extends Error {
	readonly path: string;
	readonly status: number;
	readonly detail: string;

	constructor(
		path: string,
		status: number,
		detail: string,
		statusText: string,
		cause: unknown,
	) {
		super(
			`RPC ${path} failed (${status})${detail ? `: ${detail}` : statusText ? `: ${statusText}` : ""}`,
			{ cause },
		);
		this.name = "RpcCallError";
		this.path = path;
		this.status = status;
		this.detail = detail;
	}
}

function callerHeaders(
	headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	return Object.fromEntries(
		Object.entries(headers).filter(
			([name]) => name.toLowerCase() !== "content-type",
		),
	);
}

/**
 * Call a runtime-selected oRPC procedure through the official RPCLink.
 *
 * Prefer `getInternalApiClient` whenever the procedure is statically known.
 * This escape hatch exists for config-driven routers, CLI verbs, and runtime
 * adapters whose procedure path is data rather than TypeScript structure.
 */
export async function callRpc<TOutput = unknown>(
	path: string | readonly string[],
	input: unknown,
	options: RpcCallOptions,
): Promise<TOutput> {
	const segments =
		typeof path === "string" ? path.split("/").filter(Boolean) : [...path];
	if (segments.length === 0) {
		throw new Error("oRPC procedure path must not be empty");
	}

	let failedResponse:
		| { status: number; statusText: string; detail: string }
		| undefined;
	const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
	const transportFetch: FetchFunction = async (input, init) => {
		failedResponse = undefined;
		const response = await fetchImpl(input, init);
		if (!response.ok) {
			failedResponse = {
				status: response.status,
				statusText: response.statusText,
				detail: await response
					.clone()
					.text()
					.catch(() => ""),
			};
			return response;
		}

		return response;
	};
	const rpcLink: ClientLink<Record<PropertyKey, unknown>> = createLink({
		url: `${options.apiUrl.replace(/\/+$/, "")}/rpc`,
		headers: callerHeaders(options.headers),
		getHeaders: options.getHeaders,
		fetch: transportFetch,
	});
	const controller = options.timeoutMs ? new AbortController() : undefined;
	const signal = controller?.signal ?? options.signal;
	const abortFromCaller = () => controller?.abort(options.signal?.reason);
	if (options.signal?.aborted) {
		abortFromCaller();
	} else {
		options.signal?.addEventListener("abort", abortFromCaller, { once: true });
	}
	const timer = options.timeoutMs
		? setTimeout(
				() =>
					controller?.abort(new Error(`RPC ${segments.join("/")} timed out`)),
				options.timeoutMs,
			)
		: undefined;

	try {
		return (await rpcLink.call(segments, input, {
			context: {
				...(options.retry === undefined ? {} : { retry: options.retry }),
				...(options.retryDelayMs === undefined
					? {}
					: { retryDelay: options.retryDelayMs }),
			},
			signal,
		})) as TOutput;
	} catch (error) {
		if (failedResponse) {
			const detail = failedResponse.detail.slice(0, 800);
			throw new RpcCallError(
				segments.join("/"),
				failedResponse.status,
				detail,
				failedResponse.statusText,
				error,
			);
		}
		if (controller?.signal.aborted && !options.signal?.aborted) {
			throw new Error(
				`RPC ${segments.join("/")} timed out after ${options.timeoutMs}ms`,
				{ cause: error },
			);
		}
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}
