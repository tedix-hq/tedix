/**
 * Organization-scope resolution for oRPC handlers.
 *
 * Every router used to define its own version of this guard — 31 copies across
 * 4 names (`requireOrganizationId`, `requireOrgId`,
 * `requireScopedOrganizationId`, plus inline `if (!context.organizationId)`
 * checks) — and they disagreed on the status code for the *same* condition:
 * 17 threw UNAUTHORIZED, 10 FORBIDDEN, 6 BAD_REQUEST. So whether a caller
 * without org scope got a 401, 403 or 400 depended only on which file handled
 * the request, and browser clients treat a 401 as a sign-in failure — meaning
 * 17 routers could bounce a user with a perfectly good session.
 *
 * Canonical answer is FORBIDDEN: `withAuth` has already run, so the caller IS
 * authenticated. They simply have no organization scope, which is an
 * authorization state rather than a credential problem.
 *
 * NOT the same thing, and deliberately not consolidated here:
 * `requireOrganization` in `routers/external-agent-identity.ts` also asserts a
 * *requested* org matches the resolved one ("Organization is out of scope").
 * That is a tenant-isolation check, not scope resolution — collapsing it into
 * these helpers would silently drop the cross-tenant assertion.
 */

import { isPlatformPrincipal } from "@tedix/auth/types";
import type { BaseContext } from "./orpc";
import { createError, ErrorCodes } from "./orpc";

/**
 * Resolve the caller's organization scope, or reject.
 *
 * Pass `detail` to name the resource in the message; the status code is always
 * FORBIDDEN so clients can branch on it uniformly.
 */
export function requireOrgId(context: BaseContext, detail?: string): string {
	const organizationId = context.organizationId;
	if (organizationId) return organizationId;
	throw createError(
		ErrorCodes.FORBIDDEN,
		detail
			? `Organization scope is required for ${detail}`
			: "Organization scope is required. Use an org-scoped credential.",
	);
}

/**
 * Same, but accepts an explicit organization id from the procedure input as a
 * fallback when the credential carries no scope of its own.
 *
 * The context always wins: a scoped credential cannot be widened by passing a
 * different organization in the request body.
 */
export function requireOrgIdOrInput(
	context: BaseContext,
	inputOrganizationId?: string,
	detail?: string,
): string {
	const organizationId = context.organizationId ?? inputOrganizationId;
	if (organizationId) return organizationId;
	throw createError(
		ErrorCodes.FORBIDDEN,
		detail
			? `Organization scope is required for ${detail}`
			: "Organization scope is required. Use an org-scoped credential.",
	);
}

/**
 * Bind a caller-supplied organization id to the authenticated organization.
 * Platform principals retain their explicit cross-organization authority.
 */
export function requireOrganizationAccess(
	context: BaseContext,
	requestedOrganizationId: string,
): string {
	if (isPlatformPrincipal(context)) return requestedOrganizationId;
	const organizationId = requireOrgId(context);
	if (organizationId !== requestedOrganizationId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Organization access denied for this resource",
		);
	}
	return organizationId;
}

/**
 * Bind a body tedi id to the authenticated tedi identity. Tedi JWTs use their
 * signed claim; trusted service-binding callers must forward the explicit tedi
 * header. A body id can never widen either identity.
 */
export function requireTediRequestIdentity(
	context: BaseContext,
	requestedTediId: string,
): string {
	const authenticatedTediId =
		context.authType === "tedi"
			? context.tediId
			: (context.headers.get("X-Tedix-Tedi-Id") ??
				context.headers.get("x-tedix-tedi-id"));
	if (!authenticatedTediId || authenticatedTediId !== requestedTediId) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Tedi identity does not match the requested resource",
		);
	}
	return authenticatedTediId;
}
