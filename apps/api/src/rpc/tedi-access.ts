/**
 * Tedi ownership resolution for oRPC handlers.
 *
 * Router policies select platform authority and tedi identity boundaries.
 * Missing organization scope is FORBIDDEN; principal policies check caller
 * scope before reading and conceal absent or inaccessible tenant rows.
 *
 * This helper only answers "may this caller see this tedi". Mutation-specific
 * gates (capability fields, delete reach, budget writes) stay in the handlers.
 */

import { isPlatformAdmin, isPlatformPrincipal } from "@tedix/auth/types";
import {
	getTediById,
	getTediByIdForOrganization,
} from "@tedix/db/queries/tedis";
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
			missingOrganizationCode: "FORBIDDEN";
			/**
			 * The configured MCP service principal may resolve identity through
			 * tedis.get before a tenant is known. No other procedure inherits it.
			 */
			allowMcpIdentityResolve?: boolean;
	  }
	| {
			/**
			 * Caller scope is checked before reading. Tenant reads conceal absent
			 * and foreign ids behind the same FORBIDDEN denial.
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
	// Only the configured MCP gateway may forward cross-org principal claims.
	if (
		context.authType === "service-binding" &&
		context.serviceBindingPrincipal !== "mcp-edge"
	)
		return false;
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

/**
 * Resolve a caller-supplied tedi id and prove the caller may see it under
 * `policy`. Returns the tedi row; throws NOT_FOUND or FORBIDDEN.
 */
export async function requireTediAccess(
	context: BaseContext,
	tediId: string,
	policy: TediAccessPolicy,
) {
	const identityResolve =
		policy.scope === "organization" &&
		policy.allowMcpIdentityResolve === true &&
		context.authType === "service-binding" &&
		context.serviceBindingPrincipal === "mcp-edge" &&
		context.organizationId === "system" &&
		!context.tediId &&
		!context.externalAgentPrincipalId &&
		!context.serviceBindingAuthorization &&
		context.url?.pathname === "/rpc/tedis/get";
	const callerOrgId =
		policy.scope === "organization" && !identityResolve
			? requireOrgId(context)
			: context.organizationId;
	const platform = hasPlatformAuthority(context, policy);
	if (callerOrgId === "system" && !identityResolve && !platform) {
		throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
	}

	if (policy.scope === "principal") {
		const self = context.tediId === tediId;
		if (
			context.tediId &&
			!self &&
			(policy.tediIdentity === "exclusive" || !platform)
		) {
			throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
		}
		if (!callerOrgId && !context.tediId && !platform) {
			throw createError(ErrorCodes.FORBIDDEN, "Organization context required");
		}
		// Self-only harness authority is independent of org scope. Every other
		// tenant read includes ownership in the query, hiding absent/foreign ids.
		const exclusiveSelf = policy.tediIdentity === "exclusive" && self;
		const tedi =
			callerOrgId && !platform && !exclusiveSelf
				? await getTediByIdForOrganization(context.db, tediId, callerOrgId)
				: await getTediById(context.db, tediId);
		if (!tedi) {
			throw createError(
				platform && !exclusiveSelf
					? ErrorCodes.NOT_FOUND
					: ErrorCodes.FORBIDDEN,
				"Access denied to this tedi",
			);
		}
		return tedi;
	}

	const tedi = await getTediById(context.db, tediId);
	if (!tedi) throw createError(ErrorCodes.NOT_FOUND, "Tedi not found");
	if (tedi.organizationId === callerOrgId || identityResolve || platform)
		return tedi;
	throw createError(ErrorCodes.FORBIDDEN, "Access denied to this tedi");
}
