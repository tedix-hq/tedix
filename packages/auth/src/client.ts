/**
 * @tedix/auth - Descope Management Client
 *
 * Management API wrapper for Descope.
 * Uses @descope/node-sdk for management operations (user/tenant/role CRUD).
 *
 * This file exists as a separate entry point from descope.ts to enforce the
 * management key requirement. descope.ts provides getDescopeClient() which
 * works without a management key (for validation-only use cases). This module's
 * getManagementClient() gates on DESCOPE_MANAGEMENT_KEY being present before
 * returning the same SDK client. Callers performing management operations must
 * supply that key; JWT validation does not require it.
 * For JWT validation, use validateToken from @tedix/auth/jwt.
 *
 * Docs: https://docs.descope.com/
 */

import { type DescopeClient, getDescopeClient } from "@tedix/auth/descope";
import type { DescopeEnv } from "@tedix/auth/types";

// =============================================================================
// RE-EXPORTS
// =============================================================================

export type DescopeManagementClient = DescopeClient;

/**
 * Get a Descope management client instance.
 * Requires DESCOPE_MANAGEMENT_KEY for management operations.
 *
 * @param env - Environment variables with Descope credentials
 * @returns Descope management client
 */
export function getManagementClient(env: DescopeEnv): DescopeManagementClient {
	if (!env.DESCOPE_MANAGEMENT_KEY) {
		throw new Error(
			"Missing DESCOPE_MANAGEMENT_KEY environment variable. Management key is required for management API operations.",
		);
	}
	return getDescopeClient(env);
}
