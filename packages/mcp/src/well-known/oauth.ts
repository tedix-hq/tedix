/**
 * @tedix/mcp — OAuth Authorization Server Metadata
 *
 * Helpers for building Descope AIH authorization server discovery URLs.
 * Used by the `.well-known/oauth-protected-resource` handler to point
 * MCP clients to the correct authorization server.
 *
 * @see https://docs.descope.com/agentic-identity-hub
 */

// =============================================================================
// URL BUILDERS
// =============================================================================

/**
 * Generate the Descope-hosted authorization server base URL for an MCP Server.
 * Used as the `authorization_servers` entry in protected resource metadata.
 *
 * baseUrl must be DESCOPE_AIH_BASE_URL from env -- custom domains do not proxy
 * /v1/apps/agentic/* paths.
 *
 * @example
 * getDescopeAuthServerUrl("P2abc123", "ms_xyz789", "https://api.descope.com")
 * // "https://api.descope.com/v1/apps/agentic/P2abc123/ms_xyz789"
 */
export function getDescopeAuthServerUrl(
	projectId: string,
	mcpServerId: string,
	baseUrl: string,
): string {
	return `${baseUrl}/v1/apps/agentic/${projectId}/${mcpServerId}`;
}

/**
 * Generate the Descope-hosted OpenID Connect discovery URL for an MCP Server.
 * This is the URL MCP clients use to discover authorization endpoints.
 *
 * @example
 * getDescopeDiscoveryUrl("P2abc123", "ms_xyz789", "https://api.descope.com")
 * // "https://api.descope.com/v1/apps/agentic/P2abc123/ms_xyz789/.well-known/openid-configuration"
 */
export function getDescopeDiscoveryUrl(
	projectId: string,
	mcpServerId: string,
	baseUrl: string,
): string {
	return `${baseUrl}/v1/apps/agentic/${projectId}/${mcpServerId}/.well-known/openid-configuration`;
}

// =============================================================================
// SCOPE COLLECTION — for OAuth metadata responses
// =============================================================================

/**
 * Scope configuration from app mcpConfig.
 */
export interface ScopeConfigLike {
	enforcePolicies?: boolean;
	toolScopes?: Record<string, string[]>;
	scopeDescriptions?: Record<string, string>;
}

export interface RegisteredScopeDefinition {
	/** Registered or advertised scope string */
	name: string;
	/** Human-readable description */
	description: string;
}

/**
 * Collect deduplicated configured scopes from MCP config.
 */
export function collectConfiguredScopes(
	mcpConfig: ScopeConfigLike | null | undefined,
): RegisteredScopeDefinition[] {
	if (!mcpConfig) return [];

	const seen = new Set<string>();
	const scopes: RegisteredScopeDefinition[] = [];
	const scopeDescriptions = mcpConfig.scopeDescriptions;

	const addScope = (scope: string) => {
		if (!scope || seen.has(scope)) return;
		seen.add(scope);
		scopes.push({
			name: scope,
			description: scopeDescriptions?.[scope] ?? scope,
		});
	};

	for (const scopeList of Object.values(mcpConfig.toolScopes ?? {})) {
		for (const scope of scopeList ?? []) addScope(scope);
	}
	// `scopeDescriptions` is the Resource's declared grant catalog, not a
	// per-tool authorization override. Keep it independently enumerable so an
	// aggregate app can use the shared namespace resolver for tool enforcement
	// (`toolScopes: {}`) without making RFC 9728 discovery disappear. Descope's
	// live metadata remains authoritative when it is reachable; this catalog is
	// the exact D1 fallback used during an upstream discovery failure.
	for (const scope of Object.keys(scopeDescriptions ?? {})) addScope(scope);

	return scopes;
}

/**
 * Collect the scopes an MCP server should advertise/register.
 *
 * - Policy mode (`enforcePolicies: true`): per-tool `mcp:<tool>` scopes from live tools
 * - D1 config mode: the Resource catalog from `scopeDescriptions`, plus any
 *   scopes referenced by explicit per-tool overrides
 */
export function collectAdvertisedScopes(params: {
	mcpConfig: ScopeConfigLike | null | undefined;
	tools?: Array<{ name: string; description?: string }>;
	toolToScope?: (toolId: string) => string;
}): RegisteredScopeDefinition[] {
	const { mcpConfig, tools = [] } = params;
	const toScope =
		params.toolToScope ?? ((id: string) => `mcp:${id.replace(/_/g, ".")}`);

	if (mcpConfig?.enforcePolicies) {
		return tools.map((tool) => {
			const scope = toScope(tool.name);
			return {
				name: scope,
				description:
					mcpConfig.scopeDescriptions?.[scope] ??
					tool.description ??
					`Access to ${tool.name}`,
			};
		});
	}

	return collectConfiguredScopes(mcpConfig);
}
