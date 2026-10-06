import { loadUserTenantEditorialIdentity } from "@tedix/auth/descope";
import { isUserToken } from "@tedix/auth/jwt";
import type { JWTPayload } from "@tedix/auth/types";
import type { DescopeEnv } from "@tedix/auth/types";
import { getCmsHumanSiteAuthority } from "./storage";

/** Identity resolved from current control-plane state, never from the token's dct. */
export interface CmsHumanIdentity {
	siteId: string;
	slug: string;
	bundleEtag: string;
	tenantId: string;
	subject: string;
	email: string;
	name: string;
	role: 10 | 40 | 50;
}

export function cmsAuditActor(
	user: JWTPayload | undefined,
	humanIdentity: CmsHumanIdentity | null,
): { actorId: string; actorType: "user" | "service" | "tedi" | "m2m" } {
	if (humanIdentity)
		return { actorId: humanIdentity.subject, actorType: "user" };
	return {
		actorId: user?.sub ?? "cms-platform-service",
		actorType:
			user?.entityType === "tedi"
				? "tedi"
				: user?.client_id && !user.email
					? "m2m"
					: user
						? "user"
						: "service",
	};
}

/** Match the shared Descope machine/user classifier before management lookup. */
export function isCmsHumanOAuthSubject(
	payload: JWTPayload | undefined,
): payload is JWTPayload {
	return Boolean(payload && isUserToken(payload));
}

/** An unverified forwarded bearer cannot silently become site service auth. */
export function requiresCmsHumanAuth(
	forwardedAuth: string | undefined,
	user: JWTPayload | undefined,
): boolean {
	return forwardedAuth !== undefined && (!user || isCmsHumanOAuthSubject(user));
}

export function mapCmsEditorialRole(
	roles: readonly string[],
): 10 | 40 | 50 | null {
	const names = new Set(roles);
	if (
		["platform-admin", "owner", "admin", "Org Admin"].some((role) =>
			names.has(role),
		)
	)
		return 50;
	if (
		["editor", "Content Manager", "member", "Member"].some((role) =>
			names.has(role),
		)
	)
		return 40;
	if (names.has("viewer")) return 10;
	return null;
}

/**
 * Why a human OAuth caller did not resolve to a CMS editorial identity. Every
 * variant is derived from the same reads `resolveCmsHumanAuthorization`
 * performs; none carries a token or secret, so it is safe to show the caller.
 */
export type CmsHumanAuthDenial =
	| { reason: "unverified_bearer" }
	| { reason: "not_human_subject" }
	| { reason: "site_unavailable"; slug: string }
	| { reason: "marker_missing"; slug: string; activeBundleEtag: string }
	| {
			reason: "marker_stale";
			slug: string;
			markerEtag: string;
			activeBundleEtag: string;
	  }
	| { reason: "no_editorial_role"; slug: string; tenantId: string };

/** A machine caller has neither an identity nor a denial: it uses the service path. */
export type CmsHumanAuthResolution =
	| { identity: CmsHumanIdentity; denial: null }
	| { identity: null; denial: CmsHumanAuthDenial | null };

const HUMAN_AUTH_ACTIVATION_HINT =
	"run get_human_auth_activation, review the result, then set_human_auth_activation";

/** One caller-facing sentence per denial; secrets never enter these strings. */
export function describeCmsHumanAuthDenial(denial: CmsHumanAuthDenial): string {
	switch (denial.reason) {
		case "unverified_bearer":
			return "The forwarded bearer could not be verified as a Descope JWT for this project (expired, malformed, or issued elsewhere); sign in again and retry.";
		case "not_human_subject":
			return "The forwarded token is not a human OAuth subject, so the human CMS auth path does not apply.";
		case "site_unavailable":
			return `CMS site "${denial.slug}" is not active or has no single active bundle, so human CMS auth cannot be resolved.`;
		case "marker_missing":
			return `Human CMS auth is not activated for site "${denial.slug}": no human-auth marker is set for the active bundle (etag ${denial.activeBundleEtag}); ${HUMAN_AUTH_ACTIVATION_HINT}.`;
		case "marker_stale":
			return `Human CMS auth marker for site "${denial.slug}" is stale: the marker points at bundle etag ${denial.markerEtag} but the active bundle is etag ${denial.activeBundleEtag} (a theme deploy or rollback replaced the bundle); ${HUMAN_AUTH_ACTIVATION_HINT}.`;
		case "no_editorial_role":
			return `The signed-in user holds no editorial role in tenant ${denial.tenantId} (site "${denial.slug}"); an owner, admin, editor, member, or viewer role is required.`;
	}
}

/**
 * The marker is platform D1 configuration, tied to one immutable active bundle.
 * Resolves the identity or the exact reason it was denied, from the same reads.
 */
export async function resolveCmsHumanAuthorization(args: {
	db: D1Database;
	descope: DescopeEnv;
	slug: string;
	user: JWTPayload;
}): Promise<CmsHumanAuthResolution> {
	const { db: binding, descope, slug, user } = args;
	const subject =
		typeof user.descopeUserId === "string" ? user.descopeUserId : user.sub;
	if (!subject || !isCmsHumanOAuthSubject(user))
		return { identity: null, denial: { reason: "not_human_subject" } };
	const authority = await getCmsHumanSiteAuthority(binding, slug);
	if (!authority)
		return { identity: null, denial: { reason: "site_unavailable", slug } };
	if (authority.humanAssertionBundleEtag === null)
		return {
			identity: null,
			denial: {
				reason: "marker_missing",
				slug,
				activeBundleEtag: authority.activeBundleEtag,
			},
		};
	if (authority.humanAssertionBundleEtag !== authority.activeBundleEtag)
		return {
			identity: null,
			denial: {
				reason: "marker_stale",
				slug,
				markerEtag: authority.humanAssertionBundleEtag,
				activeBundleEtag: authority.activeBundleEtag,
			},
		};
	const tenantId = authority.tenantId;
	const editorial = await loadUserTenantEditorialIdentity(
		descope,
		subject,
		tenantId,
	);
	const role = editorial ? mapCmsEditorialRole(editorial.roles) : null;
	if (!editorial || role === null)
		return {
			identity: null,
			denial: { reason: "no_editorial_role", slug, tenantId },
		};
	return {
		identity: {
			siteId: authority.siteId,
			slug,
			bundleEtag: authority.activeBundleEtag,
			tenantId,
			subject,
			email: editorial.email,
			name: editorial.name,
			role,
		},
		denial: null,
	};
}

export function encodeCmsHumanIdentity(identity: CmsHumanIdentity): string {
	const bytes = new TextEncoder().encode(JSON.stringify(identity));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
