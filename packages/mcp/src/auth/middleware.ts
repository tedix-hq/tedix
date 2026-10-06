/**
 * @tedix/mcp — Auth Middleware
 *
 * Validates incoming MCP requests using multiple auth methods:
 * 1. JWT (Descope OAuth / Tedi V2 JWT) via Authorization: Bearer header
 * 2. Gateway token (internal container calls) via Authorization: Bearer header
 * 3. API key (sk_*) via X-API-Key header
 */

import {
	anonymousPrincipal,
	internalPrincipal,
	jwtPrincipal,
} from "./principal";
import type { McpAuthContext, McpAuthOptions } from "./types";

// =============================================================================
// JWT VALIDATION TYPES — loose coupling to @tedix/auth
// =============================================================================

/**
 * JWT payload fields we inspect. Using a minimal interface here
 * to avoid hard-coupling to the full @tedix/auth JWTPayload type.
 * Consumers pass in their own validateToken + extractScopes functions.
 */
export interface JwtPayloadLike {
	sub?: string;
	email?: string;
	client_id?: string;
	/** Descope tenant claim */
	tenants?: Record<string, unknown>;
	/** Tedi V2 JWT claims */
	tediId?: string;
	descopeUserId?: string;
	[key: string]: unknown;
}

/**
 * JWT validator function — provided by the consumer.
 * Typically wraps @tedix/auth/jwt validateToken().
 */
export type JwtValidator = (
	token: string,
	options: {
		projectId: string;
		baseUrl?: string;
		allowedAudiences?: string[];
		allowTediJwt?: boolean;
	},
) => Promise<JwtPayloadLike>;

/**
 * JWT scope extractor — provided by the consumer.
 * Typically wraps @tedix/auth/types extractJwtScopes().
 */
export type JwtScopeExtractor = (payload: JwtPayloadLike) => string[];

/**
 * JWT tenant ID extractor — provided by the consumer.
 * Typically wraps @tedix/auth/types getTenantId().
 */
export type JwtTenantExtractor = (
	payload: JwtPayloadLike,
) => string | undefined;

// =============================================================================
// MIDDLEWARE
// =============================================================================

export interface McpAuthMiddlewareConfig extends McpAuthOptions {
	/** JWT validator function (e.g., from @tedix/auth/jwt) */
	validateJwt?: JwtValidator;
	/** JWT scope extractor (e.g., from @tedix/auth/types) */
	extractScopes?: JwtScopeExtractor;
	/** JWT tenant ID extractor (e.g., from @tedix/auth/types) */
	extractTenantId?: JwtTenantExtractor;
}

/**
 * Create an MCP auth middleware function.
 *
 * Returns a function that takes a Request and resolves authentication.
 * Returns McpAuthContext on success, or a Response (error) that should
 * be returned to the client.
 *
 * @example
 * ```ts
 * const authenticate = createMcpAuthMiddleware({
 *   descopeProjectId: env.DESCOPE_PROJECT_ID,
 *   gatewayToken: env.GATEWAY_TOKEN,
 *   validateJwt: validateToken,
 *   extractScopes: extractJwtScopes,
 *   extractTenantId: getTenantId,
 * });
 *
 * const result = await authenticate(request);
 * if (result instanceof Response) return result; // error
 * // result is McpAuthContext
 * ```
 */
export function createMcpAuthMiddleware(
	config: McpAuthMiddlewareConfig,
): (request: Request) => Promise<McpAuthContext | Response> {
	return async (request: Request): Promise<McpAuthContext | Response> => {
		// -----------------------------------------------------------------------
		// 1. Check X-API-Key header first (API key auth)
		// -----------------------------------------------------------------------
		const apiKey = request.headers.get("X-API-Key");
		if (apiKey && config.apiKeyValidator) {
			const ctx = await config.apiKeyValidator(apiKey);
			if (ctx) return ctx;

			return new Response(JSON.stringify({ error: "Invalid API key" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		// -----------------------------------------------------------------------
		// 2. Check Authorization: Bearer header
		// -----------------------------------------------------------------------
		const authHeader = request.headers.get("Authorization");

		if (!authHeader) {
			if (config.allowUnauthenticated) {
				return {
					authenticated: false,
					authMethod: "none",
					scopes: [],
					principal: anonymousPrincipal(),
				};
			}

			return new Response(JSON.stringify({ error: "Authorization required" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			});
		}

		const match = authHeader.match(/^Bearer\s+(.+)$/i);
		if (!match?.[1]) {
			return new Response(
				JSON.stringify({ error: "Invalid Authorization header format" }),
				{
					status: 401,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		const token = match[1];

		// -----------------------------------------------------------------------
		// 3. Gateway token match (internal container calls)
		// -----------------------------------------------------------------------
		if (config.gatewayToken && token === config.gatewayToken) {
			const principal = internalPrincipal("gateway-token", {
				scopes: config.gatewayScopes ?? [],
			});
			return {
				authenticated: true,
				authMethod: "gateway-token",
				scopes: principal.scopes,
				principal,
			};
		}

		// -----------------------------------------------------------------------
		// 4. JWT validation (Descope OAuth / Tedi V2)
		// -----------------------------------------------------------------------
		if (
			token.startsWith("eyJ") &&
			config.validateJwt &&
			config.descopeProjectId
		) {
			try {
				const payload = await config.validateJwt(token, {
					projectId: config.descopeProjectId,
					baseUrl: config.descopeBaseUrl,
					allowedAudiences: config.expectedAudience
						? [config.expectedAudience]
						: [],
					allowTediJwt: config.allowTediJwt ?? true,
				});

				const scopes = config.extractScopes
					? config.extractScopes(payload)
					: [];

				const tenantId = config.extractTenantId
					? config.extractTenantId(payload)
					: undefined;

				return {
					authenticated: true,
					authMethod: "jwt",
					userId: payload.sub,
					orgId: tenantId,
					tediId: payload.tediId as string | undefined,
					scopes,
					clientId: payload.client_id as string | undefined,
					email: payload.email as string | undefined,
					principal: jwtPrincipal({
						subject: payload.sub,
						orgId: tenantId,
						tenantId,
						tediId: payload.tediId as string | undefined,
						descopeUserId: payload.descopeUserId as string | undefined,
						clientId: payload.client_id as string | undefined,
						email: payload.email as string | undefined,
						scopes,
						audiences: Array.isArray(payload.aud)
							? payload.aud.map(String)
							: typeof payload.aud === "string"
								? [payload.aud]
								: [],
					}),
				};
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Token validation failed";

				return new Response(
					JSON.stringify({ error: "Invalid token", message }),
					{
						status: 401,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
		}

		// -----------------------------------------------------------------------
		// 5. Reject sk_* API keys in Bearer header (must use X-API-Key)
		// -----------------------------------------------------------------------
		if (token.startsWith("sk_")) {
			return new Response(
				JSON.stringify({
					error: "Invalid token",
					message:
						"API keys (sk_*) are not accepted in Authorization header. Use X-API-Key header or a Descope OAuth token.",
				}),
				{
					status: 401,
					headers: { "Content-Type": "application/json" },
				},
			);
		}

		// -----------------------------------------------------------------------
		// 6. Unknown token format — fall through to unauthenticated if allowed
		// -----------------------------------------------------------------------
		if (config.allowUnauthenticated) {
			return {
				authenticated: false,
				authMethod: "none",
				scopes: [],
				principal: anonymousPrincipal(),
			};
		}

		return new Response(JSON.stringify({ error: "Invalid token" }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	};
}

// =============================================================================
// HELPERS
// =============================================================================

/** RFC 9110 §5.6.4 quoted-string content: escape backslash and DQUOTE. */
function quotedStringContent(value: string): string {
	return value.replace(/[\\"]/g, "\\$&");
}

/**
 * Build a WWW-Authenticate header value per RFC 9728.
 * Points to the OAuth Protected Resource metadata endpoint.
 *
 * When `scopes` is provided, appends an RFC 6750 `scope` parameter so v2
 * clients can drive automatic scope-union step-up re-auth.
 */
export function buildWwwAuthenticate(
	hostname: string,
	error?: string,
	errorDescription?: string,
	scopes?: string[] | string,
): string {
	const resourceMetadataUrl = `https://${hostname}/.well-known/oauth-protected-resource`;
	let value = `Bearer resource_metadata="${resourceMetadataUrl}"`;
	if (error) {
		value += `, error="${error}"`;
	}
	if (errorDescription) {
		value += `, error_description="${quotedStringContent(errorDescription)}"`;
	}
	const scopeValue = Array.isArray(scopes) ? scopes.join(" ") : scopes;
	if (scopeValue) {
		value += `, scope="${quotedStringContent(scopeValue)}"`;
	}
	return value;
}
