/**
 * API Client for apps/mcp
 *
 * Type-safe oRPC client for calling apps/api endpoints.
 * Uses @tedix/api-client adapters for authentication.
 */

import { gatewayReadBinding } from "./gateway-read-cache";
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
export function getApiClient(options: {
	serviceFetch: Fetcher;
	headers?: Record<string, string>;
	orgId?: string;
	externalAgent?: {
		principalId: string;
		sessionId: string;
		clientRecordId: string;
	};
}): ApiClient {
	return getInternalApiClient(
		{ API_SERVICE: gatewayReadBinding(options.serviceFetch) },
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
 * This projection is intentionally cross-org. API_SERVICE must bind to the
 * API's McpEntrypoint; the `system` header selects bootstrap scope but grants
 * no authority by itself.
 */
export function getTediProfileApiClient(serviceFetch: Fetcher): ApiClient {
	return getApiClient({
		serviceFetch,
		orgId: "system",
	});
}
