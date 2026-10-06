import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Non-secret account slots. Descope remains the credential store. */
export const connectionInstances = sqliteTable(
	"connection_instances",
	{
		id: text("id").primaryKey(),
		ownerUserId: text("owner_user_id").notNull(),
		organizationId: text("organization_id"),
		providerId: text("provider_id").notNull(),
		label: text("label").notNull(),
		tokenIds: text("token_ids", { mode: "json" }).$type<string[]>().notNull(),
		tokenSub: text("token_sub"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		index("connection_instances_org_provider_idx").on(
			table.organizationId,
			table.providerId,
		),
		index("connection_instances_owner_provider_idx").on(
			table.ownerUserId,
			table.providerId,
		),
	],
);

export type ConnectionInstanceRow = typeof connectionInstances.$inferSelect;
