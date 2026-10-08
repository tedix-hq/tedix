/**
 * Caller trust tier for the gateway → tedi runtime hop.
 *
 * apps/mcp computes the tier server-side from the authenticated caller and
 * the target tedi's organization, then stamps it on the service-binding
 * request. The runtime trusts service-binding callers for identity, so this
 * header is the only signal it has for "who is allowed to steer this turn"
 * (learning_mode, metadata). Both sides import this module so the contract
 * cannot drift.
 */

export const CALLER_TRUST_HEADER = "x-tedix-caller-trust";

export const CALLER_TRUST_TIERS = ["member", "tedi", "foreign"] as const;

export type CallerTrustTier = (typeof CALLER_TRUST_TIERS)[number];

/** Caller-supplied inject fields only a `member` may set. */
export const MEMBER_ONLY_INJECT_FIELDS = ["learning_mode", "metadata"] as const;

export interface CallerTrustInput {
	authType?: string;
	userId?: string;
	tediId?: string;
	organizationId?: string;
	scopes?: readonly string[];
	kernel?: boolean;
	/** Server-verified multi-org grants (never parsed from client headers). */
	verifiedMultiOrgOrganizations?: ReadonlyArray<{ organizationId: string }>;
}

export function isPlatformTrustedCaller(
	caller: Pick<CallerTrustInput, "scopes"> | undefined,
): boolean {
	const scopes = caller?.scopes ?? [];
	return scopes.includes("platform:admin") || scopes.includes("*");
}

/**
 * Whether the caller is verified to belong to `targetOrganizationId`: its own
 * organization matches, or the organization is in its verified multi-org grant.
 * An unknown target or unknown caller organization is never a match.
 */
export function callerBelongsToOrganization(
	caller: CallerTrustInput | undefined,
	targetOrganizationId: string | undefined,
): boolean {
	if (!caller || !targetOrganizationId) return false;
	if (caller.organizationId === targetOrganizationId) return true;
	return Boolean(
		caller.verifiedMultiOrgOrganizations?.some(
			(org) => org.organizationId === targetOrganizationId,
		),
	);
}

/**
 * - `member`: a same-org human (user/oauth/external_agent session), org
 *   credential (apiKey/m2m), the kernel acting for a human, or a platform
 *   operator addressing any organization.
 * - `tedi`: a same-org tedi credential (tedi JWT, or the service hop that
 *   carries a tedi identity and no human).
 * - `foreign`: everything else — anonymous, cross-org, or an unknown target
 *   organization.
 */
export function resolveCallerTrustTier(
	caller: CallerTrustInput | undefined,
	targetOrganizationId: string | undefined,
): CallerTrustTier {
	if (!caller || !caller.authType || caller.authType === "anonymous") {
		return "foreign";
	}
	if (isPlatformTrustedCaller(caller)) return "member";
	if (!callerBelongsToOrganization(caller, targetOrganizationId)) {
		return "foreign";
	}
	const hasTedi = typeof caller.tediId === "string" && caller.tediId.length > 0;
	switch (caller.authType) {
		case "tedi":
			return "tedi";
		case "service":
			if (caller.kernel === true) return "member";
			return hasTedi && !caller.userId ? "tedi" : "member";
		case "user":
		case "oauth":
		case "external_agent":
		case "apiKey":
		case "m2m":
			return hasTedi && !caller.userId ? "tedi" : "member";
		default:
			return "foreign";
	}
}

export function parseCallerTrustTier(
	value: string | null | undefined,
): CallerTrustTier | null {
	return (CALLER_TRUST_TIERS as readonly string[]).includes(value ?? "")
		? (value as CallerTrustTier)
		: null;
}

/** Drop member-only inject fields from a forwarded params object. */
export function stripMemberOnlyInjectFields<T extends Record<string, unknown>>(
	params: T,
	tier: CallerTrustTier,
): T {
	if (tier === "member") return params;
	const next = { ...params };
	for (const field of MEMBER_ONLY_INJECT_FIELDS) delete next[field];
	return next;
}
