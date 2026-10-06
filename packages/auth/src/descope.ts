/**
 * @tedix/auth - Descope SDK Wrapper
 *
 * Provides Descope management client access and session validation.
 * Works on all Cloudflare Workers with nodejs_compat (wrangler bundles
 * the browser ponyfill from cross-fetch, producing a ~131KB output).
 *
 * Docs: https://docs.descope.com/
 */

import DescopeSdk from "@descope/node-sdk";
import type { DescopeEnv } from "@tedix/auth/types";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Descope management client type
 * Re-export so consumers can type-reference without importing the SDK directly
 */
export type DescopeClient = ReturnType<typeof DescopeSdk>;

// =============================================================================
// CLIENT SINGLETON
// =============================================================================

/**
 * FNV-1a 32-bit hash of a string. Used to include the management key in the
 * cache discriminator without storing the raw key in the cache key string.
 */
function simpleHash(s: string): number {
	let h = 2_166_136_261 >>> 0; // FNV-1a offset basis
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 16_777_619) >>> 0;
	}
	return h;
}

let cachedClient: DescopeClient | null = null;
let cachedKey: string | null = null;

/**
 * Get or create singleton Descope management client.
 *
 * The management client requires a management key and is used for
 * user/tenant management operations. For JWT validation, use
 * validateToken from @tedix/auth/jwt (which uses the SDK internally
 * without needing a management key).
 *
 * @param env - Environment variables with Descope credentials
 * @returns Cached or new Descope client instance
 * @throws Error if required environment variables are missing
 */
export function getDescopeClient(env: DescopeEnv): DescopeClient {
	const key = `${env.DESCOPE_BASE_URL || "default"}:${env.DESCOPE_PROJECT_ID}:${simpleHash(env.DESCOPE_MANAGEMENT_KEY ?? "")}`;
	if (cachedClient && cachedKey === key) {
		return cachedClient;
	}

	cachedClient = createDescopeClient(env);
	cachedKey = key;

	return cachedClient;
}

/**
 * Create a new Descope SDK client instance
 */
export function createDescopeClient(env: DescopeEnv): DescopeClient {
	if (!env.DESCOPE_PROJECT_ID) {
		throw new Error("Missing DESCOPE_PROJECT_ID environment variable");
	}

	return DescopeSdk({
		projectId: env.DESCOPE_PROJECT_ID,
		managementKey: env.DESCOPE_MANAGEMENT_KEY,
		baseUrl: env.DESCOPE_BASE_URL,
		fgaCacheUrl: env.DESCOPE_FGA_CACHE_URL,
	});
}

// =============================================================================
// TENANT MEMBERSHIP
// =============================================================================

/**
 * Check whether a Descope user is a member of a given tenant.
 *
 * Uses the management SDK (`user.loadByUserId`) instead of a hand-rolled
 * `GET /v1/mgmt/user` fetch, which gives descopeFetch-grade resilience
 * (timeout + retry) and removes manual auth-header construction.
 *
 * Tri-state so callers can distinguish a definite answer from an
 * indeterminate one (e.g. for caching decisions):
 * - `true`  — the user definitely belongs to the tenant
 * - `false` — the user definitely does NOT belong to the tenant
 * - `null`  — membership could not be determined (missing management key,
 *   failed API response, or thrown error); callers should fail closed and
 *   must not cache this outcome.
 *
 * @param env - Environment with Descope credentials
 * @param userId - Descope user ID
 * @param tenantId - Descope tenant ID (e.g. `org_<slug>`)
 */
export async function checkUserTenantMembership(
	env: DescopeEnv,
	userId: string,
	tenantId: string,
): Promise<boolean | null> {
	if (!userId || !tenantId) return null;
	if (!env.DESCOPE_MANAGEMENT_KEY) return null;
	try {
		const resp =
			await getDescopeClient(env).management.user.loadByUserId(userId);
		if (!resp.ok || !resp.data) return null;
		return (resp.data.userTenants ?? []).some(
			(tenant) => tenant.tenantId === tenantId,
		);
	} catch {
		return null;
	}
}

/** Resolve the current roles of one human user in one exact Descope tenant.
 * A failed management read is indeterminate, so callers must fail closed.
 */
export async function loadUserTenantEditorialIdentity(
	env: DescopeEnv,
	userId: string,
	tenantId: string,
): Promise<{ roles: string[]; email: string; name: string } | null> {
	if (!userId || !tenantId || !env.DESCOPE_MANAGEMENT_KEY) return null;
	try {
		const result =
			await getDescopeClient(env).management.user.loadByUserId(userId);
		if (!result.ok || !result.data) return null;
		if (result.data.status !== "enabled" || result.data.verifiedEmail !== true)
			return null;
		const entityType = result.data.customAttributes?.entityType;
		if (entityType && entityType !== "user") return null;
		if (result.data.loginIds?.some((loginId) => loginId.startsWith("tedi:")))
			return null;
		const matches = (result.data.userTenants ?? []).filter(
			(tenant) => tenant.tenantId === tenantId,
		);
		if (matches.length !== 1) return null;
		const roles = matches[0]?.roleNames;
		if (
			!Array.isArray(roles) ||
			!roles.every((role) => typeof role === "string")
		)
			return null;
		const email = result.data.email?.trim().toLowerCase();
		if (!email) return null;
		return { roles, email, name: result.data.name?.trim() || email };
	} catch {
		return null;
	}
}
