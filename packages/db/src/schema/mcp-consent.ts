import { sql } from "drizzle-orm";
import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * The latest Connect consent decision for one Descope user and OAuth client,
 * and the revocation fence for that key. A provider consent id is not a
 * selection revision: Descope may reuse it after reauthorization. Active
 * authority lives in `mcp_consent_grants`; revoking or disabling this row
 * removes every grant for the key in the same batch.
 */
export const mcpConsentSelections = sqliteTable(
	"mcp_consent_selections",
	{
		descopeUserId: text("descope_user_id").notNull(),
		mcpServerId: text("mcp_server_id").notNull(),
		clientId: text("client_id").notNull(),
		appId: text("app_id").notNull(),
		revision: text("revision").notNull(),
		status: text("status", { enum: ["active", "revoked"] }).notNull(),
		selectedTenantIds: text("selected_tenant_ids", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		approvedScopes: text("approved_scopes", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		primaryKey({
			columns: [table.descopeUserId, table.mcpServerId, table.clientId],
		}),
	],
);

export type McpConsentSelectionRow = typeof mcpConsentSelections.$inferSelect;
export type NewMcpConsentSelectionRow =
	typeof mcpConsentSelections.$inferInsert;

/**
 * Active consent revisions for one user, MCP server and OAuth client. Several
 * installs of one shared client (machines, CLI workspaces, agent hosts) each
 * hold their own revision with its own organizations and scopes. A row's
 * presence is the grant; revocation deletes it.
 */
export const mcpConsentGrants = sqliteTable(
	"mcp_consent_grants",
	{
		descopeUserId: text("descope_user_id").notNull(),
		mcpServerId: text("mcp_server_id").notNull(),
		clientId: text("client_id").notNull(),
		revision: text("revision").notNull(),
		appId: text("app_id").notNull(),
		selectedTenantIds: text("selected_tenant_ids", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		approvedScopes: text("approved_scopes", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		primaryKey({
			columns: [
				table.descopeUserId,
				table.mcpServerId,
				table.clientId,
				table.revision,
			],
		}),
	],
);
export type McpConsentGrantRow = typeof mcpConsentGrants.$inferSelect;

/** Immutable browser decisions; authority changes only after verified token use. */
export const mcpConsentPending = sqliteTable(
	"mcp_consent_pending",
	{
		descopeUserId: text("descope_user_id").notNull(),
		mcpServerId: text("mcp_server_id").notNull(),
		clientId: text("client_id").notNull(),
		appId: text("app_id").notNull(),
		revision: text("revision").notNull(),
		expectedActiveRevision: text("expected_active_revision"),
		selectedTenantIds: text("selected_tenant_ids", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		approvedScopes: text("approved_scopes", { mode: "json" })
			.$type<string[]>()
			.notNull(),
		expiresAt: text("expires_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		primaryKey({
			columns: [
				table.descopeUserId,
				table.mcpServerId,
				table.clientId,
				table.revision,
			],
		}),
	],
);
export type McpConsentPendingRow = typeof mcpConsentPending.$inferSelect;
export type NewMcpConsentPendingRow = typeof mcpConsentPending.$inferInsert;
