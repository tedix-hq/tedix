/**
 * oRPC Tenant Membership Router
 *
 * Platform-admin, cross-org management of a user's Descope tenant memberships
 * and the corresponding D1 `organization_members` rows. Fills the gap left by
 * the org-injected `members.*` router (which can only touch the caller's own
 * org): a platform admin can remove a user from ANY tenant.
 *
 * All procedures are platform-admin only (`isPlatformPrincipal`) and skip
 * `requireOrganizationAccess` by design — this is a cross-org surface, like the
 * organization cancellation handler.
 */

import { implement } from "@orpc/server";
import { tenantMembershipContract } from "@tedix/api-contract/contracts/tenant-membership";
import type { TenantMembership } from "@tedix/api-contract/schemas/tenant-membership";
import { getManagementClient } from "@tedix/auth/client";
import { isPlatformPrincipal } from "@tedix/auth/types";
import {
	getMemberByUserId,
	removeMember,
} from "@tedix/db/queries/organization-members";
import { getOrganizationByDescopeId } from "@tedix/db/queries/organizations";
import { auditActor, emitAuditEvent } from "../audit-helpers";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withFleetAuthority,
} from "../orpc";

type DescopeUserLike = {
	userId: string;
	loginIds?: string[];
	userTenants?: { tenantId: string; roleNames?: string[] }[];
};

const tenantMembershipOs = implement(
	tenantMembershipContract,
).$context<BaseContext>();
const authedTenantMembershipOs = tenantMembershipOs
	.use(withAuth)
	.use(withFleetAuthority);

// =============================================================================
// HELPERS
// =============================================================================

function getDescopeManagement(env: CloudflareEnv) {
	if (!env.DESCOPE_MANAGEMENT_KEY) return null;
	return getManagementClient({
		DESCOPE_PROJECT_ID: env.DESCOPE_PROJECT_ID,
		DESCOPE_MANAGEMENT_KEY: env.DESCOPE_MANAGEMENT_KEY,
		DESCOPE_BASE_URL: env.DESCOPE_BASE_URL,
	});
}

function requireManagement(context: BaseContext) {
	const mgmt = getDescopeManagement(context.env);
	if (!mgmt) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Descope management API unavailable (DESCOPE_MANAGEMENT_KEY not configured)",
		);
	}
	return mgmt;
}

function requirePlatformAdmin(context: BaseContext): void {
	if (!isPlatformPrincipal(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Platform admin authority required for cross-org tenant membership management (user role 'platform-admin' or API key scope 'platform:admin')",
		);
	}
}

async function resolveUser(
	mgmt: ReturnType<typeof getManagementClient>,
	ref: { userId?: string; loginId?: string },
): Promise<DescopeUserLike> {
	if (!ref.userId && !ref.loginId) {
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Provide userId or loginId to identify the user",
		);
	}
	const resp = ref.loginId
		? await mgmt.management.user.load(ref.loginId)
		: await mgmt.management.user.loadByUserId(ref.userId as string);
	if (!resp.ok || !resp.data) {
		throw createError(
			ErrorCodes.NOT_FOUND,
			`Descope user not found for ${ref.loginId ?? ref.userId}`,
		);
	}
	return resp.data as unknown as DescopeUserLike;
}

// =============================================================================
// HANDLERS
// =============================================================================

export const listTenantMembershipContract = authedTenantMembershipOs.list
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		requirePlatformAdmin(context);
		const mgmt = requireManagement(context);
		const user = await resolveUser(mgmt, input);

		const memberships: TenantMembership[] = [];
		for (const t of user.userTenants ?? []) {
			const org = await getOrganizationByDescopeId(context.db, t.tenantId);
			const member = org
				? await getMemberByUserId(context.db, org.id, user.userId)
				: undefined;
			memberships.push({
				descopeTenantId: t.tenantId,
				roles: t.roleNames ?? [],
				organizationId: org?.id ?? null,
				organizationSlug: org?.slug ?? null,
				organizationName: org?.name ?? null,
				hasD1MemberRow: Boolean(member),
			});
		}

		return {
			userId: user.userId,
			loginId: user.loginIds?.[0] ?? null,
			memberships,
		};
	});

export const removeTenantMembershipContract = authedTenantMembershipOs.remove
	.use(AUTHZ.platformAdmin)
	.handler(async ({ input, context }) => {
		requirePlatformAdmin(context);
		const mgmt = requireManagement(context);

		const user = await resolveUser(mgmt, input);
		const loginId = user.loginIds?.[0];
		if (!loginId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				`Descope user ${user.userId} has no login ID`,
			);
		}

		// Descope tenant removal (source of truth for auth).
		const removal = await mgmt.management.user.removeTenant(
			loginId,
			input.descopeTenantId,
		);
		if (!removal.ok) {
			throw createError(
				ErrorCodes.INTERNAL_SERVER_ERROR,
				removal.error?.errorMessage ??
					`Failed to remove ${loginId} from tenant ${input.descopeTenantId}`,
			);
		}

		// D1 projection cleanup — delete the organization_members row, if any.
		let removedD1Row = false;
		const org = await getOrganizationByDescopeId(
			context.db,
			input.descopeTenantId,
		);
		if (org) {
			const member = await getMemberByUserId(context.db, org.id, user.userId);
			if (member) {
				await removeMember(context.db, member.id);
				removedD1Row = true;
			}
		}

		// Reload to report the accurate remaining membership count.
		const after = await resolveUser(mgmt, { userId: user.userId }).catch(
			() => user,
		);
		const remainingTenantCount = (after.userTenants ?? []).length;

		// Audit — scope to the caller's org (target user may have no org left).
		if (context.organizationId) {
			const actor = auditActor(context);
			await emitAuditEvent(context.db, {
				organizationId: context.organizationId,
				actorId: actor.actorId,
				actorType: actor.actorType,
				action: "tenant_membership.removed",
				resourceType: "descope_user",
				resourceId: user.userId,
				metadata: {
					...actor.actorMetadata,
					loginId,
					descopeTenantId: input.descopeTenantId,
					organizationId: org?.id ?? null,
					removedD1Row,
					...(input.reason ? { reason: input.reason } : {}),
				},
				ipAddress: context.headers.get("CF-Connecting-IP"),
				userAgent: context.headers.get("User-Agent"),
			});
		}

		return {
			userId: user.userId,
			loginId,
			descopeTenantId: input.descopeTenantId,
			removedFromDescope: true,
			removedD1Row,
			remainingTenantCount,
		};
	});

export const tenantMembershipContractRouter = tenantMembershipOs.router({
	list: listTenantMembershipContract,
	remove: removeTenantMembershipContract,
});
