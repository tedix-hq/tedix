/**
 * Tedi ownership resolution for oRPC handlers.
 *
 * Six routers used to define their own `requireTediAccess`, and they disagreed
 * on who may reach a tedi outside the caller's organization (nobody, the human
 * `platform-admin` role only, any platform principal, the `system` service
 * binding, the operator MCP host app), on whether a tedi principal is pinned
 * to its own id, and on the status code for a caller without organization
 * scope (FORBIDDEN or UNAUTHORIZED, before or after the row is read). Each
 * difference is now a named `TediAccessPolicy` field declared next to the
 * router that owns it; the matrix tests beside each router pin its outcomes.
 *
 * This helper only answers "may this caller see this tedi". Mutation-specific
 * gates (capability fields, delete reach, budget writes) stay in the handlers.
 */

import { isPlatformAdmin, isPlatformPrincipal } from "@tedix/auth/types";
import { getTediById } from "@tedix/db/queries/tedis";
import { getTrustedMcpHostAppContext } from "./mcp-host-context";
import { requireOrgId } from "./org-scope";
import { type BaseContext, createError, ErrorCodes } from "./orpc";

export type TediAccessPolicy = {
	/**
	 * Who may reach a tedi that the caller's organization does not own.
	 * - `"none"`: nobody.
	 * - `"platform-admin-role"`: only a user JWT carrying the Descope
	 *   `platform-admin` role (`isPlatformAdmin`). Platform API keys, M2M
	 *   tokens and `platform:admin` tedis stay confined.
	 * - `"platform-principal"`: any principal with platform authority
	 *   (`isPlatformPrincipal`).
	 */
	platformAuthority: "none" | "platform-admin-role" | "platform-principal";
	/**
	 * A service-binding call forwarded by the trusted MCP host app with this
	 * slug counts as platform authority. Only readable on the Worker-to-Worker
	 * binding (`getTrustedMcpHostAppContext`).
	 */
	platformOperatorMcpAppSlug?: string;
} & (
	| {
			/**
			 * The caller must already carry an organization. It is resolved before
			 * the tedi is read, so a caller without one never learns whether the
			 * id exists. The tedi identity on the context is not consulted: a tedi
			 * reaches every tedi its organization owns.
			 */
			scope: "organization";
			/** Status code for a caller without organization scope. */
			missingOrganizationCode: "FORBIDDEN" | "UNAUTHORIZED";
			/**
			 * A service-binding call whose organization resolved to the literal
			 * `system` (the MCP edge resolving tedi identity before any tenant is
			 * known) bypasses the tenant check without platform authority.
			 */
			allowSystemServiceBinding?: boolean;
	  }
	| {
			/**
			 * The tedi is read first (a missing id is NOT_FOUND for every caller),
			 * then the caller is matched by tedi identity, organization or platform
			 * authority. A caller with none of the three is UNAUTHORIZED.
			 */
			scope: "principal";
			/**
			 * How `context.tediId` binds the caller:
			 * - `"exclusive"`: a tedi principal reaches exactly its own row and
			 *   nothing else, regardless of organization or platform authority.
			 * - `"self-or-platform"`: a tedi principal is refused any other tedi
			 *   unless it carries platform authority, and its organization must
			 *   still own the tedi.
			 */
			tediIdentity: "exclusive" | "self-or-platform";
	  }
);

function hasPlatformAuthority(
	context: BaseContext,
	policy: TediAccessPolicy,
): boolean {
	if (
		policy.platformOperatorMcpAppSlug !== undefined &&
		getTrustedMcpHostAppContext(context).appSlug ===
			policy.platformOperatorMcpAppSlug
	) {
		return true;
	}
	switch (policy.platformAuthority) {
		case "none":
			return false;
		case "platform-admin-role":
			return isPlatformAdmin(context.user);
		case "platform-principal":
			return isPlatformPrincipal(context);
	}
}

function requireCallerOrganization(
	context: BaseContext,
	missingOrganizationCode: "FORBIDDEN" | "UNAUTHORIZED",
): string {
	if (missingOrganizationCode === "FORBIDDEN") return requireOrgId(context);
	const orgId = context.organizationId;
	if (!orgId) {
		throw createError(ErrorCodes.UNAUTHORIZED, "Organization context required");
	}
	return orgId;
}

/**
 * Resolve a caller-supplied tedi id and prove the caller may see it under
 * `policy`. Returns the tedi row; throws NOT_FOUND, FORBIDDEN or UNAUTHORIZED.
 */
export async function requireTediAccess(
	context: BaseContext,
	tediId: string,
	policy: TediAccessPolicy,
) {
	const callerOrgId =
		policy.scope === "organization"
			? requireCallerOrganization(context, policy.missingOrganizationCode)
			: context.organizationId;

	const tedi = await getTediById(context.db, tediId);
	if (!tedi) {
		throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	}

	if (policy.scope === "organization") {
		if (tedi.organizationId === callerOrgId) return tedi;
		if (
			policy.allowSystemServiceBinding &&
			context.authType === "service-binding" &&
			callerOrgId === "system"
		) {
			return tedi;
		}
		if (hasPlatformAuthority(context, policy)) {
			console.log(
				`[Auth] Platform principal cross-org access: authType=${context.authType} accessing tedi=${tediId} (org=${tedi.organizationId}, caller-org=${callerOrgId})`,
			);
			return tedi;
		}
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
	}

	const platform = hasPlatformAuthority(context, policy);
	if (context.tediId) {
		const self = context.tediId === tedi.id;
		if (policy.tediIdentity === "exclusive") {
			if (self) return tedi;
			throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
		}
		if (!self && !platform) {
			throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
		}
	}
	if (callerOrgId) {
		if (tedi.organizationId !== callerOrgId && !platform) {
			throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
		}
		return tedi;
	}
	if (!context.tediId && !platform) {
		throw createError(ErrorCodes.UNAUTHORIZED, "Organization context required");
	}
	return tedi;
}
