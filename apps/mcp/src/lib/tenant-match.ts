/**
 * Tenant-match enforcement for MCP edge.
 *
 * Bug we're closing: an OAuth JWT issued via Descope AIH carries `aud` matching
 * the MCP server URL but `dct` (Descope Current Tenant) reflecting whatever
 * tenant the user's session was active in at consent time. Descope honors the
 * existing `dct` cookie and skips the tenant picker — so a user logged into
 * `org_tedix` who connects to `acme-unified.mcp.tedix.dev` lands with a JWT
 * scoped to org_tedix, not org_acme.
 *
 * Audience check alone won't catch a present-but-wrong active tenant. We must
 * verify either that `dct` maps to the app's owning organization or, for an
 * AIH user access token without `dct`, that its signed tenant-membership map
 * contains that organization. The latter is safe only after the caller's
 * exact Resource-audience check, which always precedes this gate.
 *
 * Per docs/platform/auth.md and Descope's own MCP Gateway pattern (one MCP server per
 * tenant), the resource server is the canonical enforcement point.
 */
import { createDbClient } from "@tedix/db/client";
import { getOrganizationDescopeTenantId } from "@tedix/db/queries/organizations";
import { getApiClient } from "./api-client";
import { setBoundedCacheEntry } from "./bounded-cache";

interface D1PreparedStatementLike {
	bind(...values: unknown[]): D1PreparedStatementLike;
	first<T = unknown>(): Promise<T | null>;
}

interface D1DatabaseLike {
	prepare(query: string): D1PreparedStatementLike;
}

// Loose env type — caller passes the worker `env` directly. The api-client
// itself validates the service binding shape at runtime.
interface ApiClientFactoryEnv {
	API_SERVICE?: Fetcher;
	DB?: D1DatabaseLike;
}

interface CachedOrgTenant {
	descopeTenantId: string | null;
	expiresAt: number;
}

/**
 * Outcome of an org-tenant lookup. `resolved: false` means the lookup itself
 * failed (D1 error + API fallback error) — not that the org has no tenant.
 * Failed lookups must never enter the cache: a single transient D1/service
 * hiccup would otherwise poison this isolate for the full TTL and hard-reject
 * every OAuth request to the app with a false "has no Descope tenant id".
 */
type OrgTenantLookup =
	| { resolved: true; descopeTenantId: string | null }
	| { resolved: false };

const ORG_TENANT_TTL_MS = 5 * 60_000; // 5 minutes — orgs rarely change tenant id
const MAX_ORG_TENANT_CACHE_ENTRIES = 500;
const orgTenantCache = new Map<string, CachedOrgTenant>();
const orgTenantInFlight = new Map<string, Promise<OrgTenantLookup>>();

function normalizeDescopeTenantId(
	org:
		| {
				descopeTenantId?: string | null;
				descope_tenant_id?: string | null;
		  }
		| null
		| undefined,
): string | null {
	return org?.descopeTenantId ?? org?.descope_tenant_id ?? null;
}

async function getOrgDescopeTenantIdFromD1(
	orgId: string,
	env: ApiClientFactoryEnv,
): Promise<string | null | undefined> {
	if (!env.DB) return undefined;

	try {
		return await getOrganizationDescopeTenantId(
			createDbClient(env.DB as D1Database),
			orgId,
		);
	} catch (error) {
		console.warn(
			`[MCP TenantMatch] failed to load org ${orgId} from D1:`,
			error instanceof Error ? error.message : error,
		);
		return undefined;
	}
}

/**
 * Look up an org's `descopeTenantId` by D1 org id. Successful lookups (with or
 * without a tenant id) are cached per-isolate; failed lookups are not cached so
 * the next request retries instead of inheriting a poisoned verdict.
 */
async function getOrgDescopeTenantId(
	orgId: string,
	env: ApiClientFactoryEnv,
): Promise<OrgTenantLookup> {
	const cached = orgTenantCache.get(orgId);
	if (cached && Date.now() < cached.expiresAt) {
		return { resolved: true, descopeTenantId: cached.descopeTenantId };
	}
	const inFlight = orgTenantInFlight.get(orgId);
	if (inFlight) return inFlight;

	const work = (async (): Promise<OrgTenantLookup> => {
		const d1TenantId = await getOrgDescopeTenantIdFromD1(orgId, env);
		if (d1TenantId !== undefined) {
			return { resolved: true, descopeTenantId: d1TenantId };
		}

		try {
			const client = getApiClient({
				serviceFetch: env.API_SERVICE,
			});
			const org = await client.organizations.get({ organizationId: orgId });
			return { resolved: true, descopeTenantId: normalizeDescopeTenantId(org) };
		} catch (error) {
			console.warn(
				`[MCP TenantMatch] failed to load org ${orgId}:`,
				error instanceof Error ? error.message : error,
			);
			return { resolved: false };
		}
	})();
	orgTenantInFlight.set(orgId, work);
	try {
		const lookup = await work;
		if (lookup.resolved) {
			setBoundedCacheEntry(
				orgTenantCache,
				orgId,
				{
					descopeTenantId: lookup.descopeTenantId,
					expiresAt: Date.now() + ORG_TENANT_TTL_MS,
				},
				MAX_ORG_TENANT_CACHE_ENTRIES,
			);
		}
		return lookup;
	} finally {
		orgTenantInFlight.delete(orgId);
	}
}

/**
 * Extract the JWT's tenant id from the `dct` (Descope Current Tenant) claim.
 * Returns null when it is not set. Descope AIH user access tokens may instead
 * carry the caller's signed `tenants` membership map while the exact MCP
 * Resource is enforced through `aud`; that case is handled below.
 */
export function extractJwtTenantId(
	payload: Record<string, unknown> | undefined | null,
): string | null {
	const dct = payload?.dct;
	return typeof dct === "string" && dct.length > 0 ? dct : null;
}

function hasAihTenantMembership(
	payload: Record<string, unknown> | undefined | null,
	tenantId: string,
): boolean {
	if (payload?.token_type !== "access_token") return false;
	if (typeof payload.azp !== "string" || payload.azp.length === 0) return false;
	const tenants = payload.tenants;
	return (
		typeof tenants === "object" &&
		tenants !== null &&
		!Array.isArray(tenants) &&
		Object.hasOwn(tenants, tenantId)
	);
}

/**
 * Returns true when the JWT's active tenant maps to the app's owning org.
 *
 * - present `dct` → it must match; a membership entry never overrides it
 * - AIH user access token without `dct` → accept only when the signed
 *   `tenants` map contains the app's tenant. The caller has already enforced
 *   the exact MCP Resource audience before reaching this function.
 * - every other token without `dct` → reject
 * - org lookup failure → reject (tenant-specific OAuth must fail closed)
 * - mismatch → reject
 */
export async function jwtTenantMatchesApp(
	payload: Record<string, unknown> | undefined | null,
	appOrgId: string,
	env: ApiClientFactoryEnv,
): Promise<{ ok: true } | { ok: false; reason: string }> {
	const jwtTenant = extractJwtTenantId(payload);
	if (
		!jwtTenant &&
		(payload?.token_type !== "access_token" || typeof payload.azp !== "string")
	) {
		return {
			ok: false,
			reason: "JWT has no tenant context",
		};
	}
	const lookup = await getOrgDescopeTenantId(appOrgId, env);
	if (!lookup.resolved) {
		// Fail closed on this request, but with a reason that says the lookup
		// failed — not the false claim that the org has no tenant.
		console.warn(
			`[MCP TenantMatch] tenant lookup failed for org ${appOrgId} — rejecting OAuth request (transient; not cached)`,
		);
		return {
			ok: false,
			reason: `Tenant lookup for app organization "${appOrgId}" failed; retry shortly`,
		};
	}
	const expectedTenant = lookup.descopeTenantId;
	if (!expectedTenant) {
		console.warn(
			`[MCP TenantMatch] no descopeTenantId on org ${appOrgId} — rejecting OAuth request`,
		);
		return {
			ok: false,
			reason: `App organization "${appOrgId}" has no Descope tenant id`,
		};
	}
	if (!jwtTenant && hasAihTenantMembership(payload, expectedTenant)) {
		return { ok: true };
	}
	if (!jwtTenant) {
		return {
			ok: false,
			reason: `JWT has no active tenant and is not a member of app tenant "${expectedTenant}"`,
		};
	}
	if (jwtTenant !== expectedTenant) {
		return {
			ok: false,
			reason: `JWT tenant "${jwtTenant}" does not match app's tenant "${expectedTenant}"`,
		};
	}
	return { ok: true };
}
