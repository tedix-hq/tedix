/**
 * Authentication Adapters for @tedix/api-client
 *
 * Provides helper functions for common auth patterns:
 * - withBearerToken: User JWT authentication (browser user sessions)
 * - withApiKey: API key authentication (automation)
 *
 * @example
 * ```ts
 * import { createLink, createORPCClient } from "@tedix/api-client/client";
 * import { withBearerToken } from "@tedix/api-client/adapters";
 *
 * const link = createLink({
 *   url: "https://api.tedix.dev/rpc",
 *   getHeaders: withBearerToken(() => getAccessToken()),
 * });
 * ```
 */

// =============================================================================
// TYPES
// =============================================================================

export type HeadersFunction = () =>
	| Promise<Record<string, string>>
	| Record<string, string>;
export type TokenGetter = () =>
	| Promise<string | null | undefined>
	| string
	| null
	| undefined;

// =============================================================================
// AUTH ADAPTERS
// =============================================================================

/**
 * Create headers function for Bearer token authentication
 *
 * Used for browser user-session authentication when a trusted server boundary
 * supplies the user JWT.
 *
 * @param getToken - Function that returns the access token
 * @returns Headers function for use with createLink
 *
 * @example
 * ```ts
 * // Server-side browser session
 * const link = createLink({
 *   url: apiUrl,
 *   getHeaders: withBearerToken(() => getAccessToken()),
 * });
 *
 * // Client-side with static token
 * const link = createLink({
 *   url: apiUrl,
 *   getHeaders: withBearerToken(() => token),
 * });
 * ```
 */
export function withBearerToken(getToken: TokenGetter): HeadersFunction {
	return async (): Promise<Record<string, string>> => {
		const token = await getToken();
		if (!token) return {};
		return { Authorization: `Bearer ${token}` };
	};
}

/**
 * Create headers function for API key authentication
 *
 * Used for programmatic access (CLI, CI/CD, automation).
 *
 * @param apiKey - The API key (e.g., sk_test_...)
 * @returns Headers function for use with createLink
 *
 * @example
 * ```ts
 * const link = createLink({
 *   url: apiUrl,
 *   getHeaders: withApiKey(process.env.TEDIX_API_KEY),
 * });
 * ```
 */
export function withApiKey(apiKey: string | undefined): HeadersFunction {
	return (): Record<string, string> => {
		if (!apiKey) return {};
		return { "X-API-Key": apiKey };
	};
}
