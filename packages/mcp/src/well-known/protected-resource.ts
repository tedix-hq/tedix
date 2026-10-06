/**
 * @tedix/mcp — RFC 9728 Protected Resource Metadata
 *
 * Implements the `.well-known/oauth-protected-resource` endpoint.
 * MCP clients use this to discover which authorization server
 * protects the resource and what scopes are available.
 *
 * Extracted from apps/mcp/src/well-known.ts for reuse.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 */

// =============================================================================
// TYPES
// =============================================================================

export interface ProtectedResourceConfig {
	/** The MCP server resource URL (e.g., "https://myapp.mcp.tedix.dev/mcp") */
	resource: string;
	/** Authorization server URLs (Descope AIH endpoint) */
	authorizationServers: string[];
	/** Supported scopes — includes platform + tool-level scopes */
	scopesSupported: string[];
	/** Bearer methods supported. Default: ["header"] */
	bearerMethodsSupported?: string[];
	/** URL to resource documentation */
	resourceDocumentation?: string;
	/** Optional scope descriptions (human-readable) */
	scopeDescriptions?: Record<string, string>;
	/**
	 * App id to stamp as a `Cache-Tag: app:{id}` response header, so a Workers
	 * Cache `ctx.cache.purge({ tags: ["app:{id}"] })` can evict this document
	 * the moment the underlying D1 `mcpConfig` changes. Omit to leave the
	 * response untagged (unchanged behavior for existing callers that don't
	 * pass it).
	 */
	cacheTagAppId?: string;
}

export interface ProtectedResourceMetadata {
	resource: string;
	authorization_servers: string[];
	bearer_methods_supported: string[];
	scopes_supported: string[];
	resource_documentation?: string;
	scope_descriptions?: Record<string, string>;
}

// =============================================================================
// HANDLER
// =============================================================================

/**
 * Build RFC 9728 OAuth Protected Resource metadata JSON.
 *
 * @example
 * ```ts
 * const metadata = buildProtectedResourceMetadata({
 *   resource: "https://myapp.mcp.tedix.dev/mcp",
 *   authorizationServers: [descopeAuthServerUrl],
 *   scopesSupported: ["mcp:search.listings", "profile", "email"],
 * });
 * ```
 */
export function buildProtectedResourceMetadata(
	config: ProtectedResourceConfig,
): ProtectedResourceMetadata {
	const metadata: ProtectedResourceMetadata = {
		resource: config.resource,
		authorization_servers: config.authorizationServers,
		bearer_methods_supported: config.bearerMethodsSupported ?? ["header"],
		scopes_supported: config.scopesSupported,
	};

	if (config.resourceDocumentation) {
		metadata.resource_documentation = config.resourceDocumentation;
	}

	if (config.scopeDescriptions) {
		metadata.scope_descriptions = config.scopeDescriptions;
	}

	return metadata;
}

/**
 * Create a Response for the `.well-known/oauth-protected-resource` endpoint.
 * Returns 404 if no scopes are configured (app doesn't use OAuth).
 *
 * @example
 * ```ts
 * if (path.startsWith("/.well-known/oauth-protected-resource")) {
 *   return handleProtectedResource({
 *     resource: `https://${hostname}/mcp`,
 *     authorizationServers: [authServerUrl],
 *     scopesSupported: scopes,
 *   });
 * }
 * ```
 */
export function handleProtectedResource(
	config: ProtectedResourceConfig,
): Response {
	if (config.scopesSupported.length === 0) {
		// Never cacheable: an app with no OAuth config today may gain one later,
		// and this path predates the Workers Cache opt-in below, so be explicit.
		return new Response(JSON.stringify({ error: "not_found" }), {
			status: 404,
			headers: {
				"Content-Type": "application/json",
				"Cache-Control": "private, no-store",
			},
		});
	}

	const metadata = buildProtectedResourceMetadata(config);

	return new Response(JSON.stringify(metadata, null, 2), {
		headers: {
			"Content-Type": "application/json",
			// Public + identical for every caller of this app regardless of scope
			// (RFC 9728 discovery is unauthenticated); varies only by hostname/app,
			// which the Workers Cache key (entrypoint + URL) already captures.
			"Cache-Control": "public, max-age=3600",
			...(config.cacheTagAppId
				? { "Cache-Tag": `app:${config.cacheTagAppId}` }
				: {}),
		},
	});
}

/**
 * Check if a request path matches the OAuth Protected Resource metadata endpoint.
 * Handles both exact path and sub-path per RFC 9728 (e.g., `/.well-known/oauth-protected-resource/mcp`).
 */
export function isProtectedResourcePath(path: string): boolean {
	return (
		path === "/.well-known/oauth-protected-resource" ||
		path.startsWith("/.well-known/oauth-protected-resource/") ||
		path === "/.well-known/oauth-protected-metadata" ||
		path.startsWith("/.well-known/oauth-protected-metadata/")
	);
}
