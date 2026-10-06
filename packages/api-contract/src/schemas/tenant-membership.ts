/**
 * Tenant Membership Schemas for oRPC
 *
 * Platform-admin, cross-org management of a user's Descope tenant memberships
 * and the corresponding D1 `organization_members` rows. Fills the gap left by
 * the org-injected `members.*` tools, which can only act on the caller's own
 * org and therefore cannot remove a user from an arbitrary tenant.
 *
 * Identifiers: `descopeTenantId` is the opaque Descope tenant id
 * (`org_<uuid>` / `personal_<userId>` / bare id like `T3D...`), which is what
 * the Descope `removeTenant` call requires — not a slug.
 */

import * as z from "zod";

/** Reference a Descope user by userId or loginId. Handler requires one. */
const TenantMembershipUserRefShape = {
	userId: z
		.string()
		.min(1)
		.optional()
		.describe("Descope user ID. Provide this or loginId."),
	loginId: z
		.string()
		.min(1)
		.optional()
		.describe("Descope login ID / email. Provide this or userId."),
};

export const TenantMembershipUserRefSchema = z
	.object(TenantMembershipUserRefShape)
	.refine((reference) => Boolean(reference.userId || reference.loginId), {
		message: "Provide userId or loginId to identify the user",
		path: ["userId"],
	});
export type TenantMembershipUserRef = z.infer<
	typeof TenantMembershipUserRefSchema
>;

/** One tenant membership, enriched with its Tedix org + D1 presence. */
export const TenantMembershipSchema = z.object({
	descopeTenantId: z.string(),
	roles: z.array(z.string()),
	organizationId: z
		.string()
		.nullable()
		.describe("Tedix D1 organization UUID, if the tenant maps to one"),
	organizationSlug: z
		.string()
		.nullable()
		.describe(
			"Tedix organization slug, or null for an unmapped Descope tenant",
		),
	organizationName: z
		.string()
		.nullable()
		.describe(
			"Tedix organization name, or null for an unmapped Descope tenant",
		),
	hasD1MemberRow: z
		.boolean()
		.describe("Whether a D1 organization_members row exists for this user+org"),
});
export type TenantMembership = z.infer<typeof TenantMembershipSchema>;

export const ListTenantMembershipsResponseSchema = z.object({
	userId: z.string(),
	loginId: z
		.string()
		.nullable()
		.describe("Primary Descope login ID, or null when the user has none"),
	memberships: z.array(TenantMembershipSchema),
});
export type ListTenantMembershipsResponse = z.infer<
	typeof ListTenantMembershipsResponseSchema
>;

export const RemoveTenantMembershipInputSchema = z
	.object({
		...TenantMembershipUserRefShape,
		descopeTenantId: z
			.string()
			.min(1)
			.describe("Opaque Descope tenant id to remove the user from"),
		reason: z
			.string()
			.max(500)
			.optional()
			.describe("Optional note recorded in the audit trail."),
	})
	.refine((reference) => Boolean(reference.userId || reference.loginId), {
		message: "Provide userId or loginId to identify the user",
		path: ["userId"],
	});
export type RemoveTenantMembershipInput = z.infer<
	typeof RemoveTenantMembershipInputSchema
>;

export const RemoveTenantMembershipResponseSchema = z.object({
	userId: z.string(),
	loginId: z.string(),
	descopeTenantId: z.string(),
	removedFromDescope: z
		.boolean()
		.describe("Descope tenant membership was removed"),
	removedD1Row: z
		.boolean()
		.describe(
			"A D1 organization_members row was deleted (false if none existed)",
		),
	remainingTenantCount: z
		.number()
		.describe("Descope tenant memberships remaining after removal"),
});
export type RemoveTenantMembershipResponse = z.infer<
	typeof RemoveTenantMembershipResponseSchema
>;
