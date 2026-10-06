/**
 * oRPC Client Utilities
 *
 * Provides factory functions for creating type-safe API clients.
 * Follows the official oRPC pattern: https://orpc.unnoq.com/docs/client/client-side
 *
 * Works in both browser and Cloudflare Workers environments.
 *
 * Usage:
 *
 * ```ts
 * import type { ApiContract } from "@tedix/api-contract/contracts/api";
 * import { createLink, createORPCClient } from "@tedix/api-client/client";
 *
 * const link = createLink({ url: "https://api.tedix.dev/rpc" });
 * const client: RouterContractClient<ApiContract> = createORPCClient(link);
 *
 * // All calls are fully typed!
 * const result = await client.listings.search({ q: "iPhone", appId: "..." });
 * ```
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RetryLinkPlugin } from "@orpc/client/plugins";
import type { RouterContract, RouterContractClient } from "@orpc/contract";

export type FetchFunction = (
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

// =============================================================================
// TYPES
// =============================================================================

export interface LinkOptions {
	/**
	 * Base URL for the API (e.g., "https://api.tedix.dev/rpc")
	 */
	url: string;

	/**
	 * Static headers to include in all requests
	 */
	headers?: Record<string, string>;

	/**
	 * Dynamic headers function (called per request)
	 * Use adapters like withBearerToken(), withApiKey()
	 */
	getHeaders?: () => Promise<Record<string, string>> | Record<string, string>;

	/**
	 * Custom fetch implementation (defaults to globalThis.fetch)
	 */
	fetch?: FetchFunction;

	/**
	 * Credentials mode for fetch (needed for HttpOnly cookies)
	 * Set to 'include' for cross-origin cookie transmission
	 */
	credentials?: "include" | "omit" | "same-origin";

	/**
	 * Abort one transport request after this many milliseconds.
	 * Omitted means the caller owns the deadline.
	 */
	timeoutMs?: number;
}

export function withRequestTimeout(
	fetchImpl: FetchFunction,
	timeoutMs: number,
): FetchFunction {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error("API request timeout must be a positive finite number");
	}

	return async (input, init) => {
		const controller = new AbortController();
		const callerSignal = init?.signal;
		const abortFromCaller = () => controller.abort(callerSignal?.reason);
		if (callerSignal?.aborted) abortFromCaller();
		else
			callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
		const timer = setTimeout(
			() =>
				controller.abort(
					new Error(`API request timed out after ${timeoutMs}ms`),
				),
			timeoutMs,
		);

		try {
			return await fetchImpl(input, { ...init, signal: controller.signal });
		} catch (error) {
			if (controller.signal.aborted && !callerSignal?.aborted) {
				throw new Error(`API request timed out after ${timeoutMs}ms`, {
					cause: error,
				});
			}
			throw error;
		} finally {
			clearTimeout(timer);
			callerSignal?.removeEventListener("abort", abortFromCaller);
		}
	};
}

// =============================================================================
// LINK FACTORY
// =============================================================================

/**
 * Create an RPCLink with common configuration
 *
 * This follows the official oRPC pattern where you create a link first,
 * then pass it to createORPCClient.
 *
 * @param options - Link configuration options
 * @returns An RPCLink instance
 *
 * @example
 * ```ts
 * import type { ApiContract } from "@tedix/api-contract/contracts/api";
 * import type { RouterContractClient } from "@orpc/contract";
 *
 * const link = createLink({
 *   url: "https://api.tedix.dev/rpc",
 *   headers: { Authorization: "Bearer token" },
 * });
 *
 * const client: RouterContractClient<ApiContract> = createORPCClient(link);
 * ```
 */
export function createLink(options: LinkOptions) {
	const { url, headers, getHeaders, credentials, timeoutMs } = options;

	// Create custom fetch if credentials are needed (browser-only feature)
	// In Cloudflare Workers, credentials is ignored but type-safe in browser
	const credentialFetch = credentials
		? async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				return (options.fetch ?? globalThis.fetch.bind(globalThis))(input, {
					...init,
					credentials,
				} as RequestInit);
			}
		: (options.fetch ?? globalThis.fetch.bind(globalThis));
	const customFetch = timeoutMs
		? withRequestTimeout(credentialFetch, timeoutMs)
		: credentialFetch;

	// oRPC v2 splits the link target: `origin` carries the host and `url` is a
	// path-only `StandardUrl` (`/${string}`). Callers still pass one absolute URL,
	// so split it here rather than changing the public LinkOptions shape.
	const target = new URL(url);
	const path =
		`${target.pathname}${target.search}${target.hash}` as `/${string}`;

	return new RPCLink({
		origin: target.origin,
		url: path,
		// Keep retry support available through per-call context, but fail closed by
		// default: every oRPC procedure uses POST and may be a non-idempotent write.
		plugins: [new RetryLinkPlugin({ default: { retry: 0, retryDelay: 500 } })],
		headers: async () => {
			const dynamicHeaders = getHeaders ? await getHeaders() : {};
			return {
				...headers,
				...dynamicHeaders,
			};
		},
		fetch: customFetch,
	});
}

// =============================================================================
// HIGH-LEVEL CLIENT FACTORY
// =============================================================================

export interface ClientOptions {
	/**
	 * Static headers to include in all requests.
	 */
	headers?: Record<string, string>;

	/**
	 * Dynamic headers function (use adapters like withBearerToken, withApiKey)
	 */
	getHeaders?: () => Promise<Record<string, string>> | Record<string, string>;

	/**
	 * Credentials mode for fetch (set to 'include' for HttpOnly cookies)
	 */
	credentials?: "include" | "omit" | "same-origin";

	/**
	 * Custom fetch implementation
	 */
	fetch?: FetchFunction;

	/**
	 * Abort one transport request after this many milliseconds.
	 * Omitted means the caller owns the deadline.
	 */
	timeoutMs?: number;
}

/**
 * Create a typed API client for the given API URL
 * Convenience wrapper around createLink + createORPCClient
 *
 * @param apiUrl - Base URL of the API (e.g., "https://api.tedix.dev")
 * @param options - Optional auth and fetch configuration
 * @returns Typed client for all oRPC procedures
 *
 * @example
 * ```ts
 * import type { ApiContract } from "@tedix/api-contract/contracts/api";
 * import { getApiClient } from "@tedix/api-client/client";
 * import { withBearerToken } from "@tedix/api-client/adapters";
 *
 * const client = getApiClient<ApiContract>("https://api.tedix.dev");
 *
 * // With authentication
 * const client = getApiClient<ApiContract>("https://api.tedix.dev", {
 *   getHeaders: withBearerToken(() => getAccessToken()),
 * });
 * ```
 */
export function getApiClient<T extends RouterContract>(
	apiUrl: string,
	options?: ClientOptions,
): RouterContractClient<T> {
	const link = createLink({
		url: `${apiUrl}/rpc`,
		headers: options?.headers,
		getHeaders: options?.getHeaders,
		credentials: options?.credentials,
		fetch: options?.fetch,
		timeoutMs: options?.timeoutMs,
	});
	return createORPCClient(link);
}

// =============================================================================
// RE-EXPORTS
// =============================================================================

// Re-export oRPC utilities so consumers don't need multiple imports
export { createORPCClient } from "@orpc/client";
export { RPCLink } from "@orpc/client/fetch";
export type { RouterContractClient } from "@orpc/contract";
