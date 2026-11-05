import type { OrganizationPermission } from "@tedix/api-contract/schemas/user-settings";
import { sql } from "drizzle-orm";
import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
	OrganizationFeatures,
	OrganizationMetadata,
} from "../../schema/organizations";

export const organizations = pgTable(
	"organizations",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		type: text("type").notNull().default("organization"),
		descopeTenantId: text("descope_tenant_id"),
		logoUrl: text("logo_url"),
		description: text("description"),
		appsCount: integer("apps_count").default(0),
		features: jsonb("features").$type<OrganizationFeatures>(),
		metadata: jsonb("metadata").$type<OrganizationMetadata>(),
		createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP::text`),
		updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP::text`),
	},
	(table) => [
		uniqueIndex("organizations_slug_unique").on(table.slug),
		uniqueIndex("organizations_descope_tenant_id_unique")
			.on(table.descopeTenantId)
			.where(sql`${table.descopeTenantId} IS NOT NULL`),
		index("idx_org_slug").on(table.slug),
		index("idx_org_descope").on(table.descopeTenantId),
		index("organizations_type_idx").on(table.type),
	],
);

export const organizationMembers = pgTable(
	"organization_members",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		userId: text("user_id"),
		descopeUserId: text("descope_user_id").notNull(),
		email: text("email").notNull(),
		name: text("name"),
		avatarUrl: text("avatar_url"),
		kind: text("kind").notNull().default("human"),
		representedUserId: text("represented_user_id"),
		role: text("role").notNull().default("member"),
		customPermissions:
			jsonb("custom_permissions").$type<OrganizationPermission[]>(),
		status: text("status").default("active"),
		invitedAt: text("invited_at"),
		inviteAcceptedAt: text("invite_accepted_at"),
		invitedBy: text("invited_by"),
		lastActiveAt: text("last_active_at"),
		createdAt: text("created_at").default(sql`CURRENT_TIMESTAMP::text`),
		updatedAt: text("updated_at").default(sql`CURRENT_TIMESTAMP::text`),
	},
	(table) => [
		uniqueIndex("uniq_org_member").on(
			table.organizationId,
			table.descopeUserId,
		),
		uniqueIndex("uniq_org_member_user")
			.on(table.organizationId, table.userId)
			.where(sql`${table.userId} IS NOT NULL`),
		index("idx_org_members_org").on(table.organizationId),
		index("idx_org_members_canonical_user").on(table.userId),
		index("idx_org_members_user").on(table.descopeUserId),
		index("idx_org_members_email").on(table.email),
		index("idx_org_members_status").on(table.status),
		index("idx_org_members_role").on(table.role),
	],
);

export type PgOrganization = typeof organizations.$inferSelect;
export type NewPgOrganization = typeof organizations.$inferInsert;
export type PgOrganizationMember = typeof organizationMembers.$inferSelect;
export type NewPgOrganizationMember = typeof organizationMembers.$inferInsert;
