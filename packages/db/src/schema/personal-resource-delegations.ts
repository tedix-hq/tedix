import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Owner consent only. OAuth credentials remain in the canonical provider vault. */
export const personalResourceDelegations = sqliteTable(
	"personal_resource_delegations",
	{
		id: text("id").primaryKey().notNull(),
		organizationId: text("organization_id").notNull(),
		ownerUserId: text("owner_user_id").notNull(),
		tediId: text("tedi_id").notNull(),
		skillId: text("skill_id").notNull(),
		skillRevision: integer("skill_revision").notNull(),
		workspaceId: text("workspace_id").notNull(),
		resourceId: text("resource_id").notNull(),
		connectionInstanceId: text("connection_instance_id").notNull(),
		providerId: text("provider_id").notNull(),
		resourceType: text("resource_type").notNull(),
		providerResourceId: text("provider_resource_id").notNull(),
		accountSubject: text("account_subject").notNull(),
		grantFingerprint: text("grant_fingerprint").notNull(),
		requiredScopes: text("required_scopes", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		operations: text("operations", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		toolIds: text("tool_ids", { mode: "json" }).$type<string[]>().notNull(),
		createdAt: text("created_at").notNull(),
		expiresAt: text("expires_at").notNull(),
		revokedAt: text("revoked_at"),
	},
	(table) => [
		index("personal_resource_delegations_owner_org_idx").on(
			table.organizationId,
			table.ownerUserId,
		),
		index("personal_resource_delegations_tedi_idx").on(
			table.organizationId,
			table.tediId,
		),
	],
);
export type PersonalResourceDelegationRow =
	typeof personalResourceDelegations.$inferSelect;
export type NewPersonalResourceDelegationRow =
	typeof personalResourceDelegations.$inferInsert;
