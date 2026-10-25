import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

/**
 * Workspace collaborators: people given direct access to a workspace they do
 * not own. User ids are Descope subjects, the same id space as
 * `os_workspaces.owner_user_id`. The owner is never stored here; it is the
 * implicit root of the permission graph.
 *
 * Nothing stores an effective role. Access is recomputed from the edges on
 * every open, so removing someone only severs the edges that grant them
 * access; rows that became unreachable stay, which makes re-adding an
 * intermediary restore everyone they had added.
 */
export const osWorkspaceCollaborators = sqliteTable(
	"os_workspace_collaborators",
	{
		id: text("id").primaryKey(),
		/** The workspace's organization, not the collaborator's. */
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").notNull(),
		userId: text("user_id").notNull(),
		email: text("email"),
		name: text("name"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		/** Set on the first successful open; the workspace then lists for them. */
		firstOpenedAt: text("first_opened_at"),
		lastOpenedAt: text("last_opened_at"),
		/** Cached at open so the collaborator's list needs no cross-tenant read. */
		cachedTitle: text("cached_title"),
		cachedOwnerName: text("cached_owner_name"),
		/** Hidden from the collaborator's list; access is unchanged. */
		dismissedAt: text("dismissed_at"),
	},
	(table) => [
		uniqueIndex("os_workspace_collaborators_workspace_user_unique").on(
			table.workspaceId,
			table.userId,
		),
		index("os_workspace_collaborators_user_idx").on(table.userId),
	],
);

/**
 * How a collaborator got access. `edge_key` is `user:<sharer id>` or
 * `link:<link id>` so one sharer or link yields at most one edge per person.
 * A link edge carries no role; the link's role applies.
 */
export const osWorkspaceAccessEdges = sqliteTable(
	"os_workspace_access_edges",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").notNull(),
		targetUserId: text("target_user_id").notNull(),
		kind: text("kind", { enum: ["user", "link"] }).notNull(),
		edgeKey: text("edge_key").notNull(),
		sharerUserId: text("sharer_user_id"),
		linkId: text("link_id"),
		role: text("role", { enum: ["use", "build"] }),
		note: text("note"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
	},
	(table) => [
		uniqueIndex("os_workspace_access_edges_unique").on(
			table.workspaceId,
			table.targetUserId,
			table.edgeKey,
		),
	],
);

/**
 * A durable share link. It owns one or more keys; revoking sets
 * `revoked_at` and never deletes, so edges never dangle.
 */
export const osWorkspaceShareLinks = sqliteTable(
	"os_workspace_share_links",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		workspaceId: text("workspace_id").notNull(),
		creatorUserId: text("creator_user_id").notNull(),
		role: text("role", { enum: ["use", "build"] }).notNull(),
		label: text("label"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		revokedAt: text("revoked_at"),
	},
	(table) => [
		index("os_workspace_share_links_workspace_idx").on(table.workspaceId),
	],
);

/**
 * One row per minted key. Only the HMAC-SHA-256 of the random 128-bit key is
 * stored, so the database cannot reproduce a link and a leak exposes no
 * redeemable key.
 */
export const osWorkspaceShareKeys = sqliteTable(
	"os_workspace_share_keys",
	{
		keyHash: text("key_hash").primaryKey(),
		linkId: text("link_id")
			.notNull()
			.references(() => osWorkspaceShareLinks.id, { onDelete: "cascade" }),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
	},
	(table) => [index("os_workspace_share_keys_link_idx").on(table.linkId)],
);

export type OsWorkspaceCollaboratorRow =
	typeof osWorkspaceCollaborators.$inferSelect;
export type OsWorkspaceAccessEdgeRow =
	typeof osWorkspaceAccessEdges.$inferSelect;
export type OsWorkspaceShareLinkRow = typeof osWorkspaceShareLinks.$inferSelect;
