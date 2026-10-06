import { sql } from "drizzle-orm";
import { index, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";

/**
 * Tedix OS governed share links. The 256-bit token is shown exactly
 * once at creation; only its
 * sha-256 hex hash persists here, so a leaked database row cannot be replayed
 * as a link. `resource_type`/`resource_id` are deliberately generic (plain
 * text, no FK — redemption re-resolves the resource org-scoped through the
 * query layer). Revision pins are likewise immutable identifiers without FKs
 * so share audit evidence survives resource cleanup.
 */

const createdByKinds = ["user", "tedi", "external_agent", "service"] as const;

export const osShareLinks = sqliteTable(
	"os_share_links",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		resourceType: text("resource_type", {
			enum: ["output", "gadget", "workspace"],
		}).notNull(),
		resourceId: text("resource_id").notNull(),
		/** sha-256 hex of the one-time plaintext token; the plaintext is never stored. */
		tokenHash: text("token_hash").notNull(),
		role: text("role", { enum: ["viewer", "use", "build"] })
			.notNull()
			.default("viewer"),
		/** Living links resolve current truth; pinned links resolve this immutable revision. */
		revisionMode: text("revision_mode", { enum: ["living", "pinned"] })
			.notNull()
			.default("living"),
		pinnedRevisionId: text("pinned_revision_id"),
		/** JSON safe snapshot used only by pinned workspace links. */
		pinnedSnapshot: text("pinned_snapshot"),
		note: text("note"),
		/** Monotonic policy ceiling: once set, it can stay or tighten, never clear/widen. */
		policyMaxRole: text("policy_max_role", {
			enum: ["viewer", "use", "build"],
		}),
		policyReason: text("policy_reason"),
		policyRestrictedAt: text("policy_restricted_at"),
		createdByKind: text("created_by_kind", { enum: createdByKinds }).notNull(),
		createdById: text("created_by_id").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		/** Optional ISO-8601 expiry; null links never expire. */
		expiresAt: text("expires_at"),
		/** Set when the link was revoked; a revoked link never redeems again. */
		revokedAt: text("revoked_at"),
	},
	(table) => [
		index("os_share_links_org_resource_idx").on(
			table.organizationId,
			table.resourceId,
		),
		uniqueIndex("os_share_links_token_hash_unique").on(table.tokenHash),
	],
);

/**
 * Ephemeral redemption sessions. Both the link secret and the session secret
 * are hash-only at rest. Revocation stamps every live session in the same D1
 * batch as the link, so a viewer's next read is denied even if it already
 * removed the link secret from its address bar.
 */
export const osShareSessions = sqliteTable(
	"os_share_sessions",
	{
		id: text("id").primaryKey(),
		shareLinkId: text("share_link_id")
			.notNull()
			.references(() => osShareLinks.id, { onDelete: "cascade" }),
		sessionTokenHash: text("session_token_hash").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		lastSeenAt: text("last_seen_at")
			.notNull()
			.default(sql`(datetime('now'))`),
		expiresAt: text("expires_at").notNull(),
		revokedAt: text("revoked_at"),
	},
	(table) => [
		index("os_share_sessions_link_idx").on(table.shareLinkId),
		uniqueIndex("os_share_sessions_token_hash_unique").on(
			table.sessionTokenHash,
		),
	],
);

export type OsShareLinkRow = typeof osShareLinks.$inferSelect;
export type NewOsShareLinkRow = typeof osShareLinks.$inferInsert;
export type OsShareSessionRow = typeof osShareSessions.$inferSelect;
export type NewOsShareSessionRow = typeof osShareSessions.$inferInsert;
