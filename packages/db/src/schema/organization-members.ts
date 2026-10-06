/**
 * Organization Members Schema
 * Team membership with RBAC for multi-tenant architecture
 *
 * Canonical Tedix users join through userId. The Descope subject remains for
 * invitation and provider-administration compatibility during migration.
 */

import type { OrganizationPermission } from "@tedix/api-contract/schemas/user-settings";
import { sql } from "drizzle-orm";
import {
	index,
	sqliteTable,
	text,
	unique,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

// ============================================================================
// Organization Members Table
// ============================================================================

export const organizationMembers = sqliteTable(
	"organization_members",
	{
		id: text("id").primaryKey(),

		// Organization reference (foreign key with cascade delete)
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),

		// Canonical Tedix user id. Provider subjects remain on the adapter field
		// below only while invitations and Descope administration still need them.
		userId: text("user_id"),

		// Descope user reference
		// Users are managed in Descope - this links to their external ID
		descopeUserId: text("descope_user_id").notNull(),

		// Denormalized user info (for quick access without Descope API calls)
		// Updated via webhook or on-demand sync
		email: text("email").notNull(),
		name: text("name"),
		avatarUrl: text("avatar_url"),

		// RBAC Role
		// Determines what actions this member can perform
		role: text("role", {
			enum: ["owner", "admin", "member", "viewer"],
		})
			.notNull()
			.default("member"),

		// Custom permission overrides (JSON). Canonical RBAC vocabulary lives in
		// `@tedix/auth/rbac` (`Permission`), mirrored on the wire by
		// `OrganizationPermission` in `@tedix/api-contract`. An override is a list
		// of those permission grants layered on top of the member's role.
		customPermissions: text("custom_permissions", {
			mode: "json",
		}).$type<OrganizationPermission[]>(),

		// Status
		status: text("status", {
			enum: ["active", "invited", "deactivated"],
		}).default("active"),

		// Invitation tracking
		invitedAt: text("invited_at"),
		inviteAcceptedAt: text("invite_accepted_at"),
		invitedBy: text("invited_by"), // descopeUserId of the inviter

		// Last activity tracking
		lastActiveAt: text("last_active_at"),

		// Timestamps
		createdAt: text("created_at").default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		// Unique constraint: one membership per user per organization
		unique("uniq_org_member").on(table.organizationId, table.descopeUserId),
		// Indexes for common queries
		index("idx_org_members_org").on(table.organizationId),
		uniqueIndex("uniq_org_member_user")
			.on(table.organizationId, table.userId)
			.where(sql`${table.userId} IS NOT NULL`),
		index("idx_org_members_canonical_user").on(table.userId),
		index("idx_org_members_user").on(table.descopeUserId),
		index("idx_org_members_email").on(table.email),
		index("idx_org_members_status").on(table.status),
		index("idx_org_members_role").on(table.role),
	],
);

// ============================================================================
// Inferred Types
// ============================================================================

export type OrganizationMember = typeof organizationMembers.$inferSelect;
export type NewOrganizationMember = typeof organizationMembers.$inferInsert;

// ============================================================================
// Enum Types
// ============================================================================

export type MemberRole = "owner" | "admin" | "member" | "viewer";
export const MEMBER_ROLE_VALUES = [
	"owner",
	"admin",
	"member",
	"viewer",
] as const;

export type MemberStatus = "active" | "invited" | "deactivated";
export const MEMBER_STATUS_VALUES = [
	"active",
	"invited",
	"deactivated",
] as const;
