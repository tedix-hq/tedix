import "@orpc/openapi/extensions/route";
/**
 * Members Contract for oRPC
 * Type-safe API contract for organization member management endpoints
 *
 * Implements dual-write pattern with Descope synchronization:
 * 1. Update Descope (source of truth for auth)
 * 2. Sync to D1 (for quick access and denormalized data)
 */

import { oc } from "@orpc/contract";
import * as z from "zod";
import {
	MemberIdParamSchema,
	OrgIdParamSchema,
	PaginationMetaSchema,
} from "../schemas/common";
import { OrganizationPermissionSchema } from "../schemas/user-settings";
import {
	MemberRoleSchema,
	MemberSchema,
	MemberStatusSchema,
} from "../schemas/organization";

/**
 * Members contract defining all organization member management endpoints
 *
 * All mutations require admin/owner role via requireRole() middleware
 */
export const membersContract = oc
	.route({ tags: ["members"], prefix: "/organizations" })
	.router({
		/**
		 * List all members for an organization
		 * GET /organizations/{organizationId}/members
		 */
		listMembers: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{organizationId}/members",
				summary: "List organization members",
				description:
					"List all members of an organization with pagination and filtering",
			})
			.input(
				OrgIdParamSchema.extend({
					limit: z.number().min(1).max(100).default(100),
					offset: z.number().min(0).default(0),
					status: MemberStatusSchema.optional(),
					role: MemberRoleSchema.optional(),
				}),
			)
			.output(
				z.object({
					data: z.array(MemberSchema),
					pagination: PaginationMetaSchema,
				}),
			),

		/**
		 * Get a specific member
		 * GET /organizations/{organizationId}/members/{memberId}
		 */
		getMember: oc
			.route({
				tags: ["REST"],
				method: "GET",
				path: "/{organizationId}/members/{memberId}",
				summary: "Get organization member by ID",
				description:
					"Get detailed information about a specific organization member",
			})
			.input(OrgIdParamSchema.extend(MemberIdParamSchema.shape))
			.output(
				z.object({
					data: MemberSchema,
				}),
			),

		/** Assignable tenant roles and their canonical permission grants. */
		listRoles: oc
			.route({
				method: "GET",
				path: "/{organizationId}/roles",
				summary: "List assignable organization roles",
				description:
					"List the roles a tenant operator may assign, with the permissions each role grants. Platform and machine roles are excluded.",
			})
			.input(OrgIdParamSchema.strict())
			.output(
				z.object({
					data: z.array(
						z.object({
							role: MemberRoleSchema,
							label: z.string(),
							description: z.string(),
							responsibility: z.string(),
							permissions: z.array(OrganizationPermissionSchema),
						}),
					),
				}),
			),

		/** Permissions that may be granted as additive member overrides. */
		listPermissions: oc
			.route({
				method: "GET",
				path: "/{organizationId}/permissions",
				summary: "List grantable organization permissions",
				description:
					"List the permissions a tenant operator may grant as member overrides. Platform-only permissions are excluded.",
			})
			.input(OrgIdParamSchema.strict())
			.output(
				z.object({
					data: z.array(
						z.object({
							permission: OrganizationPermissionSchema,
							label: z.string(),
							description: z.string(),
							group: z.string(),
						}),
					),
				}),
			),

		/** MCP capability grants shown on the tenant's Roles page. */
		listCapabilityScopes: oc
			.route({
				method: "GET",
				path: "/{organizationId}/capability-scopes",
				summary: "List MCP capability scopes",
				description:
					"List the exact MCP capability grants, their descriptions, and whether they are reserved for tenant administration.",
			})
			.input(OrgIdParamSchema.strict())
			.output(
				z.object({
					data: z.array(
						z.object({
							scope: z.string(),
							label: z.string(),
							description: z.string(),
							humanOnly: z.boolean(),
						}),
					),
				}),
			),

		/**
		 * Invite a new member to the organization
		 * POST /organizations/{organizationId}/members/invite
		 */
		inviteMember: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/{organizationId}/members/invite",
				summary: "Invite a new member to the organization",
				description:
					"Send an invitation to a new member (requires admin/owner role)",
				successStatus: 201,
			})
			.input(
				OrgIdParamSchema.extend({
					email: z.email({ message: "Invalid email address" }),
					role: MemberRoleSchema.default("member"),
				}),
			)
			.output(
				z.object({
					data: MemberSchema,
				}),
			),

		/**
		 * Update a member's role
		 * PATCH /organizations/{organizationId}/members/{memberId}/role
		 */
		updateMemberRole: oc
			.route({
				tags: ["REST"],
				method: "PATCH",
				path: "/{organizationId}/members/{memberId}/role",
				summary: "Update a member's role",
				description:
					"Change the role of an organization member (requires admin/owner role)",
			})
			.input(
				OrgIdParamSchema.extend({
					...MemberIdParamSchema.shape,
					role: MemberRoleSchema,
				}),
			)
			.output(
				z.object({
					data: MemberSchema,
				}),
			),

		/**
		 * Replace a member's additive permission overrides
		 * PUT /organizations/{organizationId}/members/{memberId}/permissions
		 */
		setMemberPermissions: oc
			.route({
				tags: ["REST"],
				method: "PUT",
				path: "/{organizationId}/members/{memberId}/permissions",
				summary: "Set a member's permission overrides",
				description:
					"Replace the additive permission grants layered on a member's role. Send the complete desired list; an empty array clears every override. Only permissions the owner role itself holds may be granted, so platform authority can never be delegated here.",
			})
			.input(
				OrgIdParamSchema.extend({
					...MemberIdParamSchema.shape,
					permissions: z.array(OrganizationPermissionSchema),
				}),
			)
			.output(
				z.object({
					data: MemberSchema,
				}),
			),

		/**
		 * Remove a member from the organization
		 * DELETE /organizations/{organizationId}/members/{memberId}
		 */
		removeMember: oc
			.route({
				tags: ["REST"],
				method: "DELETE",
				path: "/{organizationId}/members/{memberId}",
				summary: "Remove a member from the organization",
				description:
					"Remove an organization member (requires admin/owner role, cannot remove owner)",
				successStatus: 200,
			})
			.input(OrgIdParamSchema.extend(MemberIdParamSchema.shape))
			.output(
				z.object({
					success: z.boolean(),
					message: z.string(),
				}),
			),

		/**
		 * Accept a pending invitation
		 * POST /organizations/invitations/{memberId}/accept
		 */
		acceptInvitation: oc
			.route({
				tags: ["REST"],
				method: "POST",
				path: "/invitations/{memberId}/accept",
				summary: "Accept a pending invitation",
				description: "Accept a pending member invitation and link user account",
			})
			.input(
				MemberIdParamSchema.extend({
					descopeUserId: z.string().min(1, "Descope user ID required"),
					name: z.string().optional(),
					avatarUrl: z.url().optional(),
				}),
			)
			.output(
				z.object({
					data: MemberSchema,
				}),
			),
	});

export type MembersContract = typeof membersContract;
