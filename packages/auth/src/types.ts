/**
 * @tedix/auth - Type Definitions
 *
 * Descope authentication types for Cloudflare Workers
 * Docs: https://docs.descope.com/
 */

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default Descope base URL (custom domain) for session/SDK/outbound paths */
export const DESCOPE_DEFAULT_BASE_URL = "https://auth.tedix.dev";

/**
 * Descope Management API base URL for AIH authorization-server paths
 * (`/v1/apps/agentic/*`, `/v1/mgmt/mcp/*`). These MUST target
 * `api.descope.com` — Descope custom domains do not proxy the agentic
 * authorization-server paths.
 */
export const DESCOPE_MANAGEMENT_BASE_URL = "https://api.descope.com";

// =============================================================================
// CONFIGURATION TYPES
// =============================================================================

/**
 * Descope client configuration
 */
export interface DescopeConfig {
	/** Descope project ID */
	projectId: string;
	/** Descope management key (optional, only for management API) */
	managementKey?: string;
	/** Descope base URL (defaults to https://auth.tedix.dev) */
	baseUrl?: string;
}

/**
 * Environment variables for Descope
 */
export interface DescopeEnv {
	DESCOPE_PROJECT_ID: string;
	DESCOPE_MANAGEMENT_KEY?: string;
	DESCOPE_BASE_URL?: string;
	DESCOPE_FGA_CACHE_URL?: string;
}

// =============================================================================
// JWT TYPES
// =============================================================================

/**
 * JWT payload from Descope tokens.
 *
 * Tedix's JWT Templates use the "Current Tenant, No Tenant Reference"
 * authorization schema: `roles`/`permissions` are flat arrays scoped to the
 * tenant identified by `dct`. Project-level assignments are not inferred from
 * this shape: a platform principal must arrive through an explicit emitted
 * role/permission or OAuth `platform:admin` scope. There is no nested
 * per-tenant claim, which keeps tokens bounded for users in many tenants.
 */
export interface JWTPayload {
	/** Subject (User ID) - Present in user tokens */
	sub?: string;
	/** User email (if included in token) */
	email?: string;
	/** User display name */
	name?: string;
	/** User profile picture URL */
	picture?: string;
	/**
	 * Roles emitted for the current tenant (`dct`). Platform roles appear here
	 * only when the selected JWT template or issuance policy explicitly emits
	 * them.
	 */
	roles?: string[];
	/** Permissions for the current tenant (`dct`). */
	permissions?: string[];
	/** Client ID - Present in M2M/access key tokens */
	client_id?: string;
	/** Issued at timestamp, when the issuer emitted one. Never synthesized. */
	iat?: number;
	/** Expiration timestamp */
	exp: number;
	/** Issuer (Descope issuer URL) */
	iss: string;
	/**
	 * Audience exactly as issued. Absent when the token carries none; never
	 * defaulted, so a missing claim cannot read as a project or resource audience.
	 */
	aud?: string | string[];
	/** Descope Current Tenant — active tenant selected at login */
	dct?: string;
	/**
	 * Step-up marker. Descope sets `su: true` on the session token it re-issues
	 * after a step-up flow completes; an ordinary refresh does not carry it. See
	 * `hasStepUpClaim`.
	 */
	su?: boolean;
	/** Additional claims */
	[key: string]: unknown;
}

/**
 * First-class tedi JWT claims added by the Descope access-key template.
 *
 * These claims are the stable Tedix contract for machine principals. In
 * particular, `descopeUserId` must come from the explicit template claim and
 * must not be inferred from `sub`, because access-key exchange flows may use
 * `sub` for the client/access-key subject instead.
 */
export interface TediJwtClaims {
	/** Tedix tedi UUID */
	tediId: string;
	/** Backing Descope user ID for FGA and audit correlation */
	descopeUserId: string;
	/** Principal class marker */
	entityType: "tedi";
}

/**
 * Extract all scopes from a JWT payload, deduplicated.
 * Supports space-delimited `scope`/`scp` and array `scopes` claims.
 */
export function extractJwtScopes(payload: JWTPayload): string[] {
	const scopes = new Set<string>();

	for (const claim of [payload.scope, payload.scp]) {
		if (typeof claim !== "string") continue;
		for (const scope of claim.split(/\s+/).filter(Boolean)) {
			scopes.add(scope);
		}
	}

	if (Array.isArray(payload.scopes)) {
		for (const scope of payload.scopes) {
			if (typeof scope === "string" && scope) scopes.add(scope);
		}
	}

	return [...scopes];
}

/**
 * Extract Tedix first-class tedi claims from a validated JWT payload.
 *
 * Returns `claims: null` when the token is not attempting to represent a tedi.
 * Returns `error` when the token looks like a tedi token but violates the
 * expected claim contract.
 */
export function extractTediJwtClaims(payload: JWTPayload): {
	claims: TediJwtClaims | null;
	error?: string;
} {
	const raw = payload as Record<string, unknown>;
	const tediId = typeof raw.tediId === "string" ? raw.tediId : undefined;
	const entityType = raw.entityType;
	// descopeUserId MUST come from the explicit JWT template claim.
	// Do NOT infer from `sub` — access key `sub` is the key client ID, not the user.
	const descopeUserId =
		typeof raw.descopeUserId === "string" ? raw.descopeUserId : undefined;
	const hasTediMarkers = Boolean(tediId) || entityType === "tedi";

	if (!hasTediMarkers) {
		return { claims: null };
	}

	if (entityType !== "tedi") {
		return {
			claims: null,
			error: 'Invalid tedi JWT — entityType must be "tedi"',
		};
	}

	if (!tediId) {
		return { claims: null, error: "Invalid tedi JWT — missing tediId claim" };
	}

	if (!descopeUserId) {
		return {
			claims: null,
			error: "Invalid tedi JWT — missing descopeUserId claim",
		};
	}

	return {
		claims: {
			tediId,
			descopeUserId,
			entityType: "tedi",
		},
	};
}

/**
 * JWT validation options
 */
export interface ValidateOptions {
	/** Descope project ID */
	projectId: string;
	/** Descope API base URL (defaults to https://auth.tedix.dev) */
	baseUrl?: string;
	/** Expected audience (defaults to project ID, which already has P prefix) */
	audience?: string;
	/** Additional allowed audiences */
	allowedAudiences?: string[];
	/**
	 * Allow tedi JWTs (entityType === "tedi") to pass validation.
	 * By default tedi JWTs are rejected on user auth paths.
	 * Set true for tedi-auth endpoints (withTediAuth middleware).
	 */
	allowTediJwt?: boolean;
	/**
	 * Report — but do not enforce — what audience checking WOULD do here.
	 *
	 * Audience is the only claim that can confine a token to one surface: every
	 * Tedix app shares one Descope project, so issuer and signature are
	 * identical across surfaces and prove nothing about where a token was meant
	 * to be used. Today only the MCP edge passes an audience at all, so a token
	 * minted for one surface is accepted by the rest.
	 *
	 * Turning enforcement on blind would reject live traffic, so this option
	 * exists to measure first: set it to the surface name, the audience that
	 * surface expects, and a `report` callback. Every validation then emits an
	 * observation saying whether the token would still have been accepted.
	 * Validation behaviour is unchanged while auditing.
	 */
	auditAudience?: {
		/** Stable name for the calling surface, e.g. "api:rpc" or "hub:session". */
		surface: string;
		/** Audience(s) this surface would require once enforcement is on. */
		expected: string[];
		/**
		 * Where to send the observation. Passed per call rather than registered
		 * globally: a module-level sink is an import-time side effect on shared
		 * state, so the last importer would silently win and a version skew in
		 * `@tedix/auth` would crash at module load instead of at the call.
		 */
		report: (event: AudienceAuditEvent) => void;
	};
}

/**
 * One observation of what audience enforcement would have done.
 *
 * `wouldReject` is the headline: if it is false across a full traffic window for
 * a surface, that surface can be flipped to enforcing. `passedOnlyViaProjectId`
 * is the subtler one — see the `primaryAudience` note in `validateToken`.
 */
export interface AudienceAuditEvent {
	surface: string;
	expected: string[];
	/** The token's own `aud` claim, normalized to an array. */
	actual: string[];
	/** True when no expected audience appears in the token's `aud`. */
	wouldReject: boolean;
	/**
	 * True when the token satisfied the CURRENT check only because the bare
	 * project ID is implicitly accepted, and would fail a strict check.
	 */
	passedOnlyViaProjectId: boolean;
	/** Present when the token carries no `aud` claim at all. */
	missingAudienceClaim: boolean;
}

// =============================================================================
// TENANT HELPERS
// =============================================================================

/**
 * Get the active tenant ID from the JWT payload (the `dct` claim).
 */
export function getTenantId(payload: JWTPayload): string | undefined {
	return payload.dct;
}

/**
 * Get roles for the active tenant from the JWT payload. Already flattened by
 * Descope to the `dct` tenant — no per-tenant lookup needed. Project-level
 * authority must be explicitly emitted by the selected token template or
 * issuance policy; it is never inferred here.
 */
export function getTenantRoles(payload: JWTPayload): string[] {
	return Array.isArray(payload.roles) ? payload.roles : [];
}

/**
 * Get permissions for the active tenant from the JWT payload. Already
 * flattened by Descope to the `dct` tenant.
 */
export function getTenantPermissions(payload: JWTPayload): string[] {
	return Array.isArray(payload.permissions) ? payload.permissions : [];
}

/**
 * Check if a tenant ID represents a personal workspace.
 * Personal tenants use the "personal_" prefix convention.
 */
export function isPersonalTenant(tenantId: string): boolean {
	return tenantId.startsWith("personal_");
}

/**
 * Check if the JWT payload belongs to a platform admin.
 *
 * `platform-admin` is a Descope **project-level** role assignment (not
 * tenant-scoped), so it appears in the flat `roles` claim regardless of which
 * tenant (`dct`) the token is currently scoped to. This is what lets a
 * platform admin act across every tenant without needing their session
 * pinned to the platform org.
 */
export function isPlatformAdmin(payload: JWTPayload | undefined): boolean {
	return (
		Array.isArray(payload?.roles) && payload.roles.includes("platform-admin")
	);
}

/**
 * Check if any principal type carries platform-admin authority.
 *
 * Unifies the cross-org admin check across User JWT, API key, M2M, and tedi
 * paths:
 * - User JWT: project-level `platform-admin` role or `platform:admin` / `*` scope
 * - API key: `platform:admin` scope (or wildcard `*`)
 * - M2M token: `platform:admin` scope (or wildcard `*`)
 * - Tedi: `platform:admin` capability scope (or wildcard `*`)
 *
 * Use this on cross-org endpoints (e.g. organization cancellation or provisioning)
 * instead of `isPlatformAdmin(context.user)` — the latter only works for User
 * JWTs and silently rejects API-key automation.
 *
 * **Why tedi authority is scope-based, not role-based:** a tedi's Descope
 * tenant roles are NOT projected into its access-key JWT (the token carries
 * `tediId`/`entityType`/`descopeUserId` and a role-less `tenants` claim), so
 * `isPlatformAdmin()` structurally cannot see a tedi's `platform-admin` role.
 * The platform's own source of truth for tedi authority is D1
 * `tedis.mcp_capability_profile`; the `platform_admin` profile grants
 * `platform:admin` (see `resolveTediScopes` in `@tedix/mcp-shared/auth/scopes`), which
 * the MCP edge resolves and forwards. `standard` tedis never receive
 * `platform:admin`, so they cannot reach this branch.
 *
 * **Naming gotcha:** the role string is `platform-admin` (hyphen, Descope
 * naming convention) but the API-key/M2M scope is `platform:admin` (colon,
 * OAuth scope convention) and the tedi capability scope is `platform:admin`. They
 * mean the same authority but live in different namespaces — always
 * copy-paste, never type from memory.
 */
export function isPlatformPrincipal(context: {
	user?: JWTPayload;
	apiKey?: { scopes?: string[] };
	serviceAccount?: { scope?: string };
	tediScopes?: string[];
	authType?: string;
}): boolean {
	if (isPlatformAdmin(context.user)) return true;
	const userScopes = context.user ? extractJwtScopes(context.user) : [];
	if (userScopes.includes("platform:admin") || userScopes.includes("*")) {
		return true;
	}
	const apiKeyScopes = context.apiKey?.scopes ?? [];
	if (apiKeyScopes.includes("platform:admin") || apiKeyScopes.includes("*")) {
		return true;
	}
	const m2mScopes = context.serviceAccount?.scope?.split(" ") ?? [];
	if (m2mScopes.includes("platform:admin") || m2mScopes.includes("*")) {
		return true;
	}
	const tediScopes = context.tediScopes ?? [];
	if (tediScopes.includes("platform:admin") || tediScopes.includes("*")) {
		return true;
	}
	return false;
}

/**
 * Resolve the tenant a request addresses, honoring an explicit per-request
 * override (e.g. the `X-Tedix-Tenant-Id` header) over the JWT's `dct`, and
 * flagging when the override targets a tenant OTHER than the token's own.
 *
 * Tedix tokens only carry the current tenant's (`dct`) roles/permissions — "a
 * token never carries another tenant's roles or permissions." So an override to
 * a different tenant CANNOT be authorized from the token: the caller's token
 * claims are for the wrong tenant. Whenever `isCrossTenantOverride` is true the
 * caller MUST (1) prove membership in the resolved org via a D1 lookup
 * (e.g. `getMemberByUserId`) before granting org context, and (2) authorize
 * strictly against that resolved-org membership role, never the token claims.
 * The override changes which org is *addressed*, never what the caller may do.
 */
export function resolveTenantOverride(
	payload: JWTPayload,
	requestedTenantId?: string | null,
): { tenantId: string | undefined; isCrossTenantOverride: boolean } {
	const ownTenantId = getTenantId(payload);
	const requested = requestedTenantId?.trim() || undefined;
	return {
		tenantId: requested ?? ownTenantId,
		isCrossTenantOverride: !!requested && requested !== ownTenantId,
	};
}

/**
 * Whether this token proves the user completed a Descope step-up flow.
 *
 * Descope's step-up mechanism re-issues the **session token** with `su: true`
 * once the step-up flow succeeds; an ordinary refresh issues a token without
 * it. The claim's lifetime is bounded by Descope itself via the project's
 * **Step Up Token Timeout** setting, so a token that still validates and
 * carries `su` is by construction a recent step-up — this helper deliberately
 * does not re-derive freshness from `iat`, which would only add a second,
 * drifting definition of "recent".
 *
 * Docs: https://docs.descope.com/mfa-and-step-up/step-up
 *
 * Only meaningful for interactive user JWTs. API keys, M2M tokens, service
 * bindings, and tedi access keys never run a step-up flow, so callers must
 * decide separately whether those principals are exempt rather than passing
 * their payloads here and expecting `false` to mean "denied".
 */
export function hasStepUpClaim(payload: JWTPayload | undefined): boolean {
	return payload?.su === true;
}
