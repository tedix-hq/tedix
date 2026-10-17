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
