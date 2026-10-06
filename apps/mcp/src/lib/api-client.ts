/**
 * API Client for apps/mcp
 *
 * Type-safe oRPC client for calling apps/api endpoints.
 * Uses @tedix/api-client adapters for authentication.
 */

import {
	getInternalApiClient,
	type InternalApiClient,
} from "@tedix/api-client/internal";

/**
 * Control-plane reads the MCP edge needs before it can authenticate and build
 * an app server. This is deliberately a finite service role: tool executions
 * carry their separately verified principal + tool attestation.
 */
export const MCP_EDGE_CONTROL_PLANE_SCOPES = [
	"apps:read",
	"tedis:read",
] as const;

// =============================================================================
// TYPES
// =============================================================================

/** Typed API client for all oRPC procedures */
export type ApiClient = InternalApiClient;

// =============================================================================
// CLIENT FACTORY
// =============================================================================

/**
 * Create a scoped typed API client over the required service binding
 *
 * @param options - Service binding and optional caller identity headers
 * @returns Typed client for all oRPC procedures
 */
export function getApiClient(options?: {
	serviceFetch?: Fetcher;
	headers?: Record<string, string>;
	orgId?: string;
	externalAgent?: {
		principalId: string;
		sessionId: string;
		clientRecordId: string;
	};
}): ApiClient {
	if (!options?.serviceFetch) {
		throw new Error(
			"Service binding (serviceFetch) is required. MCP Worker must use Cloudflare Service Bindings to communicate with the API.",
		);
	}
	return getInternalApiClient(
		{ API_SERVICE: options.serviceFetch },
		{
			headers: options.headers,
			organizationId: options.orgId,
			externalAgent: options.externalAgent,
			scopes: MCP_EDGE_CONTROL_PLANE_SCOPES,
		},
	);
}

/**
 * Read a tedi's identity/capability projection by globally unique id.
 *
 * The API's service-binding auth requires an explicit organization header.
 * This projection is intentionally cross-org, so it uses the API's reviewed
 * `system` scope rather than inheriting a tenant from the incoming MCP request.
 */
export function getTediProfileApiClient(serviceFetch: Fetcher): ApiClient {
	return getApiClient({
		serviceFetch,
		orgId: "system",
	});
}
