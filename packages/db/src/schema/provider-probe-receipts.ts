import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

/** One-use, short-lived authority; no provider credential or arguments are stored. */
export const providerProbeReceipts = sqliteTable(
	"provider_probe_receipts",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		actorUserId: text("actor_user_id").notNull(),
		profileId: text("profile_id").notNull(),
		profileDigest: text("profile_digest").notNull(),
		argsDigest: text("args_digest").notNull(),
		expiresAt: text("expires_at").notNull(),
	},
	(table) => [
		index("provider_probe_receipts_org_idx").on(
			table.organizationId,
			table.expiresAt,
		),
	],
);

/** Successful probe result for one owner and one exact reviewed profile/call. */
export const providerProbeResults = sqliteTable(
	"provider_probe_results",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		actorUserId: text("actor_user_id").notNull(),
		profileId: text("profile_id").notNull(),
		profileDigest: text("profile_digest").notNull(),
		argsDigest: text("args_digest").notNull(),
		accountRevisionDigest: text("account_revision_digest").notNull(),
		expiresAt: text("expires_at").notNull(),
	},
	(table) => [
		index("provider_probe_results_org_idx").on(
			table.organizationId,
			table.expiresAt,
		),
	],
);

/** A machine's short-lived, owner-reviewable proof; contains no credential. */
export const machineProviderProbeResults = sqliteTable(
	"machine_provider_probe_results",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		principalId: text("principal_id").notNull(),
		sessionId: text("session_id").notNull(),
		clientRecordId: text("client_record_id").notNull(),
		clientId: text("client_id").notNull(),
		mcpServerId: text("mcp_server_id").notNull(),
		profileId: text("profile_id").notNull(),
		profileDigest: text("profile_digest").notNull(),
		argsDigest: text("args_digest").notNull(),
		accountRevisionDigest: text("account_revision_digest").notNull(),
		expiresAt: text("expires_at").notNull(),
	},
	(table) => [
		index("machine_provider_probe_results_org_idx").on(
			table.organizationId,
			table.expiresAt,
		),
	],
);

/** One-use authority for a gateway to run a machine-initiated probe. */
export const machineProviderProbeAuthorizations = sqliteTable(
	"machine_provider_probe_authorizations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		principalId: text("principal_id").notNull(),
		sessionId: text("session_id").notNull(),
		clientRecordId: text("client_record_id").notNull(),
		clientId: text("client_id").notNull(),
		mcpServerId: text("mcp_server_id").notNull(),
		profileId: text("profile_id").notNull(),
		profileDigest: text("profile_digest").notNull(),
		argsDigest: text("args_digest").notNull(),
		expiresAt: text("expires_at").notNull(),
	},
);
