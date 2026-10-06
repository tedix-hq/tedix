/**
 * @tedix/mcp — Auth Types
 *
 * Shared authentication context and configuration types for MCP servers.
 * Used by both apps/mcp (customer-facing) and apps/tedi (tedi runtime).
 */

import type { AuthPrincipal } from "./principal";

// =============================================================================
// AUTH CONTEXT — resolved after middleware runs
// =============================================================================

export interface McpAuthContext {
	/** Whether the request is authenticated */
	authenticated: boolean;
	/** Which auth method was used */
	authMethod: "jwt" | "gateway-token" | "api-key" | "none";
	/** Descope user ID (sub claim) */
	userId?: string;
	/** Organization ID (tenant claim) */
	orgId?: string;
	/** Tedi ID (custom claim on V2 JWTs) */
	tediId?: string;
	/** Granted scopes from JWT or capability profile */
	scopes: string[];
	/** OAuth client ID (if present) */
	clientId?: string;
	/** User email (if present) */
	email?: string;
	/** Normalized caller identity used across Tedix auth surfaces */
	principal?: AuthPrincipal;
}

// =============================================================================
// AUTH OPTIONS — middleware configuration
// =============================================================================

export interface McpAuthOptions {
	/** Gateway token for internal container calls (matched against Bearer token) */
	gatewayToken?: string;
	/** Exact capabilities delegated to the gateway token. Defaults to none. */
	gatewayScopes?: string[];
	/** Descope project ID for JWT validation */
	descopeProjectId?: string;
	/** Descope base URL for JWKS resolution */
	descopeBaseUrl?: string;
	/** Custom API key validator — return context on success, null on failure */
	apiKeyValidator?: (key: string) => Promise<McpAuthContext | null>;
	/** Allow unauthenticated access (for public tools). Default: false */
	allowUnauthenticated?: boolean;
	/** Expected audience claim for JWT validation */
	expectedAudience?: string;
	/** Allow tedi V2 JWTs (with tediId/descopeUserId claims). Default: true */
	allowTediJwt?: boolean;
}
