import "@orpc/openapi/extensions/route";
/**
 * Tenant Membership Contract for oRPC
 *
 * Platform-admin, cross-org management of Descope tenant memberships (+ their
 * D1 `organization_members` projection). Unlike the org-injected `members.*`
 * router, these act on any tenant regardless of the caller's org, so a platform
 * admin can inspect or remove a user's membership in an arbitrary tenant.
 *
 * Proc names derive the intended tool ids: `list` → `list_tenant_membership`,
 * `remove` → `remove_tenant_membership`.
 */

import { oc } from "@orpc/contract";
import { baseErrors } from "../errors";
import {
	ListTenantMembershipsResponseSchema,
	RemoveTenantMembershipInputSchema,
	RemoveTenantMembershipResponseSchema,
	TenantMembershipUserRefSchema,
} from "../schemas/tenant-membership";

export const tenantMembershipContract = oc
	.route({ tags: ["tenant-membership"], prefix: "/tenant-membership" })
	.errors(baseErrors)
	.router({
		/**
		 * List a user's Descope tenant memberships, enriched with the Tedix org
		 * and whether a D1 member row exists. Platform-admin only.
		 * GET /tenant-membership
		 */
		list: oc
			.route({
				method: "GET",
				path: "" as `/${string}`,
				summary: "List a user's tenant memberships",
				description:
					"List all Descope tenant memberships for a user (by userId or loginId), each enriched with the mapped Tedix org and whether a D1 organization_members row exists. Platform-admin only.",
			})
			.input(TenantMembershipUserRefSchema)
			.output(ListTenantMembershipsResponseSchema),

		/**
		 * Remove a user from a Descope tenant and delete the matching D1 member
		 * row. Cross-org, platform-admin only. Destructive; audited.
		 * DELETE /tenant-membership
		 */
		remove: oc
			.route({
				method: "DELETE",
				path: "" as `/${string}`,
				summary: "Remove a user from a tenant",
				description:
					"Remove a user (by userId or loginId) from a Descope tenant AND delete the corresponding D1 organization_members row. Cross-org platform-admin operation — does not require the caller to belong to the target tenant. Destructive; audited.",
			})
			.input(RemoveTenantMembershipInputSchema)
			.output(RemoveTenantMembershipResponseSchema),
	});
