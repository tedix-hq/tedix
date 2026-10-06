/**
 * Shared auth principal model for Tedix runtime edges.
 *
 * Transport-specific auth code can stay local, but successful auth should be
 * projected into this shape so MCP, tedi, API, and client code use the same
 * vocabulary for caller identity and capability.
 */

export type AuthPrincipalSource =
	| "anonymous"
	| "user-jwt"
	| "tedi-jwt"
	| "aih-oauth"
	| "aih-m2m"
	| "api-key"
	| "service-binding"
	| "gateway-token";

export interface AuthPrincipal {
	authenticated: boolean;
	source: AuthPrincipalSource;
	subject?: string;
	orgId?: string;
	tenantId?: string;
	tediId?: string;
	descopeUserId?: string;
	clientId?: string;
	email?: string;
	scopes: string[];
	audiences: string[];
	internal?: boolean;
	verified?: boolean;
}

export function anonymousPrincipal(): AuthPrincipal {
	return {
		authenticated: false,
		source: "anonymous",
		scopes: [],
		audiences: [],
	};
}

export function internalPrincipal(
	source: Extract<AuthPrincipalSource, "service-binding" | "gateway-token">,
	overrides: Partial<AuthPrincipal> = {},
): AuthPrincipal {
	return {
		authenticated: true,
		source,
		internal: true,
		scopes: [],
		audiences: [],
		...overrides,
	};
}

export function jwtPrincipal(params: {
	source?: Extract<
		AuthPrincipalSource,
		"user-jwt" | "tedi-jwt" | "aih-oauth" | "aih-m2m"
	>;
	subject?: string;
	orgId?: string;
	tenantId?: string;
	tediId?: string;
	descopeUserId?: string;
	clientId?: string;
	email?: string;
	scopes?: string[];
	audiences?: string[];
	verified?: boolean;
}): AuthPrincipal {
	return {
		authenticated: true,
		source:
			params.source ??
			(params.tediId ? "tedi-jwt" : params.clientId ? "aih-oauth" : "user-jwt"),
		subject: params.subject,
		orgId: params.orgId,
		tenantId: params.tenantId,
		tediId: params.tediId,
		descopeUserId: params.descopeUserId,
		clientId: params.clientId,
		email: params.email,
		scopes: params.scopes ?? [],
		audiences: params.audiences ?? [],
		verified: params.verified,
	};
}

export function apiKeyPrincipal(params: {
	subject?: string;
	orgId?: string;
	scopes?: string[];
}): AuthPrincipal {
	return {
		authenticated: true,
		source: "api-key",
		subject: params.subject,
		orgId: params.orgId,
		scopes: params.scopes ?? [],
		audiences: [],
	};
}
